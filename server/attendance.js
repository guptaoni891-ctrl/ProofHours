// ProofHours attendance service (V2): shifts, rotating QR check-in/out, supervisor approval (Stage 2), opt-in leagues (Stage 4).
// Off-chain only. It holds no keys and never writes to the chain: hours reach the ledger only when a coordinator
// signs issueBatch in their own wallet. A QR scan or a location reading alone can never count as completed service.
// Stores wallet addresses, times and yes/no "at the site" flags; never names, emails or coordinates.
"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { performance } = require("node:perf_hooks");
const { ethers } = require("ethers");
const { derive, mac, safeEq, sessionKeys, issue, verify } = require("./session");
const { trustRoutes } = require("./trust");
const { createOps } = require("./ops");

const QR_WINDOW = 30; // seconds per rotating QR code; a code is accepted in its own window and the next one
const SESSION_TTL = 2 * 3600;
const NONCE_TTL = 300;
const VOUCHER_DAYS = 7; // offline vouchers can be redeemed for a week after the shift
const EARLY_CHECKIN = 30 * 60; // check-in opens 30 minutes before the shift
const LATE_CHECKOUT = 2 * 3600; // check-out stays open 2 hours after the shift ends
const MAX_LEAGUE = 5000; // league members; each costs chain reads once per snapshot
const LEAGUE_TTL = 60; // seconds a league snapshot is reused
const FAR = 1e13; // "still open" end time for overlap checks
const MAX_BATCH = 25; // ~492k gas per volunteer when two badges mint (test/v2/ProofHoursV2.limits.t.sol): 25 fit the 16.7M per-transaction cap (EIP-7825)

const LEDGER_ABI = [
  "function coordinatorOrg(address) view returns (uint256)",
  "function optedIn(address) view returns (bool)",
  "function getOrg(uint256) view returns (tuple(string name, address admin, bool suspended, uint32 dailyIssueCap))",
  "function getEvent(uint256) view returns (tuple(uint256 orgId, uint8 category, uint16 maxHours, uint32 serviceDay, address createdBy, string code))",
  "function hasRecord(uint256, address) view returns (bool)",
  "function dayHours(address, uint32) view returns (uint256)",
  "function orgDayIssued(uint256, uint32) view returns (uint256)",
  "function totalHours(address) view returns (uint256)",
  "function hasRole(bytes32, address) view returns (bool)",
  "function originalsOf(address, uint256, uint256) view returns (uint256[] ids, uint256 total)",
  "function headOf(uint256) view returns (tuple(uint256 id, uint256 eventId, address volunteer, uint16 hoursLogged, uint8 entryType, uint8 category, uint256 orgId, address issuer, uint64 recordedAt, uint32 serviceDay, uint256 replacesId, uint256 supersededBy, bytes32 evidenceHash, bytes32 reason, uint256 v1RecordId))",
  "event HoursIssued(uint256 indexed recordId, uint256 indexed eventId, address indexed volunteer, uint16 hoursLogged, uint8 category, bytes32 evidenceHash)",
];

