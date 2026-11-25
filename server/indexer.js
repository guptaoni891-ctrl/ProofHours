// ProofHours V2 indexer + search API (Stage 3). Reads ProofHoursLedger logs into SQLite and serves full-text search
// over public NGO and event data. The chain stays the source of truth: everything here is a derived cache that can be
// dropped and rebuilt. Reorg-safe: it stores the hash of every block it relies on, and on a mismatch rolls back to the
// last block whose hash still matches (a block hash commits to all its ancestors) and replays from there.
// Derived tables are updated incrementally from each new batch of logs; only a reorg triggers a full rebuild.
// Volunteer wallets are never stored: they are dropped from every log before it is saved (Stage 5 records too).
// Stage 5 adds a record index for NGO reports and auditor views: anomaly alerts (allegations for human review, never
// acted on automatically) and reproducible spot-audit samples. Auditor views need an auditor's wallet sign-in, checked
// with the attendance service's PUBLIC session key: this process can verify sessions but never create them.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const { ethers } = require("ethers");
const session = require("./session");
const { createOps } = require("./ops");

const CATS = ["Environmental", "Education", "Healthcare", "Emergency response", "Inclusion"];
const ABI = [
  "event OrgRegistered(uint256 indexed orgId, string name, address indexed admin, uint32 dailyIssueCap)",
  "event OrgSuspended(uint256 indexed orgId, address indexed by)",
  "event OrgReinstated(uint256 indexed orgId, address indexed by)",
  "event EventCreated(uint256 indexed eventId, uint256 indexed orgId, uint8 category, uint16 maxHours, uint32 serviceDay, string code)",
  "event HoursIssued(uint256 indexed recordId, uint256 indexed eventId, address indexed volunteer, uint16 hoursLogged, uint8 category, bytes32 evidenceHash)",
  "event RecordCorrected(uint256 indexed newRecordId, uint256 indexed replacesId, address indexed volunteer, uint16 newHours, bytes32 reason)",
  "event RecordRevoked(uint256 indexed newRecordId, uint256 indexed replacesId, address indexed volunteer, bytes32 reason)",
  "event V1Migrated(uint256 indexed v1Id, uint256 indexed recordId, address indexed volunteer, uint16 hoursLogged, uint8 category)",
];
const LEDGER_VIEWS = ["function hasRole(bytes32, address) view returns (bool)"];
const AUDITOR_ROLE = ethers.id("AUDITOR_ROLE");
// Anomaly rule thresholds. Alerts are allegations: they open nothing and change nothing on their own.
const RULES = { largeSingle: 12, spikeMin: 50, spikeFactor: 3, correctionRate: 0.2, correctionMin: 10, backdatedDays: 30 };
const iface = new ethers.Interface(ABI);
const TOPICS = [ABI.map((_, i) => iface.fragments[i].topicHash)];
const KEEP_HASHES = 256; // block hashes kept for reorg checks; a deeper reorg triggers a full reindex
const SCHEMA = 3;

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (db.prepare("PRAGMA user_version").get().user_version < SCHEMA) // older cache layout: drop it, it is rebuilt from the chain
    db.exec(`DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS logs; DROP TABLE IF EXISTS orgs; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS records; PRAGMA user_version = ${SCHEMA};`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (block INTEGER NOT NULL, log_index INTEGER NOT NULL, block_hash TEXT NOT NULL, tx TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, ts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (block, log_index));
    -- every entry; originals (issued/migrated) also carry their chain's current head, kept up to date as entries arrive
    CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, replaces INTEGER, orig INTEGER NOT NULL, event_id INTEGER, org_id INTEGER, category INTEGER, hours INTEGER NOT NULL, service_day INTEGER NOT NULL, issued_day INTEGER NOT NULL, tx TEXT NOT NULL, head_id INTEGER, head_hours INTEGER, head_kind TEXT);
    CREATE INDEX IF NOT EXISTS records_org_day ON records (org_id, service_day);
    CREATE TABLE IF NOT EXISTS orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, admin TEXT NOT NULL, suspended INTEGER NOT NULL, tx TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, category INTEGER NOT NULL, max_hours INTEGER NOT NULL, service_day INTEGER NOT NULL, code TEXT NOT NULL, tx TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(kind UNINDEXED, ref UNINDEXED, category UNINDEXED, org UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');`);
  return db;
}

