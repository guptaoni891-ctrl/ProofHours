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
const { ethers } = require("ethers");
const { mac, safeEq, issue, verify } = require("./session");
const { trustRoutes } = require("./trust");

const QR_WINDOW = 30; // seconds per rotating QR code; a code is accepted in its own window and the next one
const SESSION_TTL = 2 * 3600;
const NONCE_TTL = 300;
const EARLY_CHECKIN = 30 * 60; // check-in opens 30 minutes before the shift
const LATE_CHECKOUT = 2 * 3600; // check-out stays open 2 hours after the shift ends

const LEDGER_ABI = [
  "function coordinatorOrg(address) view returns (uint256)",
  "function optedIn(address) view returns (bool)",
  "function getOrg(uint256) view returns (tuple(string name, address admin, bool suspended, uint32 dailyIssueCap))",
  "function getEvent(uint256) view returns (tuple(uint256 orgId, uint8 category, uint16 maxHours, uint32 serviceDay, address createdBy, string code))",
  "function totalHours(address) view returns (uint256)",
  "function hasRole(bytes32, address) view returns (bool)",
  "function originalsOf(address, uint256, uint256) view returns (uint256[] ids, uint256 total)",
  "function headOf(uint256) view returns (tuple(uint256 id, uint256 eventId, address volunteer, uint16 hoursLogged, uint8 entryType, uint8 category, uint256 orgId, address issuer, uint64 recordedAt, uint32 serviceDay, uint256 replacesId, uint256 supersededBy, bytes32 evidenceHash, bytes32 reason, uint256 v1RecordId))",
  "event HoursIssued(uint256 indexed recordId, uint256 indexed eventId, address indexed volunteer, uint16 hoursLogged, uint8 category, bytes32 evidenceHash)",
];