// one query for a list of shifts with their attendance counts (instead of one count query per shift)
const SHIFTS_WITH_COUNTS = "SELECT s.*, COUNT(a.id) AS attending FROM shifts s LEFT JOIN attendance a ON a.shift_id = s.id AND a.status != 'rejected'";
const BANDS = [10, 50, 250, Infinity]; // lifetime verified hours: under 10, under 50, under 250, 250+
const BAND_NAMES = ["Newcomers (under 10h)", "Regulars (10–49h)", "Veterans (50–249h)", "Legends (250h+)"];
const ADJ = ["Amber", "Brisk", "Calm", "Bright", "Coral", "Swift", "Teal", "Golden", "Quiet", "Bold", "Sunny", "Misty"];
const ANIMAL = ["Heron", "Oryx", "Falcon", "Gazelle", "Turtle", "Dolphin", "Lynx", "Ibis", "Fox", "Owl", "Dugong", "Hoopoe"];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const flag = (v) => (v === null || v === undefined ? null : v === 1);

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS siwe_nonces (nonce TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, org_id INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
      capacity INTEGER NOT NULL, lat REAL, lng REAL, radius INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id), event_id INTEGER NOT NULL, volunteer TEXT NOT NULL,
      in_at INTEGER NOT NULL, in_site INTEGER, out_at INTEGER, out_site INTEGER,
      status TEXT NOT NULL CHECK (status IN ('checked_in','checked_out','approved','rejected','issued')),
      hours INTEGER, decided_by TEXT, decided_at INTEGER, reason TEXT, evidence TEXT, evidence_hash TEXT, record_id TEXT, tx_hash TEXT,
      UNIQUE (shift_id, volunteer));
    CREATE TABLE IF NOT EXISTS league (wallet TEXT PRIMARY KEY, alias TEXT NOT NULL, joined_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vouchers (code TEXT PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id), created_at INTEGER NOT NULL, redeemed_by TEXT, redeemed_at INTEGER);`);
  try { db.exec("ALTER TABLE attendance ADD COLUMN source TEXT NOT NULL DEFAULT 'qr'"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE shifts ADD COLUMN require_site INTEGER NOT NULL DEFAULT 0"); } catch { /* already there */ }
  db.exec("DROP TABLE IF EXISTS nonces"); // pre-SIWE sign-in nonces (bound to neither a wallet nor a domain)
  return db;
}

// Read-only view of the V2 ledger and badges. Event lookups return null for unknown events.
function ledgerChain(rpcUrl, ledger, chainId, badgesAddress, confirmations = 1) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const c = new ethers.Contract(ledger, LEDGER_ABI, provider);
  const b = badgesAddress && new ethers.Contract(badgesAddress, ["function ownerOf(uint256) view returns (address)", "function badges(uint256) view returns (uint8 kind, uint16 threshold, uint64 issuedAt)"], provider);
  return {
    badgesAddress,
    isAuditor: (a) => c.hasRole(ethers.id("AUDITOR_ROLE"), a),
    // held badge -> { owner, kind, threshold }; burned or never minted -> null
    badge: async (id) => {
      const owner = await b.ownerOf(id).catch((e) => { if (e.code === "CALL_EXCEPTION") return null; throw e; });
      if (!owner) return null;
      const x = await b.badges(id);
      return { owner, kind: Number(x.kind), threshold: Number(x.threshold) };
    },
    coordinatorOrg: async (a) => Number(await c.coordinatorOrg(a)),
    optedIn: (a) => c.optedIn(a),
    orgSuspended: async (id) => (await c.getOrg(id)).suspended,
    org: async (id) => { const o = await c.getOrg(id); return { suspended: o.suspended, dailyIssueCap: Number(o.dailyIssueCap) }; },
    // getEvent returns an all-zero struct for unknown ids (it never reverts): org 0 means "no such event"
    event: async (id) => {
      const e = await c.getFunction("getEvent")(id);
      return Number(e.orgId) === 0 ? null : { orgId: Number(e.orgId), category: Number(e.category), maxHours: Number(e.maxHours), serviceDay: Number(e.serviceDay), code: e.code };
    },
    hasRecord: (eventId, a) => c.hasRecord(eventId, a),
    dayHours: async (a, day) => Number(await c.dayHours(a, day)),
    orgDayIssued: async (orgId, day) => Number(await c.orgDayIssued(orgId, day)),
    totalHours: async (a) => Number(await c.totalHours(a)),
    // latest entry of every record the wallet holds (revoked = 0 hours); service day 0 = imported from V1
    // shortcut: first 500 records per wallet; page through originalsOf if anyone gets near that
    records: async (a) => {
      const [ids] = await c.originalsOf(a, 0, 500);
      return (await Promise.all(ids.map((id) => c.headOf(id)))).map((h) => ({ hours: Number(h.entryType) === 2 ? 0 : Number(h.hoursLogged), serviceDay: Number(h.serviceDay) }));
    },
    // HoursIssued logs of a mined transaction, or { pending: n } while it has fewer than `confirmations` confirmations
    issued: async (hash) => {
      const r = await provider.getTransactionReceipt(hash);
      if (!r || r.status !== 1) return [];
      const have = (await provider.getBlockNumber()) - r.blockNumber + 1;
      if (have < confirmations) return { pending: confirmations - have };
      return r.logs.filter((l) => l.address.toLowerCase() === ledger.toLowerCase()).map((l) => c.interface.parseLog(l))
        .filter((e) => e?.name === "HoursIssued")
        .map((e) => ({ recordId: String(e.args.recordId), eventId: Number(e.args.eventId), volunteer: e.args.volunteer, evidenceHash: e.args.evidenceHash }));
    },
  };
}

// Front-end origins allowed to ask for a sign-in message. Unset: local development origins only.
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

function createApp({ db, keysDb = new DatabaseSync(":memory:"), chain, secret, chainId, publicUrl = "http://127.0.0.1:8790", appOrigins = null, now = () => Date.now(), rateLimit = Infinity, log = false, trustProxy = false, metricsToken = null }) {
  if (!secret) throw new Error("createApp needs a secret");
  const ops = createOps({ service: "attendance", limit: rateLimit, log, now, trustProxy });
  // one subkey per purpose, so no key is ever used for two things
  const keys = { qr: derive(secret, "qr-hmac"), voucher: derive(secret, "voucher-hmac"), session: sessionKeys(secret) };
  const sessionPub = crypto.createPublicKey(keys.session.privateKey);
  const t = () => Math.floor(now() / 1000);
  const q = (sql) => db.prepare(sql);

  const address = (v) => { try { return ethers.getAddress(String(v)); } catch { return fail(400, "Not a wallet address."); } };
  const int = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  // EIP-4361 (Sign-In with Ethereum): the wallet shows the domain and warns when the page asking isn't that domain,
  // so a look-alike site can't relay a real sign-in message to a victim.
  const originOk = (o) => (appOrigins?.length ? appOrigins.includes(o) : DEV_ORIGIN.test(o));
  const signInMessage = (origin, a, nonce, issued, exp) => [
    `${new URL(origin).host} wants you to sign in with your Ethereum account:`, a, "",
    "Sign in to ProofHours attendance. Signing is free and sends no transaction.", "",
    `URI: ${origin}`, "Version: 1", `Chain ID: ${chainId}`, `Nonce: ${nonce}`,
    `Issued At: ${new Date(issued * 1000).toISOString()}`, `Expiration Time: ${new Date(exp * 1000).toISOString()}`,
  ].join("\n");

  function session(req) {
    const v = verify(sessionPub, req.headers.authorization, t());
    return v.address ?? fail(401, v.error);
  }

  async function coordinatorFor(me, orgId) {
    const org = await chain.coordinatorOrg(me);
    if (!org) fail(403, `${short(me)} is not a V2 coordinator.`);
    if (orgId !== undefined && org !== orgId) fail(403, "This shift belongs to another NGO.");
    if (await chain.orgSuspended(org)) fail(403, "Your NGO is suspended by an auditor.");
    return org;
  }
  async function event(id) { return (await chain.event(id)) ?? fail(404, `Event #${id} was not found on the ledger.`); }
  const shiftById = (id) => q("SELECT * FROM shifts WHERE id = ?").get(id) ?? fail(404, `Shift #${id} was not found.`);
  const attendanceById = (id) => q("SELECT * FROM attendance WHERE id = ?").get(id) ?? fail(404, `Attendance #${id} was not found.`);

  const shiftView = (s) => ({
    id: s.id, eventId: s.event_id, orgId: s.org_id, start: s.start_at, end: s.end_at, capacity: s.capacity,
    site: s.lat === null ? null : { lat: s.lat, lng: s.lng, radius: s.radius }, requireSite: !!s.require_site,
    attending: s.attending ?? q("SELECT COUNT(*) AS n FROM attendance WHERE shift_id = ? AND status != 'rejected'").get(s.id).n,
  });
  // Hours inside the shift window, whole hours rounded down, capped by the event's maximum.
  const hoursOf = (a, s, maxHours) => Math.min(maxHours, Math.floor(Math.max(0, Math.min(a.out_at, s.end_at) - Math.max(a.in_at, s.start_at)) / 3600));
  // Server-side site check: the device sends its position once; only the yes/no result is stored, never coordinates.
  // A GPS reading can still be faked; requireSite makes faking necessary instead of optional.
  const metres = (a, b) => {
    const r = Math.PI / 180, h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  function located(s, loc) {
    if (s.lat === null) return null;
    let at = null;
    if (loc != null) {
      const p = { lat: Number(loc.lat), lng: Number(loc.lng) }, acc = Number(loc.accuracy ?? 0);
      if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && acc >= 0)) fail(400, "The location reading is not valid.");
      at = metres(p, s) - Math.min(acc, 100) <= s.radius ? 1 : 0; // up to 100 m of reported GPS uncertainty gets the benefit of the doubt
    }
    if (s.require_site && at !== 1) fail(403, at === 0 ? "You don't seem to be at the site. This shift needs a location reading inside the site area." : "This shift needs your location to confirm you're at the site. Allow location and try again.");
    return at;
  }
  const attendanceView = (a, preview) => ({
    id: a.id, shiftId: a.shift_id, eventId: a.event_id, volunteer: a.volunteer, checkIn: a.in_at, checkOut: a.out_at,
    atSiteIn: flag(a.in_site), atSiteOut: flag(a.out_site), status: a.status, hours: a.hours ?? preview ?? null, source: a.source ?? "qr",
    decidedBy: a.decided_by, reason: a.reason, evidence: a.evidence, evidenceHash: a.evidence_hash, recordId: a.record_id, txHash: a.tx_hash,
  });

  const voucherMac = (shiftId, serial) => crypto.createHmac("sha256", keys.voucher).update(`voucher.${shiftId}.${serial}`).digest("hex").slice(0, 10).toUpperCase();
  function readQr(token, kind) {
    const [sid, k, win, sig] = String(token ?? "").split(".");
    if (!sig || !safeEq(sig, mac(keys.qr, `qr.${sid}.${k}.${win}`))) fail(400, "This QR code is not valid.");
    if (k !== kind) fail(400, kind === "in" ? "This is a check-out code. Scan the check-in code." : "This is a check-in code. Scan the check-out code.");
    const cur = Math.floor(t() / QR_WINDOW);
    if (Number(win) > cur || Number(win) < cur - 1) fail(400, "This QR code expired. Scan the code on the coordinator's screen now.");
    return shiftById(Number(sid));
  }

  const routes = {
    "GET /health": () => ({ ok: !!q("SELECT 1 AS x").get().x }),

    // Sign-in: the server issues a one-time nonce and the exact message; the wallet signs it (personal_sign).
    "GET /auth/public-key": () => ({ alg: "Ed25519", publicKey: keys.session.publicKey }), // SESSION_PUBLIC_KEY for the indexer
    // The nonce is bound to the wallet and to the exact message, which names the front end's domain.
    "POST /auth/nonce": ({ req, body }) => {
      const a = address(body.address), origin = req.headers.origin;
      if (origin !== undefined && !originOk(origin)) fail(403, "Sign-in is only available from the ProofHours app.");
      const site = origin ?? appOrigins?.[0] ?? publicUrl, nonce = crypto.randomBytes(16).toString("hex"), now = t();
      const message = signInMessage(site, a, nonce, now, now + NONCE_TTL);
      q("DELETE FROM siwe_nonces WHERE exp < ?").run(now);
      q("INSERT INTO siwe_nonces (nonce, address, message, exp) VALUES (?, ?, ?, ?)").run(nonce, a, message, now + NONCE_TTL);
      return { nonce, message };
    },
    "POST /auth": ({ body }) => {
      const a = address(body.address);
      const n = q("DELETE FROM siwe_nonces WHERE nonce = ? AND exp >= ? RETURNING address, message").get(String(body.nonce ?? ""), t());
      if (!n) fail(401, "This sign-in request expired or was already used. Try again.");
      if (n.address !== a) fail(401, "This sign-in request was made for another wallet.");
      let signer;
      try { signer = ethers.verifyMessage(n.message, String(body.signature)); } catch { fail(401, "The signature is not valid."); }
      if (signer !== a) fail(401, "The signature does not match this wallet.");
      const exp = t() + SESSION_TTL;
      return { token: issue(keys.session.privateKey, a, exp), address: a, expiresAt: exp };
    },

    "POST /shifts": async ({ req, body }) => {
      const me = session(req), eventId = int(body.eventId, "Event", 1, 2 ** 31);
      const ev = await event(eventId), org = await coordinatorFor(me, ev.orgId);
      const start = int(body.start, "Start", 1, 2 ** 40), end = int(body.end, "End", 1, 2 ** 40), capacity = int(body.capacity, "Capacity", 1, 1000);
      if (end <= start) fail(400, "The shift must end after it starts.");
      if (end - start > 24 * 3600) fail(400, "A shift can last at most 24 hours.");
      // the event's service date is a UTC day; ±1 day lets local-time shifts near midnight through
      if (Math.abs(Math.floor(start / 86400) - ev.serviceDay) > 1) fail(400, "The shift must take place on the event's service date.");
      let lat = null, lng = null, radius = null;
      if (body.site) {
        [lat, lng] = [Number(body.site.lat), Number(body.site.lng)];
        if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) fail(400, "The site location is not valid.");
        radius = int(body.site.radius, "Site radius (metres)", 20, 5000);
      }
      if (body.requireSite && lat === null) fail(400, "Requiring presence at the site needs a site area.");
      const { lastInsertRowid } = q("INSERT INTO shifts (event_id, org_id, start_at, end_at, capacity, lat, lng, radius, created_by, created_at, require_site) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(eventId, org, start, end, capacity, lat, lng, radius, me, t(), body.requireSite === true ? 1 : 0);
      return shiftView(shiftById(Number(lastInsertRowid)));
    },
    "GET /shifts": async ({ req }) => {
      const org = await coordinatorFor(session(req));
      return q(`${SHIFTS_WITH_COUNTS} WHERE s.org_id = ? GROUP BY s.id ORDER BY s.start_at DESC, s.id DESC`).all(org).map(shiftView);
    },
    "GET /shifts/:id": ({ id }) => shiftView(shiftById(id)), // public: event, times, capacity, site area; no attendee data
    // Public directory of shifts that haven't ended: times, capacity, spots taken. No attendee identities.
    "GET /opportunities": () => q(`${SHIFTS_WITH_COUNTS} WHERE s.end_at > ? GROUP BY s.id ORDER BY s.start_at, s.id LIMIT 200`).all(t()).map(shiftView),

    "GET /shifts/:id/qr": async ({ req, id, url }) => {
      const s = shiftById(id);
      await coordinatorFor(session(req), s.org_id);
      const kind = url.searchParams.get("kind") === "out" ? "out" : "in", win = Math.floor(t() / QR_WINDOW);
      return { token: `${s.id}.${kind}.${win}.${mac(keys.qr, `qr.${s.id}.${kind}.${win}`)}`, kind, now: t(), rotatesAt: (win + 1) * QR_WINDOW, expiresAt: (win + 2) * QR_WINDOW };
    },

    // Replay protection: a QR code is only valid ~30-60 s, and each wallet can check in and out of a shift once.
    "POST /checkin": async ({ req, body }) => {
      const me = session(req);
      readQr(body.token, "in");
      if (!(await chain.optedIn(me))) fail(403, "Opt in on your passport first, so NGOs can issue hours to this wallet.");
      const s = readQr(body.token, "in"), now = t(); // re-read after the await: no awaits between here and the insert
      if (now < s.start_at - EARLY_CHECKIN) fail(400, "Check-in opens 30 minutes before the shift starts.");
      if (now >= s.end_at) fail(400, "This shift has ended.");
      if (q("SELECT 1 FROM attendance WHERE shift_id = ? AND volunteer = ?").get(s.id, me)) fail(409, "You already checked in to this shift.");
      const open = q("SELECT shift_id FROM attendance WHERE volunteer = ? AND status = 'checked_in'").get(me);
      if (open) fail(409, `You are still checked in to shift #${open.shift_id}. Check out there first: attendance can't overlap.`);
      // closed attendance (e.g. a redeemed voucher) that still covers any of this shift from now on
      const clash = q("SELECT shift_id FROM attendance WHERE volunteer = ? AND status != 'rejected' AND in_at < ? AND COALESCE(out_at, ?) > ?").get(me, s.end_at, FAR, now);
      if (clash) fail(409, `This shift overlaps attendance you already have (shift #${clash.shift_id}).`);
      const same = q("SELECT shift_id FROM attendance WHERE volunteer = ? AND event_id = ? AND status != 'rejected'").get(me, s.event_id);
      if (same) fail(409, `You already have attendance for this event (shift #${same.shift_id}). The ledger holds one record per volunteer per event.`);
      if (q("SELECT COUNT(*) AS n FROM attendance WHERE shift_id = ? AND status != 'rejected'").get(s.id).n >= s.capacity) fail(409, "This shift is full.");
      const { lastInsertRowid } = q("INSERT INTO attendance (shift_id, event_id, volunteer, in_at, in_site, status) VALUES (?,?,?,?,?, 'checked_in')")
        .run(s.id, s.event_id, me, now, located(s, body.location));
      return attendanceView(attendanceById(Number(lastInsertRowid)));
    },
    "POST /checkout": ({ req, body }) => {
      const me = session(req), s = readQr(body.token, "out"), now = t();
      const a = q("SELECT * FROM attendance WHERE shift_id = ? AND volunteer = ?").get(s.id, me);
      if (!a) fail(409, "You have not checked in to this shift.");
      if (a.status !== "checked_in") fail(409, "You already checked out of this shift.");
      if (now > s.end_at + LATE_CHECKOUT) fail(400, "Check-out closed 2 hours after the shift ended. Ask the coordinator.");
      q("UPDATE attendance SET out_at = ?, out_site = ?, status = 'checked_out' WHERE id = ?").run(now, located(s, body.location), a.id);
      return attendanceView(attendanceById(a.id), hoursOf({ ...a, out_at: now }, s, 24));
    },
    // ---------- Leagues (opt-in). Members are shown by a generated alias, never by wallet, and only the 3 above and
    // 3 below you are returned. Seasons are calendar months (UTC); a season's score is verified hours served in it.
    "POST /league/join": async ({ req }) => {
      const me = session(req);
      if (!(await chain.optedIn(me))) fail(403, "Opt in on your passport first: leagues rank verified hours only.");
      const member = q("SELECT 1 FROM league WHERE wallet = ?").get(me);
      // a verified hour from an NGO is the entry ticket, so throwaway wallets can't flood the league
      if (!member && (await chain.totalHours(me)) < 1) fail(403, "Leagues open after your first verified hour from an NGO.");
      if (!member && q("SELECT COUNT(*) AS n FROM league").get().n >= MAX_LEAGUE) fail(503, "The league is full this season.");
      const alias = `${ADJ[crypto.randomInt(ADJ.length)]} ${ANIMAL[crypto.randomInt(ANIMAL.length)]} ${crypto.randomInt(10, 100)}`;
      if (q("INSERT OR IGNORE INTO league (wallet, alias, joined_at) VALUES (?, ?, ?)").run(me, alias, t()).changes) leagueSnap = null;
      return league(me);
    },
    "POST /league/leave": ({ req }) => {
      if (q("DELETE FROM league WHERE wallet = ?").run(session(req)).changes) leagueSnap = null; // removed from every ranking immediately
      return { joined: false };
    },
    "GET /league/me": ({ req }) => league(session(req)),

    // ---------- Offline vouchers (Stage 6): for sites without connectivity. The coordinator prints single-use codes
    // and hands one to each volunteer at the end of the shift; redeeming one later records attendance for the whole
    // shift, which the coordinator still has to approve. A code is tamper-evident (HMAC) and works once.
    "POST /shifts/:id/vouchers": async ({ req, id, body }) => {
      const s = shiftById(id);
      await coordinatorFor(session(req), s.org_id);
      const count = int(body.count ?? 20, "Count", 1, 200), ins = q("INSERT INTO vouchers (code, shift_id, created_at) VALUES (?, ?, ?)");
      const codes = Array.from({ length: count }, () => {
        const serial = crypto.randomBytes(4).toString("hex").toUpperCase(), code = `PH-${s.id}-${serial}-${voucherMac(s.id, serial)}`;
        ins.run(code, s.id, t());
        return code;
      });
      return { shiftId: s.id, codes, redeemUntil: s.end_at + VOUCHER_DAYS * 86400 };
    },
    "POST /vouchers/redeem": async ({ req, body }) => {
      const me = session(req), canonical = String(body.code ?? "").trim().toUpperCase(); // hex only, so typing case doesn't matter
      const m = /^PH-(\d+)-([0-9A-F]{8})-([0-9A-F]{10})$/.exec(canonical);
      if (!m || !safeEq(m[3], voucherMac(m[1], m[2]))) fail(400, "This voucher code is not valid. Check it for typos.");
      if (!(await chain.optedIn(me))) fail(403, "Opt in on your passport first, so NGOs can issue hours to this wallet.");
      const v = q("SELECT * FROM vouchers WHERE code = ?").get(canonical) ?? fail(404, "This voucher was not issued.");
      if (v.redeemed_by) fail(409, "This voucher has already been used.");
      const s = shiftById(v.shift_id), now = t();
      if (now < s.end_at - EARLY_CHECKIN) fail(400, "Vouchers can be redeemed from 30 minutes before the shift ends.");
      if (now > s.end_at + VOUCHER_DAYS * 86400) fail(400, `This voucher expired ${VOUCHER_DAYS} days after the shift.`);
      if (q("SELECT 1 FROM attendance WHERE shift_id = ? AND volunteer = ?").get(s.id, me)) fail(409, "You already have attendance for this shift.");
      const same = q("SELECT shift_id FROM attendance WHERE volunteer = ? AND event_id = ? AND status != 'rejected'").get(me, s.event_id);
      if (same) fail(409, `You already have attendance for this event (shift #${same.shift_id}). The ledger holds one record per volunteer per event.`);
      // an open check-in counts as running until it is closed
      const overlap = q("SELECT shift_id FROM attendance WHERE volunteer = ? AND status != 'rejected' AND in_at < ? AND COALESCE(out_at, ?) > ?").get(me, s.end_at, FAR, s.start_at);
      if (overlap) fail(409, `This shift overlaps attendance you already have (shift #${overlap.shift_id}).`);
      if (q("SELECT COUNT(*) AS n FROM attendance WHERE shift_id = ? AND status != 'rejected'").get(s.id).n >= s.capacity) fail(409, "This shift is full.");
      if (q("UPDATE vouchers SET redeemed_by = ?, redeemed_at = ? WHERE code = ? AND redeemed_by IS NULL").run(me, now, canonical).changes !== 1) fail(409, "This voucher has already been used.");
      const { lastInsertRowid } = q("INSERT INTO attendance (shift_id, event_id, volunteer, in_at, out_at, status, source) VALUES (?, ?, ?, ?, ?, 'checked_out', 'voucher')")
        .run(s.id, s.event_id, me, s.start_at, s.end_at);
      return attendanceView(attendanceById(Number(lastInsertRowid)), hoursOf({ in_at: s.start_at, out_at: s.end_at }, s, 24));
    },

    "GET /me/attendance": ({ req }) =>
      q("SELECT * FROM attendance WHERE volunteer = ? ORDER BY in_at DESC").all(session(req)).map((a) => attendanceView(a)),

    "GET /shifts/:id/attendance": async ({ req, id }) => {
      const s = shiftById(id);
      await coordinatorFor(session(req), s.org_id); // authorise before any further chain reads
      const ev = await event(s.event_id);
      return q("SELECT * FROM attendance WHERE shift_id = ? ORDER BY in_at").all(id)
        .map((a) => attendanceView(a, a.status === "checked_out" ? hoursOf(a, s, ev.maxHours) : undefined));
    },
    "POST /attendance/:id/approve": async ({ req, id }) => {
      const me = session(req), s = shiftById(attendanceById(id).shift_id);
      await coordinatorFor(me, s.org_id);
      const ev = await event(s.event_id);
      const a = attendanceById(id); // re-read after the awaits
      if (a.status !== "checked_out") fail(409, a.status === "checked_in" ? "The volunteer has not checked out yet." : `This attendance is already ${a.status}.`);
      const hours = hoursOf(a, s, ev.maxHours);
      if (hours < 1) fail(409, "Less than one full hour inside the shift, so there is nothing to approve. Reject it instead.");
      // The salt stops anyone guessing the times from the public evidence hash.
      const evidence = JSON.stringify({
        v: 1, kind: "proofhours-attendance", shiftId: s.id, eventId: s.event_id, volunteer: a.volunteer, shiftStart: s.start_at, shiftEnd: s.end_at,
        checkIn: a.in_at, checkOut: a.out_at, atSiteIn: flag(a.in_site), atSiteOut: flag(a.out_site), source: a.source ?? "qr", hours, approvedBy: me, approvedAt: t(),
        salt: crypto.randomBytes(16).toString("hex"),
      });
      q("UPDATE attendance SET status = 'approved', hours = ?, decided_by = ?, decided_at = ?, evidence = ?, evidence_hash = ? WHERE id = ?")
        .run(hours, me, t(), evidence, ethers.id(evidence), id);
      return attendanceView(attendanceById(id));
    },
    "POST /attendance/:id/reject": async ({ req, id, body }) => {
      const me = session(req), s = shiftById(attendanceById(id).shift_id);
      await coordinatorFor(me, s.org_id);
      const reason = String(body.reason ?? "").trim().slice(0, 100);
      if (!reason) fail(400, "Give a reason for the rejection.");
      const a = attendanceById(id);
      // approved rows can still be rejected until they are issued, so one bad row can't block a shift's batch forever
      if (!["checked_in", "checked_out", "approved"].includes(a.status)) fail(409, `This attendance is already ${a.status}.`);
      q("UPDATE attendance SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ?").run(me, t(), reason, id);
      return attendanceView(attendanceById(id));
    },

    // What the coordinator's wallet should send: issueBatch(eventId, volunteers, hours, evidence).
    // issueBatch is all-or-nothing, so every line is checked against the chain first; lines that would revert are
    // reported in `blocked` (with the reason) instead of being sent.
    "GET /shifts/:id/issuable": async ({ req, id }) => {
      const s = shiftById(id), org = await coordinatorFor(session(req), s.org_id), ev = await event(s.event_id), today = Math.floor(t() / 86400);
      const all = q("SELECT * FROM attendance WHERE shift_id = ? AND status = 'approved' ORDER BY id").all(id), rows = [], blocked = [];
      if (ev.serviceDay > today) return { eventId: s.event_id, attendanceIds: [], volunteers: [], hours: [], evidence: [], remaining: all.length, blocked: [], notBefore: ev.serviceDay * 86400 };
      const cap = ev.category === 3 ? 24 : 12; // ProofHoursLedger DAILY_CAP / EMERGENCY_DAILY_CAP
      const [o, issuedToday] = await Promise.all([chain.org(org), chain.orgDayIssued(org, today)]);
      let orgLeft = o.dailyIssueCap - issuedToday, i = 0;
      for (; i < all.length && rows.length < MAX_BATCH; i++) {
        const r = all[i], [opted, has, day] = await Promise.all([chain.optedIn(r.volunteer), chain.hasRecord(s.event_id, r.volunteer), chain.dayHours(r.volunteer, ev.serviceDay)]);
        const reason = !opted ? "The volunteer opted out, so the ledger refuses new hours for this wallet. Reject this attendance."
          : has ? "The volunteer already has a ledger record for this event. Reject this attendance."
          : day + r.hours > cap ? `This would take the volunteer past ${cap}h on the service day (${day}h already recorded). Reject it, or correct the other record first.`
          : r.hours > orgLeft ? "Your NGO's daily issuance cap is used up. Issue this one tomorrow." : null;
        if (reason) { blocked.push({ attendanceId: r.id, volunteer: r.volunteer, hours: r.hours, reason }); continue; }
        orgLeft -= r.hours;
        rows.push(r);
      }
      return { eventId: s.event_id, attendanceIds: rows.map((r) => r.id), volunteers: rows.map((r) => r.volunteer), hours: rows.map((r) => r.hours), evidence: rows.map((r) => r.evidence_hash), remaining: all.length - i, blocked };
    },
    // Marks attendance as issued only when the chain shows a matching HoursIssued log (event, wallet and evidence hash).
    "POST /shifts/:id/issued": async ({ req, id, body }) => {
      const s = shiftById(id);
      await coordinatorFor(session(req), s.org_id);
      if (!ethers.isHexString(body.txHash, 32)) fail(400, "Not a transaction hash.");
      const logs = await chain.issued(body.txHash);
      if (logs.pending) fail(409, `The transaction needs ${logs.pending} more confirmation(s) before attendance is marked issued. Try again shortly.`);
      let marked = 0;
      for (const a of q("SELECT * FROM attendance WHERE shift_id = ? AND status = 'approved'").all(id)) {
        const log = logs.find((l) => l.eventId === s.event_id && l.volunteer === a.volunteer && l.evidenceHash === a.evidence_hash);
        if (!log) continue;
        q("UPDATE attendance SET status = 'issued', record_id = ?, tx_hash = ? WHERE id = ?").run(log.recordId, body.txHash, a.id);
        marked++;
      }
      return { marked };
    },
  };

  // Cohorts of up to 30, formed within experience bands (lifetime verified hours) so newcomers meet newcomers.
  // The whole league is one snapshot, rebuilt at most once per LEAGUE_TTL (and on join/leave) however many requests
  // arrive; concurrent requests share the rebuild in flight, and chain reads run at most 8 at a time.
  let leagueSnap = null;
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } }));
    return out;
  }
  function snapshot() {
    if (leagueSnap && t() - leagueSnap.at < LEAGUE_TTL) return leagueSnap.data;
    const today = Math.floor(t() / 86400), d = new Date(t() * 1000);
    const start = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000), end = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 86400000) - 1;
    const data = pool(q("SELECT * FROM league ORDER BY joined_at, wallet").all(), 8, async (m) => {
      const [life, recs] = await Promise.all([chain.totalHours(m.wallet), chain.records(m.wallet)]);
      return { ...m, band: BANDS.findIndex((b) => life < b), hours: recs.filter((r) => r.serviceDay >= start && r.serviceDay <= today).reduce((a, r) => a + r.hours, 0) };
    }).then((members) => ({ start, end, members }));
    const snap = { at: t(), data };
    leagueSnap = snap;
    data.catch(() => { if (leagueSnap === snap) leagueSnap = null; }); // never keep a failed read
    return data;
  }
  async function league(me) {
    const mine = q("SELECT * FROM league WHERE wallet = ?").get(me);
    if (!mine) return { joined: false };
    let { start, end, members } = await snapshot();
    if (!members.some((m) => m.wallet === me)) { leagueSnap = null; ({ start, end, members } = await snapshot()); } // joined after the snapshot
    const band = members.find((m) => m.wallet === me).band, inBand = members.filter((m) => m.band === band);
    const idx = inBand.findIndex((m) => m.wallet === me), cohort = inBand.slice(Math.floor(idx / 30) * 30, Math.floor(idx / 30) * 30 + 30);
    cohort.sort((a, b) => b.hours - a.hours || a.joined_at - b.joined_at);
    const rank = cohort.findIndex((m) => m.wallet === me);
    return {
      joined: true, alias: mine.alias, season: { start, end }, band: BAND_NAMES[band], cohortSize: cohort.length, rank: rank + 1,
      hours: cohort[rank].hours,
      strip: cohort.slice(Math.max(0, rank - 3), rank + 4).map((m) => ({ alias: m.alias, hours: m.hours, rank: cohort.indexOf(m) + 1, you: m.wallet === me })),
    };
  }

  Object.assign(routes, trustRoutes({ db, keysDb, chain, secret, chainId, publicUrl, t, session, fail, q }));
  routes["GET /metrics"] = ({ req }) => (ops.metricsAllowed(req, metricsToken) ? ops.metrics() : fail(404, "Not found."));
  const table = Object.entries(routes).map(([k, fn]) => {
    const [method, pattern] = k.split(" ");
    return { method, re: new RegExp(`^${pattern.replace(":id", "(\\d+)").replace(":addr", "(0x[0-9a-fA-F]{40})")}$`), fn };
  });

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0, data = "";
      req.on("data", (c) => { size += c.length; if (size > 16384) { reject(new HttpError(413, "Request too large.")); req.destroy(); } else data += c; });
      req.on("end", () => {
        let v;
        try { v = data ? JSON.parse(data) : {}; } catch { return reject(new HttpError(400, "Body must be JSON.")); }
        if (v === null || typeof v !== "object" || Array.isArray(v)) return reject(new HttpError(400, "Body must be a JSON object."));
        resolve(v);
      });
      req.on("error", reject);
    });
  }

  return async function handle(req, res) {
    // Bearer tokens, no cookies: any origin may call, nothing ambient is sent.
    const t0 = performance.now();
    const reply = (status, obj, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
      ops.record(req, status, performance.now() - t0);
    };
    if (req.method === "OPTIONS") return reply(204);
    const wait = ops.throttle(req);
    if (wait) return reply(429, { error: `Too many requests. Try again in ${wait} seconds.` }, { "retry-after": String(wait) });
    try {
      const url = new URL(req.url, "http://localhost");
      let m;
      const route = table.find((r) => r.method === req.method && (m = r.re.exec(url.pathname)));
      if (!route) fail(404, "Not found.");
      const body = req.method === "POST" || req.method === "PUT" ? await readJson(req) : {};
      reply(200, await route.fn({ req, url, body, id: m[1] && Number(m[1]), param: m[1] }));
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message });
      const transport = ["NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR", "ECONNREFUSED"].includes(e?.code) || e?.cause?.code === "ECONNREFUSED";
      console.error(e);
      reply(transport ? 502 : 500, { error: transport ? "The attendance service could not reach the chain. Try again shortly." : "Internal error." });
    }
  };
}