// Applies decoded logs ({ name, args, tx, ts }, in chain order) to the derived tables. The caller owns the transaction.
function applyLogs(db, logs) {
  const st = (sql) => db.prepare(sql);
  const org = st("INSERT INTO orgs (id, name, admin, suspended, tx) VALUES (?, ?, ?, 0, ?)"), susp = st("UPDATE orgs SET suspended = ? WHERE id = ?");
  const ev = st("INSERT INTO events (id, org_id, category, max_hours, service_day, code, tx) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const rec = st("INSERT INTO records (id, kind, replaces, orig, event_id, org_id, category, hours, service_day, issued_day, tx, head_id, head_hours, head_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const head = st("UPDATE records SET head_id = ?, head_hours = ?, head_kind = ? WHERE id = ?");
  const evOf = st("SELECT org_id, service_day FROM events WHERE id = ?"), recOf = st("SELECT * FROM records WHERE id = ?"), orgOf = st("SELECT * FROM orgs WHERE id = ?");
  const doc = st("INSERT INTO docs (kind, ref, category, org, title, body) VALUES (?, ?, ?, ?, ?, ?)"), undoc = st("DELETE FROM docs WHERE kind = ? AND ref = ?");
  const orgDoc = (id) => { const o = orgOf.get(id); if (!o) return; undoc.run("org", id); doc.run("org", o.id, null, o.id, o.name, `NGO ${o.suspended ? "suspended" : "active"}`); };
  for (const l of logs) {
    const a = l.args, day = Math.floor(l.ts / 86400);
    if (l.name === "OrgRegistered") { org.run(a.orgId, a.name, a.admin, l.tx); orgDoc(a.orgId); }
    else if (l.name === "OrgSuspended" || l.name === "OrgReinstated") { susp.run(l.name === "OrgSuspended" ? 1 : 0, a.orgId); orgDoc(a.orgId); }
    else if (l.name === "EventCreated") {
      ev.run(a.eventId, a.orgId, a.category, a.maxHours, a.serviceDay, a.code, l.tx);
      doc.run("event", a.eventId, a.category, a.orgId, a.code, `${orgOf.get(a.orgId)?.name ?? ""} ${CATS[a.category] ?? ""} ${new Date(a.serviceDay * 86400000).toISOString().slice(0, 10)}`);
    } else if (l.name === "HoursIssued") {
      const e = evOf.get(a.eventId);
      rec.run(a.recordId, "issued", null, a.recordId, a.eventId, e?.org_id ?? null, a.category, a.hoursLogged, e?.service_day ?? 0, day, l.tx, a.recordId, a.hoursLogged, "issued");
    } else if (l.name === "V1Migrated") {
      rec.run(a.recordId, "migrated", null, a.recordId, null, null, a.category, a.hoursLogged, 0, day, l.tx, a.recordId, a.hoursLogged, "migrated"); // shortcut: NGO of V1 imports isn't in the log
    } else if (l.name === "RecordCorrected" || l.name === "RecordRevoked") {
      const r = recOf.get(a.replacesId), kind = l.name === "RecordCorrected" ? "corrected" : "revoked", hours = kind === "corrected" ? a.newHours : 0, orig = r?.orig ?? a.replacesId;
      rec.run(a.newRecordId, kind, a.replacesId, orig, r?.event_id ?? null, r?.org_id ?? null, r?.category ?? null, hours, r?.service_day ?? 0, day, l.tx, null, null, null);
      head.run(a.newRecordId, hours, kind, orig);
    }
  }
}

const decode = (rows) => rows.map((l) => ({ ...l, args: JSON.parse(l.args) }));

// Recomputes orgs, events, records and the search index from the stored logs (after a reorg).
function rebuild(db) {
  db.exec("BEGIN; DELETE FROM orgs; DELETE FROM events; DELETE FROM docs; DELETE FROM records;");
  try {
    applyLogs(db, decode(db.prepare("SELECT name, args, tx, ts FROM logs ORDER BY block, log_index").all()));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

function createIndexer({ db, provider, ledger, startBlock = 0, confirmations = 2, chunk = 2000 }) {
  const cursor = () => db.prepare("SELECT number, hash FROM blocks ORDER BY number DESC LIMIT 1").get();
  let reorgs = 0;

  async function rollback() {
    let ancestor = null;
    for (const row of db.prepare("SELECT number, hash FROM blocks ORDER BY number DESC").all()) {
      const b = await provider.getBlock(row.number);
      if (b && b.hash === row.hash) { ancestor = row.number; break; }
    }
    const keep = ancestor ?? startBlock - 1; // nothing matched: reindex everything
    db.prepare("DELETE FROM logs WHERE block > ?").run(keep);
    db.prepare("DELETE FROM blocks WHERE number > ?").run(keep);
    rebuild(db);
    reorgs++;
    return keep;
  }

  // One step: detect a reorg, then index the next chunk of confirmed blocks. Returns how far it got.
  async function syncOnce() {
    const head = await provider.getBlockNumber(), target = head - confirmations;
    let cur = cursor();
    if (cur) {
      const b = await provider.getBlock(cur.number);
      if (!b || b.hash !== cur.hash) { await rollback(); cur = cursor(); }
    }
    const from = cur ? cur.number + 1 : startBlock, to = Math.min(target, from + chunk - 1);
    if (to >= from) {
      const tip = await provider.getBlock(to);
      const logs = (await provider.getLogs({ address: ledger, fromBlock: from, toBlock: to, topics: TOPICS })).sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
      if ((await provider.getBlock(to))?.hash !== tip.hash) return { head, indexed: cur?.number ?? startBlock - 1, retry: true }; // moved under us
      const ts = new Map();
      for (const n of new Set(logs.map((l) => l.blockNumber))) ts.set(n, (await provider.getBlock(n)).timestamp);
      db.exec("BEGIN");
      try {
        const ins = db.prepare("INSERT OR REPLACE INTO logs (block, log_index, block_hash, tx, name, args, ts) VALUES (?, ?, ?, ?, ?, ?, ?)");
        const blk = db.prepare("INSERT OR REPLACE INTO blocks (number, hash) VALUES (?, ?)");
        const fresh = [];
        for (const l of logs) {
          const p = iface.parseLog(l);
          const args = Object.fromEntries(p.fragment.inputs.filter((inp) => inp.name !== "volunteer").map((inp) => [inp.name, typeof p.args[inp.name] === "bigint" ? Number(p.args[inp.name]) : p.args[inp.name]]));
          ins.run(l.blockNumber, l.index, l.blockHash, l.transactionHash, p.name, JSON.stringify(args), ts.get(l.blockNumber));
          blk.run(l.blockNumber, l.blockHash);
          fresh.push({ name: p.name, args, tx: l.transactionHash, ts: ts.get(l.blockNumber) });
        }
        applyLogs(db, fresh); // incremental: only the new logs, in the same transaction as the logs themselves
        blk.run(to, tip.hash);
        db.prepare("DELETE FROM blocks WHERE number < ?").run(to - KEEP_HASHES);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
    return { head, indexed: Math.max(to, (cur?.number ?? startBlock - 1)), behind: Math.max(0, target - to) };
  }

  async function syncAll() { let r; do r = await syncOnce(); while (r.behind > 0 || r.retry); return r; }
  return { syncOnce, syncAll, cursor, reorgs: () => reorgs };
}

// First block where the ledger has code (binary search). RPC errors are fatal by default: on a node without full
// history they would look like "no code yet" and silently push the start past the ledger's first logs. Only a local
// fork, which can't serve history from before the fork, should pass tolerateErrors.
async function findDeployBlock(provider, address, { tolerateErrors = false } = {}) {
  let lo = 0, hi = await provider.getBlockNumber();
  const has = async (n) => {
    try { return (await provider.getCode(address, n)) !== "0x"; } catch (e) {
      if (tolerateErrors) return false;
      throw new Error(`Couldn't read code at block ${n} (${e.shortMessage || e.message}). This RPC may not keep full history: set START_BLOCK to the ledger's deploy block.`);
    }
  };
  if (!(await has(hi))) throw new Error(`No contract at ${address} on this chain.`);
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (await has(mid)) hi = mid; else lo = mid + 1; }
  return lo;
}

// Latest entry of every original record (issued or imported), with its NGO, area and days.
function effective(db) {
  return db.prepare("SELECT * FROM records WHERE kind IN ('issued', 'migrated') ORDER BY id").all()
    .map((o) => ({ ...o, hours: o.head_hours, head: o.head_id, headKind: o.head_kind }));
}

// NGO impact report: verified hours (latest entries) for records served in [from, to] (UTC day numbers). One indexed query.
function report(db, orgId, from, to) {
  const where = "FROM records WHERE kind IN ('issued', 'migrated') AND org_id = ? AND service_day BETWEEN ? AND ?";
  const tot = db.prepare(`SELECT COALESCE(SUM(head_hours), 0) AS hours, COUNT(*) AS n, COALESCE(SUM(head_kind = 'corrected'), 0) AS corrected, COALESCE(SUM(head_kind = 'revoked'), 0) AS revoked, COUNT(DISTINCT event_id) AS events ${where}`).get(orgId, from, to);
  const byCat = new Map(db.prepare(`SELECT category, COALESCE(SUM(head_hours), 0) AS hours, COUNT(*) AS n ${where} GROUP BY category`).all(orgId, from, to).map((r) => [r.category, r]));
  return {
    org: db.prepare("SELECT id, name, suspended FROM orgs WHERE id = ?").get(orgId) ?? null, from, to,
    totalHours: tot.hours, records: tot.n, corrected: tot.corrected, revoked: tot.revoked, events: tot.events,
    byCategory: CATS.map((name, i) => ({ category: i, name, hours: byCat.get(i)?.hours ?? 0, records: byCat.get(i)?.n ?? 0 })),
  };
}

// Anomaly rules over indexed records. Each alert is an allegation for a human to review; nothing happens automatically.
// (More than 12h per volunteer per day and overlapping shifts are prevented upstream, by the contract and the attendance service.)
function alerts(db) {
  const out = [], orgName = (id) => db.prepare("SELECT name FROM orgs WHERE id = ?").get(id)?.name ?? `NGO #${id}`;
  const issued = db.prepare("SELECT * FROM records WHERE kind = 'issued' ORDER BY id").all();
  for (const r of issued) {
    if (r.hours >= RULES.largeSingle) out.push({ rule: "large-single", orgId: r.org_id, records: [r.id], detail: `Record #${r.id}: ${r.hours}h issued in one record (threshold ${RULES.largeSingle}h).` });
    if (r.issued_day - r.service_day > RULES.backdatedDays) out.push({ rule: "backdated", orgId: r.org_id, records: [r.id], detail: `Record #${r.id} was issued ${r.issued_day - r.service_day} days after the service date (threshold ${RULES.backdatedDays}).` });
  }
  // per NGO: hours and records per issuance day, compared with the median of that NGO's previous 30 days
  const byOrg = new Map();
  for (const r of issued) {
    const days = byOrg.get(r.org_id) ?? new Map();
    byOrg.set(r.org_id, days);
    const d = days.get(r.issued_day) ?? { hours: 0, records: [] };
    days.set(r.issued_day, d);
    d.hours += r.hours;
    d.records.push(r.id);
  }
  for (const [org, days] of byOrg) {
    for (const [day, { hours, records }] of days) {
      const prior = [...days].filter(([d]) => d < day && d >= day - 30).map(([, x]) => x.hours).sort((a, b) => a - b);
      const median = prior.length ? prior[Math.floor(prior.length / 2)] : 0, limit = Math.max(RULES.spikeMin, RULES.spikeFactor * median);
      if (hours > limit) out.push({ rule: "spike", orgId: org, records, detail: `${hours}h issued on ${new Date(day * 86400000).toISOString().slice(0, 10)}, above ${limit}h (max of ${RULES.spikeMin}h and ${RULES.spikeFactor}× the 30-day median of ${median}h).` });
    }
  }
  const eff = effective(db).filter((r) => r.org_id !== null), effByOrg = new Map();
  for (const r of eff) effByOrg.set(r.org_id, [...(effByOrg.get(r.org_id) ?? []), r]);
  for (const [org, mine] of effByOrg) {
    const changed = mine.filter((r) => r.headKind !== r.kind);
    if (mine.length >= RULES.correctionMin && changed.length / mine.length >= RULES.correctionRate)
      out.push({ rule: "correction-rate", orgId: org, records: changed.map((r) => r.id), detail: `${changed.length} of ${mine.length} records corrected or revoked (${Math.round((changed.length / mine.length) * 100)}%, threshold ${RULES.correctionRate * 100}%).` });
  }
  return out.map((a) => ({ ...a, org: orgName(a.orgId), id: ethers.id(`${a.rule}:${a.orgId}:${a.records.join(",")}`).slice(0, 18), status: "allegation: needs human review" }));
}

// Reproducible spot-audit sample: a record is picked when keccak256(seed, recordId) falls under the rate. Same seed, same sample.
function sample(db, seed, rate) {
  const ids = db.prepare("SELECT id FROM records WHERE kind IN ('issued', 'migrated') ORDER BY id").all().map((r) => r.id);
  const pick = ids.filter((id) => Number(BigInt(ethers.solidityPackedKeccak256(["bytes32", "uint256"], [seed, id])) % 10000n) < Math.round(rate * 10000));
  return { seed, rate, population: ids.length, records: pick };
}

// Search terms become prefix queries ("mangr" finds "Mangrove"); punctuation is ignored, so FTS syntax can't be injected.
const ftsQuery = (q) => (String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map((w) => `"${w}"*`).join(" ");

class BadRequest extends Error {}

function createApi({ db, indexer, provider, confirmations, ledger, sessionPublicKey = null, now = () => Date.now(), rateLimit = Infinity, log = false, trustProxy = false, metricsToken = null }) {
  const ops = createOps({ service: "indexer", limit: rateLimit, log, now, trustProxy });
  const roles = ledger && new ethers.Contract(ledger, LEDGER_VIEWS, provider);
  const sessionKey = sessionPublicKey ? (typeof sessionPublicKey === "string" ? session.publicKeyFrom(sessionPublicKey) : sessionPublicKey) : null;
  async function auditor(req) {
    if (!sessionKey || !roles) return { status: 503, error: "Auditor views need SESSION_PUBLIC_KEY (from the attendance service's /auth/public-key) and the ledger address." };
    const v = session.verify(sessionKey, req.headers.authorization, Math.floor(now() / 1000));
    if (v.error) return { status: 401, error: v.error };
    if (!(await roles.hasRole(AUDITOR_ROLE, v.address))) return { status: 403, error: "This wallet doesn't hold the auditor role on the ledger." };
    return { address: v.address };
  }
  const intParam = (url, k, re) => { const v = url.searchParams.get(k); if (v === null || v === "") return null; if (!re.test(v)) throw new BadRequest(`${k} must be a whole number.`); return Number(v); };
  function search(url) {
    const t0 = performance.now();
    const q = ftsQuery(url.searchParams.get("q") ?? ""), cat = intParam(url, "category", /^[0-9]$/), org = intParam(url, "org", /^\d{1,9}$/);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const where = q ? "docs MATCH ?" : "1", base = q ? [q] : [];
    const rows = db.prepare(`SELECT kind, ref, category, org, title, body FROM docs WHERE ${where} ${cat !== null ? "AND category = ?" : ""} ${org !== null ? "AND org = ?" : ""} ORDER BY ${q ? "bm25(docs, 0, 0, 0, 0, 10, 1)" : "kind, ref DESC"} LIMIT ?`)
      .all(...base, ...(cat !== null ? [cat] : []), ...(org !== null ? [org] : []), limit);
    // facet counts describe the text match before the facet filters, so every option shows what picking it would give
    const category = Object.fromEntries(db.prepare(`SELECT category AS k, COUNT(*) AS n FROM docs WHERE ${where} AND kind = 'event' GROUP BY category`).all(...base).map((r) => [r.k, r.n]));
    const orgName = db.prepare("SELECT name FROM orgs WHERE id = ?");
    return {
      results: rows.map((r) => ({ kind: r.kind, id: Number(r.ref), title: r.title, detail: r.body.trim(), category: r.category, orgId: Number(r.org), org: orgName.get(r.org)?.name ?? null })),
      facets: { category },
      tookMs: Math.round((performance.now() - t0) * 100) / 100,
    };
  }
  // chain head for /health, read at most every 2 s however often /health is hit
  let headCache = { at: -Infinity, value: null };
  async function chainHead() {
    if (now() - headCache.at < 2000) return headCache.value;
    headCache = { at: now(), value: provider.getBlockNumber().catch(() => null) };
    return headCache.value;
  }

  return async function handle(req, res) {
    const t0 = performance.now();
    const reply = (status, obj, extra = {}) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra });
      res.end(status === 204 ? "" : JSON.stringify(obj));
      ops.record(req, status, performance.now() - t0);
    };
    const wait = ops.throttle(req);
    if (wait) return reply(429, { error: `Too many requests. Try again in ${wait} seconds.` }, { "retry-after": String(wait) });
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "OPTIONS") return reply(204);
      if (req.method !== "GET") return reply(405, { error: "Read-only API." });
      if (url.pathname === "/search") return reply(200, search(url));
      if (url.pathname === "/metrics") return ops.metricsAllowed(req, metricsToken) ? reply(200, ops.metrics()) : reply(404, { error: "Not found." });
      if (url.pathname === "/reports/orgs") return reply(200, db.prepare("SELECT id, name, suspended FROM orgs ORDER BY id").all().map((o) => ({ ...o })));
      const rep = /^\/reports\/org\/(\d{1,9})$/.exec(url.pathname);
      if (rep) {
        const day = (k, d) => {
          const v = url.searchParams.get(k);
          if (v === null || v === "") return d;
          const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(v + "T00:00:00Z") : NaN;
          if (!Number.isFinite(ms)) throw new BadRequest(`${k} must be a date (YYYY-MM-DD).`);
          return Math.floor(ms / 86400000);
        };
        return reply(200, report(db, Number(rep[1]), day("from", 0), day("to", 1e9)));
      }
      if (url.pathname.startsWith("/audit/")) {
        const who = await auditor(req);
        if (who.error) return reply(who.status, { error: who.error });
        if (url.pathname === "/audit/alerts") return reply(200, alerts(db));
        if (url.pathname === "/audit/sample") {
          const rate = Math.min(0.05, Math.max(0.02, Number(url.searchParams.get("rate")) || 0.03));
          const seed = /^0x[0-9a-fA-F]{64}$/.test(url.searchParams.get("seed") ?? "") ? url.searchParams.get("seed") : indexer.cursor()?.hash ?? ethers.ZeroHash;
          return reply(200, sample(db, seed, rate));
        }
      }
      if (url.pathname === "/health") {
        const head = await chainHead(), cur = indexer.cursor();
        return reply(200, { head, indexed: cur?.number ?? null, confirmations, behind: head === null || !cur ? null : Math.max(0, head - confirmations - cur.number), reorgs: indexer.reorgs(),
          orgs: db.prepare("SELECT COUNT(*) AS n FROM orgs").get().n, events: db.prepare("SELECT COUNT(*) AS n FROM events").get().n });
      }
      reply(404, { error: "Not found." });
    } catch (e) {
      if (e instanceof BadRequest) return reply(400, { error: e.message });
      console.error(e);
      reply(500, { error: "Internal error." });
    }
  };
}

if (require.main === module) {
  (async () => {
    const env = process.env;
    const chainId = Number(env.CHAIN_ID || 31337), rpc = env.RPC_URL || "http://127.0.0.1:8546", local = chainId === 31337;
    const ledger = env.LEDGER || "0xd714101097150109C3b0D8d30451280680ED44bA"; // local deterministic V2 ledger (docs/config.js)
    const confirmations = Number(env.CONFIRMATIONS ?? (local ? 2 : 12));
    if (!local && !env.START_BLOCK) { console.error("START_BLOCK (the ledger's deploy block) is required on a public network."); process.exit(1); }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const db = openDb(env.INDEXER_DB || path.join(__dirname, "data", "indexer.sqlite"));
    const startBlock = env.START_BLOCK ? Number(env.START_BLOCK) : await findDeployBlock(provider, ledger, { tolerateErrors: local });
    const indexer = createIndexer({ db, provider, ledger, startBlock, confirmations });
    const port = Number(env.PORT || 8792);
    http.createServer(createApi({ db, indexer, provider, confirmations, ledger, sessionPublicKey: env.SESSION_PUBLIC_KEY || null, rateLimit: Number(env.RATE_LIMIT || 600), log: env.LOG_REQUESTS !== "0", trustProxy: env.TRUST_PROXY === "1", metricsToken: env.METRICS_TOKEN || null }))
      .listen(port, "127.0.0.1", () => console.log(`Indexer + search on http://127.0.0.1:${port} (ledger ${ledger} from block ${startBlock}, ${confirmations} confirmations)${env.SESSION_PUBLIC_KEY ? "" : "\nSESSION_PUBLIC_KEY not set: auditor views are off."}`));
    for (;;) {
      try { await indexer.syncAll(); } catch (e) { console.error("sync failed, retrying:", e.shortMessage || e.message); }
      await new Promise((r) => setTimeout(r, Number(env.POLL_MS || 2000)));
    }
  })();
}

module.exports = { openDb, applyLogs, rebuild, createIndexer, createApi, findDeployBlock, ftsQuery, effective, report, alerts, sample, RULES, CATS };
