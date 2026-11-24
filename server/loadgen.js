// Load test: node server/loadgen.js [concurrency=50]
// Runs the real indexer search API and the real attendance service in this process, seeded with fictional data and a
// fake in-memory chain (so the numbers measure the services, not a public RPC), and drives them with concurrent clients
// over HTTP on localhost. Prints a Markdown table: throughput, latency percentiles and errors per scenario.
"use strict";
const http = require("node:http");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { ethers } = require("ethers");
const idx = require("./indexer");
const att = require("./attendance");

const CONC = Number(process.argv[2] || 50);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => r(s)); });
// setup work in batches of CONC, so seeding never opens more connections than the scenarios do
const batched = async (arr, fn) => { const out = []; for (let i = 0; i < arr.length; i += CONC) out.push(...(await Promise.all(arr.slice(i, i + CONC).map(fn)))); return out; };

// total requests spread over CONC workers; job(i) returns a fetch promise
async function load(name, total, job) {
  const lat = [];
  let errors = 0, next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < total) {
      const i = next++, s = performance.now();
      try { const r = await job(i); if (!r.ok) errors++; await r.arrayBuffer(); } catch { errors++; }
      lat.push(performance.now() - s);
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  return { name, total, secs, rps: total / secs, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), errors };
}

(async () => {
  // --- indexer with 10,000 events ---
  const db = idx.openDb(":memory:");
  const ins = db.prepare("INSERT INTO logs (block, log_index, block_hash, tx, name, args, ts) VALUES (?, 0, '0x', '0x', ?, ?, 0)");
  const words = ["mangrove", "beach", "reading", "clinic", "reef", "garden", "library", "shelter", "tutoring", "relief"];
  db.exec("BEGIN");
  for (let i = 1; i <= 200; i++) ins.run(i, "OrgRegistered", JSON.stringify({ orgId: i, name: `${words[i % 10]} NGO ${i} (demo)`, admin: "0x0000000000000000000000000000000000000001" }));
  for (let i = 1; i <= 10000; i++) ins.run(200 + i, "EventCreated", JSON.stringify({ eventId: i, orgId: 1 + (i % 200), category: i % 5, maxHours: 8, serviceDay: 20000, code: `EVT-${i} ${words[i % 10]} ${words[(i * 7) % 10]} (demo)` }));
  db.exec("COMMIT");
  idx.rebuild(db);
  const search = await listen(idx.createApi({ db, indexer: { cursor: () => null, reorgs: () => 0 }, provider: { getBlockNumber: async () => 0 }, confirmations: 0 }));

  // --- attendance service with a fake chain: 1 NGO, 200 upcoming shifts, opted-in volunteers ---
  const now = Math.floor(Date.now() / 1000), day = Math.floor(now / 86400);
  const coord = ethers.Wallet.createRandom();
  const chain = { coordinatorOrg: async (a) => (a === coord.address ? 1 : 0), orgSuspended: async () => false, optedIn: async () => true, event: async () => ({ orgId: 1, maxHours: 12, serviceDay: day }) };
  const adb = att.openDb(":memory:");
  const shiftIns = adb.prepare("INSERT INTO shifts (event_id, org_id, start_at, end_at, capacity, created_by, created_at) VALUES (1, 1, ?, ?, 1000, ?, ?)");
  for (let i = 0; i < 200; i++) shiftIns.run(now - 600, now + 3600 * (2 + (i % 6)), coord.address, now);
  const api = await listen(att.createApp({ db: adb, chain, secret: "load-test-secret", chainId: 31337 }));
  const A = `http://127.0.0.1:${api.address().port}`, S = `http://127.0.0.1:${search.address().port}`;
  const post = (url, body, token) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
  const signIn = async (w) => { const n = await (await post(`${A}/auth/nonce`, { address: w.address })).json(); return (await (await post(`${A}/auth`, { address: w.address, nonce: n.nonce, signature: await w.signMessage(n.message) })).json()).token; };
  const coordTok = await signIn(coord);

  const results = [];
  const q = ["mangr", "beach clinic", "reef", "garden&category=2", "lib", "shelter tutoring"];
  for (let i = 0; i < 100; i++) await fetch(`${S}/search?q=${q[i % 6]}`).then((r) => r.arrayBuffer()); // warm-up
  results.push(await load("Search (10,000 events)", 5000, (i) => fetch(`${S}/search?q=${q[i % q.length]}`)));
  results.push(await load("Opportunities list (200 shifts)", 5000, () => fetch(`${A}/opportunities`)));
  results.push(await load("Health check", 5000, () => fetch(`${A}/health`)));
  // write path: 1,000 fresh wallets each sign in (nonce + signature check) and check in to a shift with a fresh QR code
  const vols = Array.from({ length: 1000 }, () => ethers.Wallet.createRandom());
  const signed = await batched(vols, async (w) => ({ w, n: await (await post(`${A}/auth/nonce`, { address: w.address })).json() }));
  const sigs = await batched(signed, async (x) => ({ ...x, sig: await x.w.signMessage(x.n.message) })); // client-side signing kept out of the timing
  const tokens = [];
  results.push(await load("Wallet sign-in (verify signature, issue session)", sigs.length, async (i) => {
    const r = await post(`${A}/auth`, { address: sigs[i].w.address, nonce: sigs[i].n.nonce, signature: sigs[i].sig });
    const j = await r.clone().json().catch(() => ({}));
    tokens[i] = j.token;
    return r;
  }));
  const qrs = await batched(Array.from({ length: 200 }, (_, s) => s), (s) => fetch(`${A}/shifts/${s + 1}/qr?kind=in`, { headers: { authorization: "Bearer " + coordTok } }).then((r) => r.json()));
  results.push(await load("Check-in (QR check, consent, overlap, capacity, insert)", tokens.length, (i) => post(`${A}/checkin`, { token: qrs[i % 200].token }, tokens[i])));
  search.close();
  api.close();

  const f = (x) => x.toFixed(1);
  console.log(`Load test · ${CONC} concurrent clients · Node ${process.version} · ${os.cpus()[0].model.trim()} · ${os.cpus().length} threads · localhost\n`);
  console.log("| Scenario | Requests | Throughput (req/s) | p50 ms | p95 ms | p99 ms | Errors |\n|---|---|---|---|---|---|---|");
  for (const r of results) console.log(`| ${r.name} | ${r.total} | ${Math.round(r.rps)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${r.errors} |`);
  const checked = adb.prepare("SELECT COUNT(*) AS n FROM attendance").get().n;
  console.log(`\nCheck-ins stored: ${checked} of ${tokens.length}${checked === tokens.length ? " (all)" : ""}.`);
})();
