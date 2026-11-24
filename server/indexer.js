// ProofHours V2 indexer + search API (Stage 3). Reads ProofHoursLedger logs into SQLite and serves full-text search
// over public NGO and event data. The chain stays the source of truth: everything here is a derived cache that can be
// dropped and rebuilt. Reorg-safe: it stores the hash of every block it relies on, and on a mismatch rolls back to the
// last block whose hash still matches (a block hash commits to all its ancestors) and replays from there.
// Volunteer wallets are never put in the search index.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const { ethers } = require("ethers");

const CATS = ["Environmental", "Education", "Healthcare", "Emergency response", "Inclusion"];
const ABI = [
  "event OrgRegistered(uint256 indexed orgId, string name, address indexed admin, uint32 dailyIssueCap)",
  "event OrgSuspended(uint256 indexed orgId, address indexed by)",
  "event OrgReinstated(uint256 indexed orgId, address indexed by)",
  "event EventCreated(uint256 indexed eventId, uint256 indexed orgId, uint8 category, uint16 maxHours, uint32 serviceDay, string code)",
];
const iface = new ethers.Interface(ABI);
const TOPICS = [ABI.map((_, i) => iface.fragments[i].topicHash)];
const KEEP_HASHES = 256; // block hashes kept for reorg checks; a deeper reorg triggers a full reindex

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (block INTEGER NOT NULL, log_index INTEGER NOT NULL, block_hash TEXT NOT NULL, tx TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL, PRIMARY KEY (block, log_index));
    CREATE TABLE IF NOT EXISTS orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, admin TEXT NOT NULL, suspended INTEGER NOT NULL, tx TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, category INTEGER NOT NULL, max_hours INTEGER NOT NULL, service_day INTEGER NOT NULL, code TEXT NOT NULL, tx TEXT NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(kind UNINDEXED, ref UNINDEXED, category UNINDEXED, org UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');`);
  return db;
}

// Recomputes orgs, events and the search index from the stored logs.
// shortcut: full rebuild on every change; fine to ~100k logs, switch to incremental updates beyond that
function rebuild(db) {
  db.exec("BEGIN; DELETE FROM orgs; DELETE FROM events; DELETE FROM docs;");
  try {
    const org = db.prepare("INSERT INTO orgs (id, name, admin, suspended, tx) VALUES (?, ?, ?, 0, ?)");
    const susp = db.prepare("UPDATE orgs SET suspended = ? WHERE id = ?");
    const ev = db.prepare("INSERT INTO events (id, org_id, category, max_hours, service_day, code, tx) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const l of db.prepare("SELECT name, args, tx FROM logs ORDER BY block, log_index").all()) {
      const a = JSON.parse(l.args);
      if (l.name === "OrgRegistered") org.run(a.orgId, a.name, a.admin, l.tx);
      else if (l.name === "OrgSuspended" || l.name === "OrgReinstated") susp.run(l.name === "OrgSuspended" ? 1 : 0, a.orgId);
      else if (l.name === "EventCreated") ev.run(a.eventId, a.orgId, a.category, a.maxHours, a.serviceDay, a.code, l.tx);
    }
    const doc = db.prepare("INSERT INTO docs (kind, ref, category, org, title, body) VALUES (?, ?, ?, ?, ?, ?)");
    for (const o of db.prepare("SELECT * FROM orgs").all()) doc.run("org", o.id, null, o.id, o.name, `NGO ${o.suspended ? "suspended" : "active"}`);
    for (const e of db.prepare("SELECT e.*, o.name AS org_name FROM events e LEFT JOIN orgs o ON o.id = e.org_id").all())
      doc.run("event", e.id, e.category, e.org_id, e.code, `${e.org_name ?? ""} ${CATS[e.category] ?? ""} ${new Date(e.service_day * 86400000).toISOString().slice(0, 10)}`);
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
    reorgs++;
    return keep;
  }

  // One step: detect a reorg, then index the next chunk of confirmed blocks. Returns how far it got.
  async function syncOnce() {
    const head = await provider.getBlockNumber(), target = head - confirmations;
    let changed = false, cur = cursor();
    if (cur) {
      const b = await provider.getBlock(cur.number);
      if (!b || b.hash !== cur.hash) { await rollback(); changed = true; cur = cursor(); }
    }
    const from = cur ? cur.number + 1 : startBlock, to = Math.min(target, from + chunk - 1);
    if (to >= from) {
      const tip = await provider.getBlock(to);
      const logs = await provider.getLogs({ address: ledger, fromBlock: from, toBlock: to, topics: TOPICS });
      if ((await provider.getBlock(to))?.hash !== tip.hash) return { head, indexed: cur?.number ?? startBlock - 1, retry: true }; // moved under us
      db.exec("BEGIN");
      try {
        const ins = db.prepare("INSERT OR REPLACE INTO logs (block, log_index, block_hash, tx, name, args) VALUES (?, ?, ?, ?, ?, ?)");
        const blk = db.prepare("INSERT OR REPLACE INTO blocks (number, hash) VALUES (?, ?)");
        for (const l of logs) {
          const p = iface.parseLog(l);
          const args = Object.fromEntries(p.fragment.inputs.map((inp, i) => [inp.name, typeof p.args[i] === "bigint" ? Number(p.args[i]) : p.args[i]]));
          ins.run(l.blockNumber, l.index, l.blockHash, l.transactionHash, p.name, JSON.stringify(args));
          blk.run(l.blockNumber, l.blockHash);
        }
        blk.run(to, tip.hash);
        db.prepare("DELETE FROM blocks WHERE number < ?").run(to - KEEP_HASHES);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      changed ||= logs.length > 0;
    }
    if (changed) rebuild(db);
    return { head, indexed: Math.max(to, (cur?.number ?? startBlock - 1)), behind: Math.max(0, target - to) };
  }

  async function syncAll() { let r; do r = await syncOnce(); while (r.behind > 0 || r.retry); return r; }
  return { syncOnce, syncAll, cursor, reorgs: () => reorgs };
}

// First block where the ledger has code (binary search). Errors count as "no code yet", e.g. history a fork can't serve.
async function findDeployBlock(provider, address) {
  let lo = 0, hi = await provider.getBlockNumber();
  const has = async (n) => { try { return (await provider.getCode(address, n)) !== "0x"; } catch { return false; } };
  if (!(await has(hi))) throw new Error(`No contract at ${address} on this chain.`);
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (await has(mid)) hi = mid; else lo = mid + 1; }
  return lo;
}

