// Indexer tests on a real local chain: plain Anvil (no fork, no network). Needs Foundry's anvil and `forge build` output.
// Reorgs are made with evm_snapshot / evm_revert: the same block numbers get different blocks and hashes.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ethers } = require("ethers");
const { openDb, createIndexer, createApi, findDeployBlock, ftsQuery } = require("./indexer");

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const PORT = 8659;
const artifact = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "out", `${name}.sol`, `${name}.json`), "utf8"));

async function chain(t) {
  const proc = spawn(ANVIL, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  t.after(() => proc.kill());
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 31337, { staticNetwork: true, cacheTimeout: -1 });
  for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const [gov, coord, vol] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i))); // anvil's unlocked dev accounts; no keys handled here
  const b = artifact("ProofHoursBadges"), l = artifact("ProofHoursLedger");
  await provider.send("evm_mine", []); // so the deploy block isn't 0
  const badges = await (await new ethers.ContractFactory(b.abi, b.bytecode.object, gov).deploy(gov.address)).waitForDeployment();
  const ledger = await (await new ethers.ContractFactory(l.abi, l.bytecode.object, gov).deploy(gov.address, await badges.getAddress(), ethers.ZeroAddress)).waitForDeployment();
  await (await badges.grantRole(await badges.MINTER_ROLE(), await ledger.getAddress())).wait();
  await (await ledger.registerOrg("Green Shores NGO (demo)", gov.address, 500)).wait();
  await (await ledger.setCoordinator(coord.address, 1)).wait();
  await (await ledger.connect(vol).optIn()).wait();
  const today = Math.floor(Date.now() / 86400000);
  const event = async (code, cat = 0) => (await ledger.connect(coord).createEvent(code, cat, 6, today)).wait();
  return { provider, ledger, address: await ledger.getAddress(), vol, coord, event, mine: (n = 1) => provider.send("anvil_mine", [ethers.toQuantity(n)]) };
}

test("ftsQuery turns any input into safe prefix terms", () => {
  assert.equal(ftsQuery("Mangr  planting!"), '"mangr"* "planting"*');
  assert.equal(ftsQuery('a" OR 1=1 --'), '"a"* "or"* "1"* "1"*');
  assert.equal(ftsQuery("  "), "");
});

test("indexes NGOs and events, respects confirmations, finds the deploy block", async (t) => {
  const c = await chain(t);
  const db = openDb(":memory:");
  const start = await findDeployBlock(c.provider, c.address);
  assert.ok(start > 0 && (await c.provider.getCode(c.address, start - 1)) === "0x");
  const ix = createIndexer({ db, provider: c.provider, ledger: c.address, startBlock: start, confirmations: 2 });
  await c.event("EVT-201 Mangrove Planting (demo)", 0);
  await ix.syncAll();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0, "the event's block has no confirmations yet");
  await c.mine(2);
  await ix.syncAll();
  assert.deepEqual(db.prepare("SELECT id, code, category FROM events").all().map((r) => ({ ...r })), [{ id: 1, code: "EVT-201 Mangrove Planting (demo)", category: 0 }]);
  assert.equal(db.prepare("SELECT name FROM orgs").get().name, "Green Shores NGO (demo)");
});

test("reorg: replaced blocks are rolled back and replayed; search follows the canonical chain", async (t) => {
  const c = await chain(t);
  const db = openDb(":memory:");
  const ix = createIndexer({ db, provider: c.provider, ledger: c.address, startBlock: await findDeployBlock(c.provider, c.address), confirmations: 0 });
  await c.event("EVT-201 Mangrove Planting (demo)");
  const snap = await c.provider.send("evm_snapshot", []);
  await c.event("EVT-202 Reef Survey (demo)", 0);
  await c.event("EVT-203 Reef Cleanup (demo)", 0);
  await ix.syncAll();
  const api = http.createServer(createApi({ db, indexer: ix, provider: c.provider, confirmations: 0 }));
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  t.after(() => api.close());
  const search = (q, extra = "") => fetch(`http://127.0.0.1:${api.address().port}/search?q=${encodeURIComponent(q)}${extra}`).then((r) => r.json());
  assert.equal((await search("reef")).results.length, 2);
  const before = ix.cursor();

  await c.provider.send("evm_revert", [snap]); // the two Reef blocks are gone
  await c.event("EVT-202 Desert Planting (demo)", 2); // same block number as the old Reef Survey, different block
  await c.mine(2);
  assert.notEqual((await c.provider.getBlock(before.number))?.hash, before.hash, "the chain really reorged");
  await ix.syncAll();
  assert.equal(ix.reorgs(), 1);
  assert.equal((await search("reef")).results.length, 0, "orphaned events are gone");
  const desert = await search("dese");
  assert.deepEqual(desert.results.map((r) => [r.kind, r.id, r.title, r.category, r.org]), [["event", 2, "EVT-202 Desert Planting (demo)", 2, "Green Shores NGO (demo)"]]);
  assert.deepEqual(db.prepare("SELECT id, code FROM events ORDER BY id").all().map((r) => r.code), ["EVT-201 Mangrove Planting (demo)", "EVT-202 Desert Planting (demo)"]);
  for (const l of db.prepare("SELECT block, block_hash FROM logs").all()) assert.equal((await c.provider.getBlock(l.block)).hash, l.block_hash, "every stored log is on the canonical chain");

  // facets: counts for the text match, before the facet filter
  const all = await search("planting");
  assert.deepEqual(all.facets.category, { 0: 1, 2: 1 });
  assert.deepEqual((await search("planting", "&category=2")).results.map((r) => r.id), [2]);
  assert.equal((await search("green")).results[0].kind, "org", "NGO names are searchable");
});

test("volunteer wallets are never indexed or searchable", async (t) => {
  const c = await chain(t);
  const db = openDb(":memory:");
  const ix = createIndexer({ db, provider: c.provider, ledger: c.address, startBlock: await findDeployBlock(c.provider, c.address), confirmations: 0 });
  await c.event("EVT-201 Mangrove Planting (demo)");
  await (await c.ledger.connect(c.coord).issueHours(1, c.vol.address, 4, ethers.ZeroHash)).wait();
  await ix.syncAll();
  const everything = JSON.stringify(db.prepare("SELECT * FROM docs").all()) + JSON.stringify(db.prepare("SELECT * FROM logs").all());
  assert.ok(!everything.toLowerCase().includes(c.vol.address.slice(2, 12).toLowerCase()), "the volunteer's address is stored nowhere");
});
