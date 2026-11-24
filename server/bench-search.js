// Search latency benchmark: node server/bench-search.js [events=10000] [queries=1000]
// Seeds synthetic NGO and event logs (fictional), rebuilds the index through the real code path, serves the real
// search API on localhost and measures it: server-side query time and HTTP round trip, p50/p95/p99.
"use strict";
const http = require("node:http");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { openDb, rebuild, createApi } = require("./indexer");

const EVENTS = Number(process.argv[2] || 10000), QUERIES = Number(process.argv[3] || 1000), ORGS = Math.max(10, Math.round(EVENTS / 50));
const WORDS = ["mangrove", "planting", "beach", "cleanup", "reading", "club", "clinic", "desert", "reef", "survey", "tutoring", "food", "bank", "shelter", "elderly", "visit", "coding", "workshop", "blood", "drive", "flood", "relief", "sign", "language", "garden", "recycling", "mentoring", "first", "aid", "library"];
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = () => WORDS[rnd(WORDS.length)];
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

(async () => {
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO logs (block, log_index, block_hash, tx, name, args) VALUES (?, ?, '0x', '0x', ?, ?)");
  db.exec("BEGIN");
  for (let i = 1; i <= ORGS; i++) ins.run(i, 0, "OrgRegistered", JSON.stringify({ orgId: i, name: `${pick()} ${pick()} NGO ${i} (demo)`, admin: "0x0000000000000000000000000000000000000001" }));
  for (let i = 1; i <= EVENTS; i++) ins.run(ORGS + i, 0, "EventCreated", JSON.stringify({ eventId: i, orgId: 1 + rnd(ORGS), category: rnd(5), maxHours: 1 + rnd(12), serviceDay: 20000 + rnd(400), code: `EVT-${i} ${pick()} ${pick()} (demo)` }));
  db.exec("COMMIT");
  let t = performance.now();
  rebuild(db);
  const rebuildMs = performance.now() - t;

  const server = http.createServer(createApi({ db, indexer: { cursor: () => null, reorgs: () => 0 }, provider: { getBlockNumber: async () => 0 }, confirmations: 0 }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/search?q=`;
  const queries = Array.from({ length: QUERIES }, (_, i) => (i % 4 === 0 ? pick().slice(0, 3) : i % 4 === 1 ? `${pick()} ${pick()}` : i % 4 === 2 ? `${pick()}&category=${rnd(5)}` : pick()));
  for (const q of queries.slice(0, 50)) await fetch(base + q).then((r) => r.json()); // warm-up
  const server_ms = [], trip_ms = [];
  for (const q of queries) {
    t = performance.now();
    const r = await fetch(base + q).then((x) => x.json());
    trip_ms.push(performance.now() - t);
    server_ms.push(r.tookMs);
  }
  server.close();
  const f = (xs) => `p50 ${pct(xs, 50).toFixed(2)} ms · p95 ${pct(xs, 95).toFixed(2)} ms · p99 ${pct(xs, 99).toFixed(2)} ms`;
  console.log(`Search benchmark: ${EVENTS.toLocaleString()} events + ${ORGS} NGOs, ${QUERIES} sequential queries, Node ${process.version}, ${os.cpus()[0].model.trim()}`);
  console.log(`Index rebuild:    ${rebuildMs.toFixed(0)} ms`);
  console.log(`Server query:     ${f(server_ms)}`);
  console.log(`HTTP round trip:  ${f(trip_ms)} (localhost)`);
})();