if (require.main === module) {
  const env = process.env;
  const secret = env.ATTENDANCE_SECRET;
  // no random fallback: the vault master key and credential issuer key derive from it, so a new secret per restart would lock away every stored profile
  if (!secret || secret.length < 32) {
    console.error('ATTENDANCE_SECRET must be set (32+ characters, the same value for the indexer). Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
  const chainId = Number(env.CHAIN_ID || 31337);
  const ledger = env.LEDGER || "0xd714101097150109C3b0D8d30451280680ED44bA"; // local deterministic V2 ledger (docs/config.js)
  const rpc = env.RPC_URL || "http://127.0.0.1:8546";
  const db = openDb(env.ATTENDANCE_DB || path.join(__dirname, "data", "attendance.sqlite"));
  // the vault's data keys live in their own database, so erasing a key also defeats copies of the main database
  const keysFile = env.VAULT_KEYS_DB || path.join(__dirname, "data", "vault-keys.sqlite");
  fs.mkdirSync(path.dirname(keysFile), { recursive: true });
  const keysDb = new DatabaseSync(keysFile);
  const port = Number(env.PORT || 8790);
  const badges = env.BADGES || "0x64d4972B737C1ECfab6FEdE9AD201D28660a35F4"; // local deterministic V2 badges (docs/config.js)
  const local = chainId === 31337;
  const appOrigins = env.APP_ORIGINS ? env.APP_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : null;
  if (!local && !appOrigins) { console.error("APP_ORIGINS must list the front end's origin(s) on a public network (Sign-In with Ethereum domain binding)."); process.exit(1); }
  const confirmations = Number(env.CONFIRMATIONS || (local ? 1 : 3));
  http.createServer(createApp({ db, keysDb, chain: ledgerChain(rpc, ledger, chainId, badges, confirmations), secret, chainId, publicUrl: env.PUBLIC_URL || `http://127.0.0.1:${port}`, appOrigins,
    rateLimit: Number(env.RATE_LIMIT || 300), log: env.LOG_REQUESTS !== "0", trustProxy: env.TRUST_PROXY === "1", metricsToken: env.METRICS_TOKEN || null }))
    .listen(port, "127.0.0.1", () => console.log(`Attendance service on http://127.0.0.1:${port} (ledger ${ledger} via ${rpc})\nSESSION_PUBLIC_KEY for the indexer: ${sessionKeys(secret).publicKey}`));
}

module.exports = { createApp, openDb, ledgerChain, QR_WINDOW };
