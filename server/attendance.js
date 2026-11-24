// ProofHours attendance service (V2, Stage 2): shifts, rotating QR check-in/out, supervisor approval.
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
  "event HoursIssued(uint256 indexed recordId, uint256 indexed eventId, address indexed volunteer, uint16 hoursLogged, uint8 category, bytes32 evidenceHash)",
];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const mac = (secret, s) => crypto.createHmac("sha256", secret).update(s).digest("base64url").slice(0, 22);
const safeEq = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
      UNIQUE (shift_id, volunteer));`);
  return db;
}

// Read-only view of the V2 ledger. Event lookups return null for unknown events.
function ledgerChain(rpcUrl, ledger, chainId) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const c = new ethers.Contract(ledger, LEDGER_ABI, provider);
  return {
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
    issued: async (hash) => {
      const r = await provider.getTransactionReceipt(hash);
      if (!r || r.status !== 1) return [];
      return r.logs.filter((l) => l.address.toLowerCase() === ledger.toLowerCase()).map((l) => c.interface.parseLog(l))
        .filter((e) => e?.name === "HoursIssued")
        .map((e) => ({ recordId: String(e.args.recordId), eventId: Number(e.args.eventId), volunteer: e.args.volunteer, evidenceHash: e.args.evidenceHash }));
    },
  };
}

function createApp({ db, chain, secret, chainId, now = () => Date.now() }) {
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
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || "");
    if (!m) fail(401, "Sign in with your wallet first.");
    const [a, exp, sig] = m[1].split(".");
    if (!sig || !safeEq(sig, mac(secret, `session.${a}.${exp}`))) fail(401, "Your sign-in is not valid. Sign in again.");
    if (Number(exp) < t()) fail(401, "Your sign-in expired. Sign in again.");
    return a;
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
      const exp = t() + SESSION_TTL, payload = `${a}.${exp}`;
      return { token: `${payload}.${mac(secret, "session." + payload)}`, address: a, expiresAt: exp };
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

  const table = Object.entries(routes).map(([k, fn]) => {
    const [method, pattern] = k.split(" ");
    return { method, re: new RegExp(`^${pattern.replace(":id", "(\\d+)")}$`), fn };
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
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS", "cache-control": "no-store" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") return reply(204);
    try {
      const url = new URL(req.url, "http://localhost");
      let m;
      const route = table.find((r) => r.method === req.method && (m = r.re.exec(url.pathname)));
      if (!route) fail(404, "Not found.");
      const body = req.method === "POST" ? await readJson(req) : {};
      reply(200, await route.fn({ req, url, body, id: m[1] && Number(m[1]) }));
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
  const port = Number(env.PORT || 8790);
  http.createServer(createApp({ db, chain: ledgerChain(rpc, ledger, chainId), secret, chainId }))
    .listen(port, "127.0.0.1", () => console.log(`Attendance service on http://127.0.0.1:${port} (ledger ${ledger} via ${rpc})`));
}

module.exports = { createApp, openDb, ledgerChain, QR_WINDOW };