// Search terms become prefix queries ("mangr" finds "Mangrove"); punctuation is ignored, so FTS syntax can't be injected.
const ftsQuery = (q) => (String(q).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map((w) => `"${w}"*`).join(" ");

function createApi({ db, indexer, provider, confirmations }) {
  function search(url) {
    const t0 = performance.now();
    const q = ftsQuery(url.searchParams.get("q") ?? ""), cat = url.searchParams.get("category"), org = url.searchParams.get("org");
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const where = q ? "docs MATCH ?" : "1", base = q ? [q] : [];
    const rows = db.prepare(`SELECT kind, ref, category, org, title, body FROM docs WHERE ${where} ${cat !== null && cat !== "" ? "AND category = ?" : ""} ${org ? "AND org = ?" : ""} ORDER BY ${q ? "bm25(docs, 0, 0, 0, 0, 10, 1)" : "kind, ref DESC"} LIMIT ?`)
      .all(...base, ...(cat !== null && cat !== "" ? [Number(cat)] : []), ...(org ? [Number(org)] : []), limit);
    // facet counts describe the text match before the facet filters, so every option shows what picking it would give
    const category = Object.fromEntries(db.prepare(`SELECT category AS k, COUNT(*) AS n FROM docs WHERE ${where} AND kind = 'event' GROUP BY category`).all(...base).map((r) => [r.k, r.n]));
    const orgName = db.prepare("SELECT name FROM orgs WHERE id = ?");
    return {
      results: rows.map((r) => ({ kind: r.kind, id: Number(r.ref), title: r.title, detail: r.body.trim(), category: r.category, orgId: Number(r.org), org: orgName.get(r.org)?.name ?? null })),
      facets: { category },
      tookMs: Math.round((performance.now() - t0) * 100) / 100,
    };
  }

  return async function handle(req, res) {
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET") return reply(405, { error: "Read-only API." });
      if (url.pathname === "/search") return reply(200, search(url));
      if (url.pathname === "/health") {
        const head = await provider.getBlockNumber().catch(() => null), cur = indexer.cursor();
        return reply(200, { head, indexed: cur?.number ?? null, confirmations, behind: head === null || !cur ? null : Math.max(0, head - confirmations - cur.number), reorgs: indexer.reorgs(),
          orgs: db.prepare("SELECT COUNT(*) AS n FROM orgs").get().n, events: db.prepare("SELECT COUNT(*) AS n FROM events").get().n });
      }
      reply(404, { error: "Not found." });
    } catch (e) { console.error(e); reply(500, { error: "Internal error." }); }
  };
}

if (require.main === module) {
  (async () => {
    const env = process.env;
    const chainId = Number(env.CHAIN_ID || 31337), rpc = env.RPC_URL || "http://127.0.0.1:8546";
    const ledger = env.LEDGER || "0xd714101097150109C3b0D8d30451280680ED44bA"; // local deterministic V2 ledger (docs/config.js)
    const confirmations = Number(env.CONFIRMATIONS ?? 2);
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const db = openDb(env.INDEXER_DB || path.join(__dirname, "data", "indexer.sqlite"));
    const startBlock = env.START_BLOCK ? Number(env.START_BLOCK) : await findDeployBlock(provider, ledger);
    const indexer = createIndexer({ db, provider, ledger, startBlock, confirmations });
    const port = Number(env.PORT || 8792);
    http.createServer(createApi({ db, indexer, provider, confirmations })).listen(port, "127.0.0.1", () => console.log(`Indexer + search on http://127.0.0.1:${port} (ledger ${ledger} from block ${startBlock}, ${confirmations} confirmations)`));
    for (;;) {
      try { await indexer.syncAll(); } catch (e) { console.error("sync failed, retrying:", e.shortMessage || e.message); }
      await new Promise((r) => setTimeout(r, Number(env.POLL_MS || 2000)));
    }
  })();
}

module.exports = { openDb, rebuild, createIndexer, createApi, findDeployBlock, ftsQuery, CATS };