const BANDS = [10, 50, 250, Infinity]; // lifetime verified hours: under 10, under 50, under 250, 250+
const BAND_NAMES = ["Newcomers (under 10h)", "Regulars (10–49h)", "Veterans (50–249h)", "Legends (250h+)"];
const ADJ = ["Amber", "Brisk", "Calm", "Bright", "Coral", "Swift", "Teal", "Golden", "Quiet", "Bold", "Sunny", "Misty"];
const ANIMAL = ["Heron", "Oryx", "Falcon", "Gazelle", "Turtle", "Dolphin", "Lynx", "Ibis", "Fox", "Owl", "Dugong", "Hoopoe"];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const site = (v) => (v === true ? 1 : v === false ? 0 : null); // device-reported yes/no only
const flag = (v) => (v === null || v === undefined ? null : v === 1);

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, exp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, org_id INTEGER NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
      capacity INTEGER NOT NULL, lat REAL, lng REAL, radius INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id), event_id INTEGER NOT NULL, volunteer TEXT NOT NULL,
      in_at INTEGER NOT NULL, in_site INTEGER, out_at INTEGER, out_site INTEGER,
      status TEXT NOT NULL CHECK (status IN ('checked_in','checked_out','approved','rejected','issued')),
      hours INTEGER, decided_by TEXT, decided_at INTEGER, reason TEXT, evidence TEXT, evidence_hash TEXT, record_id TEXT, tx_hash TEXT,
      UNIQUE (shift_id, volunteer));
    CREATE TABLE IF NOT EXISTS league (wallet TEXT PRIMARY KEY, alias TEXT NOT NULL, joined_at INTEGER NOT NULL);`);
  return db;
}

// Read-only view of the V2 ledger and badges. Event lookups return null for unknown events.
function ledgerChain(rpcUrl, ledger, chainId, badgesAddress) {
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
    event: async (id) => {
      try {
        const e = await c.getFunction("getEvent")(id);
        return { orgId: Number(e.orgId), maxHours: Number(e.maxHours), serviceDay: Number(e.serviceDay), code: e.code };
      } catch (e) { if (e.code === "CALL_EXCEPTION") return null; throw e; }
    },
    // shortcut: trusts a receipt with 1 confirmation; on a public chain wait for N confirmations (Stage 3 indexer)
    totalHours: async (a) => Number(await c.totalHours(a)),
    // latest entry of every record the wallet holds (revoked = 0 hours); service day 0 = imported from V1
    // shortcut: first 500 records per wallet; page through originalsOf if anyone gets near that
    records: async (a) => {
      const [ids] = await c.originalsOf(a, 0, 500);
      return (await Promise.all(ids.map((id) => c.headOf(id)))).map((h) => ({ hours: Number(h.entryType) === 2 ? 0 : Number(h.hoursLogged), serviceDay: Number(h.serviceDay) }));
    },
    issued: async (hash) => {
      const r = await provider.getTransactionReceipt(hash);
      if (!r || r.status !== 1) return [];
      return r.logs.filter((l) => l.address.toLowerCase() === ledger.toLowerCase()).map((l) => c.interface.parseLog(l))
        .filter((e) => e?.name === "HoursIssued")
        .map((e) => ({ recordId: String(e.args.recordId), eventId: Number(e.args.eventId), volunteer: e.args.volunteer, evidenceHash: e.args.evidenceHash }));
    },
  };
}

function createApp({ db, keysDb = new DatabaseSync(":memory:"), chain, secret, chainId, publicUrl = "http://127.0.0.1:8790", now = () => Date.now() }) {
  const t = () => Math.floor(now() / 1000);
  const q = (sql) => db.prepare(sql);

  const address = (v) => { try { return ethers.getAddress(String(v)); } catch { return fail(400, "Not a wallet address."); } };
  const int = (v, name, min, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(400, `${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  const signInMessage = (a, nonce) =>
    `ProofHours attendance sign-in\nWallet: ${a}\nChain: ${chainId}\nNonce: ${nonce}\n\nSigning proves you control this wallet. It is free and sends no transaction.`;

  function session(req) {
    const v = verify(secret, req.headers.authorization, t());
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
    site: s.lat === null ? null : { lat: s.lat, lng: s.lng, radius: s.radius },
    attending: q("SELECT COUNT(*) AS n FROM attendance WHERE shift_id = ? AND status != 'rejected'").get(s.id).n,
  });
  // Hours inside the shift window, whole hours rounded down, capped by the event's maximum.
  const hoursOf = (a, s, maxHours) => Math.min(maxHours, Math.floor(Math.max(0, Math.min(a.out_at, s.end_at) - Math.max(a.in_at, s.start_at)) / 3600));
  const attendanceView = (a, preview) => ({
    id: a.id, shiftId: a.shift_id, eventId: a.event_id, volunteer: a.volunteer, checkIn: a.in_at, checkOut: a.out_at,
    atSiteIn: flag(a.in_site), atSiteOut: flag(a.out_site), status: a.status, hours: a.hours ?? preview ?? null,
    decidedBy: a.decided_by, reason: a.reason, evidence: a.evidence, evidenceHash: a.evidence_hash, recordId: a.record_id, txHash: a.tx_hash,
  });

  function readQr(token, kind) {
    const [sid, k, win, sig] = String(token ?? "").split(".");
    if (!sig || !safeEq(sig, mac(secret, `qr.${sid}.${k}.${win}`))) fail(400, "This QR code is not valid.");
    if (k !== kind) fail(400, kind === "in" ? "This is a check-out code. Scan the check-in code." : "This is a check-in code. Scan the check-out code.");
    const cur = Math.floor(t() / QR_WINDOW);
    if (Number(win) > cur || Number(win) < cur - 1) fail(400, "This QR code expired. Scan the code on the coordinator's screen now.");
    return shiftById(Number(sid));
  }

  const routes = {
    "GET /health": () => ({ ok: true }),

    // Sign-in: the server issues a one-time nonce and the exact message; the wallet signs it (personal_sign).
    "POST /auth/nonce": ({ body }) => {
      const a = address(body.address), nonce = crypto.randomBytes(16).toString("hex");
      q("DELETE FROM nonces WHERE exp < ?").run(t());
      q("INSERT INTO nonces (nonce, exp) VALUES (?, ?)").run(nonce, t() + NONCE_TTL);
      return { nonce, message: signInMessage(a, nonce) };
    },
    "POST /auth": ({ body }) => {
      const a = address(body.address);
      if (!q("DELETE FROM nonces WHERE nonce = ? AND exp >= ? RETURNING nonce").get(String(body.nonce), t()))
        fail(401, "This sign-in request expired or was already used. Try again.");
      let signer;
      try { signer = ethers.verifyMessage(signInMessage(a, body.nonce), String(body.signature)); } catch { fail(401, "The signature is not valid."); }
      if (signer !== a) fail(401, "The signature does not match this wallet.");
      const exp = t() + SESSION_TTL;
      return { token: issue(secret, a, exp), address: a, expiresAt: exp };
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
      const { lastInsertRowid } = q("INSERT INTO shifts (event_id, org_id, start_at, end_at, capacity, lat, lng, radius, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(eventId, org, start, end, capacity, lat, lng, radius, me, t());
      return shiftView(shiftById(Number(lastInsertRowid)));
    },
    "GET /shifts": async ({ req }) => {
      const org = await coordinatorFor(session(req));
      return q("SELECT * FROM shifts WHERE org_id = ? ORDER BY start_at DESC, id DESC").all(org).map(shiftView);
    },
    "GET /shifts/:id": ({ id }) => shiftView(shiftById(id)), // public: event, times, capacity, site area; no attendee data
    // Public directory of shifts that haven't ended: times, capacity, spots taken. No attendee identities.
    "GET /opportunities": () => q("SELECT * FROM shifts WHERE end_at > ? ORDER BY start_at, id LIMIT 200").all(t()).map(shiftView),

    "GET /shifts/:id/qr": async ({ req, id, url }) => {
      const s = shiftById(id);
      await coordinatorFor(session(req), s.org_id);
      const kind = url.searchParams.get("kind") === "out" ? "out" : "in", win = Math.floor(t() / QR_WINDOW);
      return { token: `${s.id}.${kind}.${win}.${mac(secret, `qr.${s.id}.${kind}.${win}`)}`, kind, now: t(), rotatesAt: (win + 1) * QR_WINDOW, expiresAt: (win + 2) * QR_WINDOW };
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
      const same = q("SELECT shift_id FROM attendance WHERE volunteer = ? AND event_id = ? AND status != 'rejected'").get(me, s.event_id);
      if (same) fail(409, `You already have attendance for this event (shift #${same.shift_id}). The ledger holds one record per volunteer per event.`);
      if (q("SELECT COUNT(*) AS n FROM attendance WHERE shift_id = ? AND status != 'rejected'").get(s.id).n >= s.capacity) fail(409, "This shift is full.");
      const { lastInsertRowid } = q("INSERT INTO attendance (shift_id, event_id, volunteer, in_at, in_site, status) VALUES (?,?,?,?,?, 'checked_in')")
        .run(s.id, s.event_id, me, now, site(body.atSite));
      return attendanceView(attendanceById(Number(lastInsertRowid)));
    },
    "POST /checkout": ({ req, body }) => {
      const me = session(req), s = readQr(body.token, "out"), now = t();
      const a = q("SELECT * FROM attendance WHERE shift_id = ? AND volunteer = ?").get(s.id, me);
      if (!a) fail(409, "You have not checked in to this shift.");
      if (a.status !== "checked_in") fail(409, "You already checked out of this shift.");
      if (now > s.end_at + LATE_CHECKOUT) fail(400, "Check-out closed 2 hours after the shift ended. Ask the coordinator.");
      q("UPDATE attendance SET out_at = ?, out_site = ?, status = 'checked_out' WHERE id = ?").run(now, site(body.atSite), a.id);
      return attendanceView(attendanceById(a.id), hoursOf({ ...a, out_at: now }, s, 24));
    },
    // ---------- Leagues (opt-in). Members are shown by a generated alias, never by wallet, and only the 3 above and
    // 3 below you are returned. Seasons are calendar months (UTC); a season's score is verified hours served in it.
    "POST /league/join": async ({ req }) => {
      const me = session(req);
      if (!(await chain.optedIn(me))) fail(403, "Opt in on your passport first: leagues rank verified hours only.");
      const alias = `${ADJ[crypto.randomInt(ADJ.length)]} ${ANIMAL[crypto.randomInt(ANIMAL.length)]} ${crypto.randomInt(10, 100)}`;
      q("INSERT OR IGNORE INTO league (wallet, alias, joined_at) VALUES (?, ?, ?)").run(me, alias, t());
      return league(me);
    },
    "POST /league/leave": ({ req }) => {
      q("DELETE FROM league WHERE wallet = ?").run(session(req)); // removed from every ranking immediately
      return { joined: false };
    },
    "GET /league/me": ({ req }) => league(session(req)),

    "GET /me/attendance": ({ req }) =>
      q("SELECT * FROM attendance WHERE volunteer = ? ORDER BY in_at DESC").all(session(req)).map((a) => attendanceView(a)),

    "GET /shifts/:id/attendance": async ({ req, id }) => {
      const s = shiftById(id), ev = await event(s.event_id);
      await coordinatorFor(session(req), s.org_id);
      return q("SELECT * FROM attendance WHERE shift_id = ? ORDER BY in_at").all(id)
        .map((a) => attendanceView(a, a.status === "checked_out" ? hoursOf(a, s, ev.maxHours) : undefined));
    },
    "POST /attendance/:id/approve": async ({ req, id }) => {
      const me = session(req), s = shiftById(attendanceById(id).shift_id), ev = await event(s.event_id);
      await coordinatorFor(me, s.org_id);
      const a = attendanceById(id); // re-read after the awaits
      if (a.status !== "checked_out") fail(409, a.status === "checked_in" ? "The volunteer has not checked out yet." : `This attendance is already ${a.status}.`);
      const hours = hoursOf(a, s, ev.maxHours);
      if (hours < 1) fail(409, "Less than one full hour inside the shift, so there is nothing to approve. Reject it instead.");
      // The salt stops anyone guessing the times from the public evidence hash.
      const evidence = JSON.stringify({
        v: 1, kind: "proofhours-attendance", shiftId: s.id, eventId: s.event_id, volunteer: a.volunteer, shiftStart: s.start_at, shiftEnd: s.end_at,
        checkIn: a.in_at, checkOut: a.out_at, atSiteIn: flag(a.in_site), atSiteOut: flag(a.out_site), hours, approvedBy: me, approvedAt: t(),
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
      if (!["checked_in", "checked_out"].includes(a.status)) fail(409, `This attendance is already ${a.status}.`);
      q("UPDATE attendance SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ?").run(me, t(), reason, id);
      return attendanceView(attendanceById(id));
    },

    // What the coordinator's wallet should send: issueBatch(eventId, volunteers, hours, evidence).
    "GET /shifts/:id/issuable": async ({ req, id }) => {
      const s = shiftById(id);
      await coordinatorFor(session(req), s.org_id);
      const rows = q("SELECT * FROM attendance WHERE shift_id = ? AND status = 'approved' ORDER BY id").all(id);
      return { eventId: s.event_id, attendanceIds: rows.map((r) => r.id), volunteers: rows.map((r) => r.volunteer), hours: rows.map((r) => r.hours), evidence: rows.map((r) => r.evidence_hash) };
    },
    // Marks attendance as issued only when the chain shows a matching HoursIssued log (event, wallet and evidence hash).
    "POST /shifts/:id/issued": async ({ req, id, body }) => {
      const s = shiftById(id);
      await coordinatorFor(session(req), s.org_id);
      if (!ethers.isHexString(body.txHash, 32)) fail(400, "Not a transaction hash.");
      const logs = await chain.issued(body.txHash);
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
  // shortcut: reads every member's records from the chain on each request; cache or index this past a few hundred members
  async function league(me) {
    const mine = q("SELECT * FROM league WHERE wallet = ?").get(me);
    if (!mine) return { joined: false };
    const today = Math.floor(t() / 86400), d = new Date(t() * 1000);
    const start = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000), end = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 86400000) - 1;
    const members = await Promise.all(q("SELECT * FROM league ORDER BY joined_at, wallet").all().map(async (m) => {
      const [life, recs] = await Promise.all([chain.totalHours(m.wallet), chain.records(m.wallet)]);
      return { ...m, band: BANDS.findIndex((b) => life < b), hours: recs.filter((r) => r.serviceDay >= start && r.serviceDay <= today).reduce((a, r) => a + r.hours, 0) };
    }));
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
  const table = Object.entries(routes).map(([k, fn]) => {
    const [method, pattern] = k.split(" ");
    return { method, re: new RegExp(`^${pattern.replace(":id", "(\\d+)").replace(":addr", "(0x[0-9a-fA-F]{40})")}$`), fn };
  });

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0, data = "";
      req.on("data", (c) => { size += c.length; if (size > 16384) { reject(new HttpError(413, "Request too large.")); req.destroy(); } else data += c; });
      req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, "Body must be JSON.")); } });
      req.on("error", reject);
    });
  }

  return async function handle(req, res) {
    // Bearer tokens, no cookies: any origin may call, nothing ambient is sent.
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "cache-control": "no-store" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") return reply(204);
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
  let secret = env.ATTENDANCE_SECRET;
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    console.warn("ATTENDANCE_SECRET is not set: using a random one, so sign-ins and QR codes stop working when the service restarts.");
  }
  const chainId = Number(env.CHAIN_ID || 31337);
  const ledger = env.LEDGER || "0xd714101097150109C3b0D8d30451280680ED44bA"; // local deterministic V2 ledger (docs/config.js)
  const rpc = env.RPC_URL || "http://127.0.0.1:8546";
  const db = openDb(env.ATTENDANCE_DB || path.join(__dirname, "data", "attendance.sqlite"));
  // the vault's data keys live in their own database, so erasing a key also defeats copies of the main database
  const keysDb = new DatabaseSync(env.VAULT_KEYS_DB || path.join(__dirname, "data", "vault-keys.sqlite"));
  const port = Number(env.PORT || 8790);
  const badges = env.BADGES || "0x64d4972B737C1ECfab6FEdE9AD201D28660a35F4"; // local deterministic V2 badges (docs/config.js)
  http.createServer(createApp({ db, keysDb, chain: ledgerChain(rpc, ledger, chainId, badges), secret, chainId, publicUrl: env.PUBLIC_URL || `http://127.0.0.1:${port}` }))
    .listen(port, "127.0.0.1", () => console.log(`Attendance service on http://127.0.0.1:${port} (ledger ${ledger} via ${rpc})`));
}

module.exports = { createApp, openDb, ledgerChain, QR_WINDOW };
