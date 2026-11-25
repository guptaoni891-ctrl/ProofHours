// Release-candidate system journey on an ISOLATED fork (127.0.0.1:8654), all services together:
// the indexer runs as a real child process (`node server/indexer.js`, env config, file database); the attendance service runs
// in-process first (so its clock can jump hours), then restarts as a real child process on the SAME database files.
// Journey: NGO event + shift → volunteer finds it, consents → checks in/out → NGO approves → issueBatch → totals → badges →
// indexer → My Impact → public verifier → auditor evidence → report + transcript. Then: correction, revocation, restarts,
// persistence, RPC failure and unauthorized attempts. Disposable wallets only; nothing touches a public chain.
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, nav, sleep, waitText, submit } = L;
const { deployV2 } = require("./v2.test");
const att = require("../server/attendance");

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8654";
const [ATT, IDX, ATT_DEAD, IDX_DEAD] = [8783, 8785, 8786, 8787];
const DEAD_RPC = "http://127.0.0.1:9"; // nothing listens here: simulates an RPC outage
const DEPLOYER = "0x0000000000000000000000000000000050000001";
const SERVER = path.join(__dirname, "..", "server");
const click = (p, sel) => p.$eval(sel, (e) => e.click());

async function call(port, method, p, token, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function signIn(port, w) {
  const { body: n } = await call(port, "POST", "/auth/nonce", null, { address: w.address });
  return (await call(port, "POST", "/auth", null, { address: w.address, nonce: n.nonce, signature: await w.signMessage(n.message) })).body.token;
}
function startService(file, env) {
  const proc = spawn(process.execPath, [path.join(SERVER, file)], { env: { ...process.env, LOG_REQUESTS: "0", ...env }, stdio: ["ignore", "ignore", "pipe"] });
  proc.stderrText = "";
  proc.stderr.on("data", (c) => (proc.stderrText += c));
  return proc;
}
async function until(fn, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { try { const v = await fn(); if (v) return v; } catch {} }
  return null;
}
const stop = (proc) => new Promise((r) => { if (!proc || proc.exitCode !== null) return r(); proc.once("exit", r); proc.kill(); });

async function run(base) {
  const C = L.loadConfig();
  const live = new ethers.Contract(L.LIVE.address, C.abi, new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true }));
  const liveBefore = Number(await live.recordCount());
  const anvil = spawn(ANVIL, ["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8654", "--silent"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(FORK, 31337, { staticNetwork: true, cacheTimeout: -1 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-journey-"));
  const files = { att: path.join(dir, "attendance.sqlite"), keys: path.join(dir, "vault-keys.sqlite"), idx: path.join(dir, "indexer.sqlite") };
  let b, server, indexer, attProc, deadAtt, deadIdx;
  try {
    for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }
    group("Journey: setup (isolated fork, disposable wallets, real services)");
    const forkBlock = await provider.getBlockNumber();
    const d = await deployV2(provider, C);
    const [coord, vol, auditor, outsider] = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom().connect(provider));
    for (const w of [coord, vol, auditor, outsider]) await provider.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await (await d.ledger.registerOrg("River Trust NGO (demo)", DEPLOYER, 500)).wait();
    await (await d.ledger.setCoordinator(coord.address, 1)).wait();
    await (await d.ledger.grantRole(await d.ledger.AUDITOR_ROLE(), auditor.address)).wait();
    const secret = ethers.hexlify(ethers.randomBytes(32)).slice(2);
    const chainEnv = { RPC_URL: FORK, LEDGER: d.addresses.ledger, BADGES: d.addresses.badges, CHAIN_ID: "31337", ATTENDANCE_SECRET: secret };
    indexer = startService("indexer.js", { ...chainEnv, PORT: String(IDX), CONFIRMATIONS: "0", START_BLOCK: String(forkBlock + 1), POLL_MS: "300", INDEXER_DB: files.idx });
    let clock = Date.now();
    const attDb = att.openDb(files.att), keysDb = new DatabaseSync(files.keys);
    server = http.createServer(att.createApp({ db: attDb, keysDb, chain: att.ledgerChain(FORK, d.addresses.ledger, 31337, d.addresses.badges), secret, chainId: 31337, publicUrl: `http://127.0.0.1:${ATT}`, now: () => clock }));
    await new Promise((r) => server.listen(ATT, "127.0.0.1", r));
    const idxUp = await until(async () => (await call(IDX, "GET", "/health")).body?.indexed != null);
    check("indexer process started from env vars and is syncing; attendance service up", !!idxUp && (await call(ATT, "GET", "/health")).body.ok === true, indexer.stderrText);

    group("1. NGO creates a volunteering opportunity");
    const today = Math.floor((await provider.getBlock("latest")).timestamp / 86400);
    await (await d.ledger.connect(coord).createEvent("EVT-901 River Restoration (demo)", 0, 12, today)).wait();
    let ct = await signIn(ATT, coord);
    const sh = await call(ATT, "POST", "/shifts", ct, { eventId: 1, start: Math.floor(clock / 1000) - 600, end: Math.floor(clock / 1000) + 11 * 3600, capacity: 10 });
    check("event on-chain from the coordinator's wallet; shift #1 created by the NGO's coordinator", sh.status === 200 && sh.body.id === 1, JSON.stringify(sh.body));
    const ot = await signIn(ATT, outsider);
    check("unauthorized: a wallet that coordinates no NGO can't create a shift", (await call(ATT, "POST", "/shifts", ot, { eventId: 1, start: Math.floor(clock / 1000), end: Math.floor(clock / 1000) + 3600, capacity: 5 })).status === 403);

    group("2. Volunteer discovers the opportunity and consents");
    b = await L.launch();
    const url = `${base}?local&rpc=${FORK}&api=http://127.0.0.1:${ATT}&search=http://127.0.0.1:${IDX}`;
    const p = await L.openPage(b, url, { wallet: L.signingWallet, args: [[vol.privateKey], FORK, FORK] });
    await p.evaluate(() => { localStorage.clear(); window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    await nav(p, "opps", 2500);
    check("Opportunities directory lists the shift with spots left", await waitText(p, "#opList", /EVT-901 River Restoration \(demo\)[\s\S]*10 of 10 spots left/), await txt(p, "#opList"));
    const found = await until(async () => (await call(IDX, "GET", "/search?q=river")).body.results.find((r) => r.kind === "event"));
    check("indexer search finds the event ('river')", /EVT-901/.test(found?.title ?? ""), JSON.stringify(found));
    await nav(p, "passport", 4000);
    let m = await submit(p, "ppOptForm");
    check("volunteer opts in on the passport (real signed tx); there is no separate shift sign-up, attendance starts at check-in", await d.ledger.optedIn(vol.address), m);

    group("3. Volunteer checks in and out");
    const qr = async (kind) => (await call(ATT, "GET", `/shifts/1/qr?kind=${kind}`, ct)).body.token;
    const scan = async (token) => { await p.evaluate((t) => { location.hash = "checkin=" + t; }, token); await sleep(1800); return submit(p, "ciForm"); };
    m = await scan(await qr("in"));
    check("check in from the QR code → 'Checked in … Nothing is issued until the coordinator approves'", /Checked in at[\s\S]*Nothing is issued until the coordinator approves/.test(m), m);
    clock += 10 * 3600 * 1000;
    ct = await signIn(ATT, coord);
    m = await scan(await qr("out"));
    check("check out ten hours later → 'About 10h … no hours are issued yet'", /Checked out at[\s\S]*About 10h[\s\S]*no hours are issued yet/.test(m), m);
    check("chain: no hours from check-in and check-out alone", Number(await d.ledger.totalHours(vol.address)) === 0);

    group("4. The authorized NGO approves attendance");
    const [a] = (await call(ATT, "GET", "/shifts/1/attendance", ct)).body;
    const vt = await signIn(ATT, vol);
    check("unauthorized: the volunteer can't list or approve attendance; an outsider can't approve", (await call(ATT, "GET", "/shifts/1/attendance", vt)).status === 403 && (await call(ATT, "POST", `/attendance/${a.id}/approve`, vt)).status === 403 && (await call(ATT, "POST", `/attendance/${a.id}/approve`, await signIn(ATT, outsider))).status === 403);
    const ok = (await call(ATT, "POST", `/attendance/${a.id}/approve`, ct)).body;
    check("coordinator approves 10h; evidence hash = keccak256(evidence JSON)", ok.status === "approved" && ok.hours === 10 && ok.evidenceHash === ethers.id(ok.evidence), JSON.stringify(ok));

    group("5–7. Hours issued on-chain, totals and badges");
    const iss = (await call(ATT, "GET", "/shifts/1/issuable", ct)).body;
    let threw = false;
    try { await d.ledger.connect(outsider).issueBatch.staticCall(iss.eventId, iss.volunteers, iss.hours, iss.evidence); } catch { threw = true; }
    check("unauthorized: an outsider's issueBatch reverts", threw);
    const tx = await d.ledger.connect(coord).issueBatch(iss.eventId, iss.volunteers, iss.hours, iss.evidence);
    await tx.wait();
    check("issueBatch from the coordinator's wallet; the service checks the receipt and marks it issued", (await call(ATT, "POST", "/shifts/1/issued", ct, { txHash: tx.hash })).body.marked === 1 && iss.remaining === 0);
    check("cumulative hours: total 10, Environmental 10", Number(await d.ledger.totalHours(vol.address)) === 10 && Number((await d.ledger.categoryHours(vol.address))[0]) === 10);
    const key = (k, t) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8", "uint16"], [vol.address, k, t]));
    const [tTotal, tEnv] = [await d.badges.tokenOfKey(key(0, 10)), await d.badges.tokenOfKey(key(1, 10))];
    check("badges minted automatically: 10h total + 10h Environmental, held by the volunteer", tTotal !== 0n && tEnv !== 0n && (await d.badges.ownerOf(tTotal)) === vol.address && Number(await d.badges.balanceOf(vol.address)) === 2);
    threw = false;
    try { await d.badges.connect(vol).transferFrom.staticCall(vol.address, outsider.address, tTotal); } catch { threw = true; }
    check("soulbound: the holder can't transfer a badge", threw);

    group("8. The indexer synchronizes");
    let rep = await until(async () => { const r = (await call(IDX, "GET", "/reports/org/1")).body; return r.totalHours === 10 && r; });
    check("indexer report: River Trust NGO, 10 verified hours, 1 record", rep?.org?.name === "River Trust NGO (demo)" && rep.records === 1, JSON.stringify(rep));
    check("indexer health: caught up, no reorgs", await until(async () => { const h = (await call(IDX, "GET", "/health")).body; return h.behind === 0 && h.reorgs === 0; }));

    group("9. My Impact shows hours and achievements");
    await nav(p, "passport", 5000);
    check("passport: verified hours 10", await waitText(p, "#ppSummary", /Verified hours\s*10\b/), await txt(p, "#ppSummary"));
    check("trophy vault shows the two real badges", (await p.$$eval("#ppVault .trophy:not(.goal) img", (x) => x.length)) === 2);

    group("10. Public verifier");
    await (await call(ATT, "PUT", "/profile", vt, { fields: { displayName: "River volunteer (demo)" }, visibility: { displayName: "public" } })).body;
    const cred = (await call(ATT, "POST", "/credentials", vt, { tokenId: String(tTotal) })).body;
    check("unauthorized: an outsider can't get a credential for someone else's badge", (await call(ATT, "POST", "/credentials", await signIn(ATT, outsider), { tokenId: String(tTotal) })).status === 403);
    const ctx = await b.createBrowserContext();
    const pub = await L.openPage(ctx, url); // no wallet: a verifier
    await nav(pub, "verify", 1000);
    await pub.$eval("#credJwt", (t, v) => (t.value = v), cred.jwt);
    m = await submit(pub, "credForm");
    check("verifier (no wallet): credential valid, signature, issuer, OB3 structure, badge still held", /Valid credential[\s\S]*Signature matches[\s\S]*Issued by this ProofHours deployment[\s\S]*Not revoked/.test(m), m);
    await pub.goto(`${url}#passport=${vol.address}`, { waitUntil: "networkidle0" });
    await sleep(3500);
    check("public passport: 10 verified hours and the public display name", /Verified hours\s*10\b/.test(await txt(pub, "#ppSummary")) && /River volunteer \(demo\)/.test(await txt(pub, "#ppProfileView")), await txt(pub, "#ppSummary"));

    group("11. Auditor reviews the evidence");
    const at = await signIn(ATT, auditor);
    check("unauthorized: a volunteer gets 403 from the audit API", (await call(IDX, "GET", "/audit/alerts", vt)).status === 403);
    const alerts = (await call(IDX, "GET", "/audit/alerts", at)).body;
    check("auditor reads alerts (allegations only; nothing changed on-chain)", Array.isArray(alerts) && !(await d.ledger.getOrg(1)).suspended, JSON.stringify(alerts));
    const row = attDb.prepare("SELECT * FROM attendance WHERE id = ?").get(a.id), onchain = await d.ledger.getRecord(1);
    check("evidence: on-chain hash = keccak256(attendance evidence); approver = the coordinator; tx stored", onchain.evidenceHash === ethers.id(row.evidence) && JSON.parse(row.evidence).approvedBy === coord.address && row.tx_hash === tx.hash);
    const kase = (await call(ATT, "POST", "/cases", at, { subject: "Spot check: record #1", orgId: 1, note: "Evidence hash matches the attendance log (demo)." })).body;
    const ex = (await call(ATT, "GET", `/cases/${kase.id}/export`, at)).body;
    check("auditor opens a case and exports a hash-verifiable evidence bundle", ex.sha256?.length === 64 && (await call(ATT, "POST", "/cases", vt, { subject: "x" })).status === 403);

    group("12. Reports and transcripts");
    await nav(p, "reports", 2500);
    m = await submit(p, "reportForm");
    check("impact report page: River Trust NGO, 10 verified hours", /Report built/.test(m) && /10\s*verified hours/.test(await txt(p, "#rpOut")), await txt(p, "#rpOut"));
    await nav(p, "passport", 4000);
    await click(p, "#ppPrint");
    await sleep(600);
    const tr = await txt(p, "#transcriptView");
    check("transcript: verified hours 10, the event, the badge, a QR to the live passport", /Verified hours: 10/.test(tr) && /EVT-901 River Restoration/.test(tr) && /10h total \(token #/.test(tr) && (await p.$eval("#transcriptView .tr-qr svg", () => true)), tr.slice(0, 300));
    await p.evaluate(() => window.dispatchEvent(new Event("afterprint")));

    group("Correction and revocation");
    await (await d.ledger.connect(coord).correct(1, 8, ethers.encodeBytes32String("TYPO_FIX"))).wait();
    check("correction to 8h: total 8, both 10h badges burned", Number(await d.ledger.totalHours(vol.address)) === 8 && Number(await d.badges.balanceOf(vol.address)) === 0);
    let v = (await call(ATT, "POST", "/credentials/verify", null, { jwt: cred.jwt })).body;
    check("verifier now says the credential is revoked", v.valid === false && /^Revoked/.test(v.checks.at(-1).what), JSON.stringify(v.checks));
    await (await d.ledger.connect(coord).createEvent("EVT-902 Riverbank Survey (demo)", 0, 6, today - 1)).wait();
    const r2 = await (await d.ledger.connect(coord).issueHours(2, vol.address, 3, ethers.id("survey evidence (demo)"))).wait();
    await (await d.ledger.connect(coord).revoke(3, ethers.encodeBytes32String("NO_SHOW"))).wait();
    check("revocation: a second record (3h) issued then revoked; total back to 8", r2.status === 1 && Number(await d.ledger.totalHours(vol.address)) === 8);
    rep = await until(async () => { const r = (await call(IDX, "GET", "/reports/org/1")).body; return r.records === 2 && r.revoked === 1 && r; });
    check("indexer report follows: 8 verified hours, 1 corrected, 1 revoked", rep?.totalHours === 8 && rep.corrected === 1, JSON.stringify(rep));

    group("Restart and persistence");
    await new Promise((r) => server.close(r));
    attDb.close(); keysDb.close();
    attProc = startService("attendance.js", { ...chainEnv, PORT: String(ATT), ATTENDANCE_DB: files.att, VAULT_KEYS_DB: files.keys, PUBLIC_URL: `http://127.0.0.1:${ATT}` });
    check("attendance service restarted as a real process on the same database files", !!(await until(async () => (await call(ATT, "GET", "/health")).body?.ok)), attProc.stderrText);
    const vt2 = await signIn(ATT, vol);
    const [mine] = (await call(ATT, "GET", "/me/attendance", vt2)).body;
    check("after restart: the volunteer's attendance is still 'issued', record #1, same tx", mine?.status === "issued" && mine.recordId === "1" && mine.txHash === tx.hash, JSON.stringify(mine));
    check("after restart: the encrypted profile still decrypts (vault keys persisted)", (await call(ATT, "GET", "/profile", vt2)).body.fields?.displayName === "River volunteer (demo)");
    v = (await call(ATT, "POST", "/credentials/verify", null, { jwt: cred.jwt })).body;
    check("after restart: same issuer key (the pre-restart credential's signature and issuer still check out)", v.checks[0].ok && v.checks[1].ok, JSON.stringify(v.checks));
    check("after restart: the shift is still listed", (await call(ATT, "GET", "/shifts/1")).body.id === 1);
    await nav(p, "checkin", 2500);
    await click(p, "#ciMineBtn");
    check("browser, after restart: 'Issued on-chain · record #1' in the volunteer's list", await waitText(p, "#ciMine", /Issued on-chain · record #1/), await txt(p, "#ciMine"));
    await stop(indexer);
    await (await d.ledger.connect(coord).createEvent("EVT-903 Wetland Count (demo)", 0, 6, today - 2)).wait();
    await (await d.ledger.connect(coord).issueHours(3, vol.address, 2, ethers.id("wetland evidence (demo)"))).wait();
    indexer = startService("indexer.js", { ...chainEnv, PORT: String(IDX), CONFIRMATIONS: "0", START_BLOCK: String(forkBlock + 1), POLL_MS: "300", INDEXER_DB: files.idx });
    rep = await until(async () => { const r = (await call(IDX, "GET", "/reports/org/1")).body; return r.records === 3 && r; });
    check("indexer restarted on its database and caught up with blocks mined while it was down (10h total)", rep?.totalHours === 10 && Number(await d.ledger.totalHours(vol.address)) === 10, JSON.stringify(rep));

    group("RPC failure");
    deadAtt = startService("attendance.js", { ...chainEnv, RPC_URL: DEAD_RPC, PORT: String(ATT_DEAD), ATTENDANCE_DB: path.join(dir, "dead.sqlite"), VAULT_KEYS_DB: path.join(dir, "dead-keys.sqlite") });
    deadIdx = startService("indexer.js", { ...chainEnv, RPC_URL: DEAD_RPC, PORT: String(IDX_DEAD), START_BLOCK: "1", INDEXER_DB: path.join(dir, "dead-idx.sqlite") });
    await until(async () => (await call(ATT_DEAD, "GET", "/health")).body?.ok);
    const dc = await signIn(ATT_DEAD, coord);
    const fail = await call(ATT_DEAD, "POST", "/shifts", dc, { eventId: 1, start: Math.floor(Date.now() / 1000), end: Math.floor(Date.now() / 1000) + 3600, capacity: 5 });
    check("attendance with the RPC down: 502 'could not reach the chain', nothing stored, still healthy", fail.status === 502 && /could not reach the chain/.test(fail.body.error) && (await call(ATT_DEAD, "GET", "/health")).body.ok, JSON.stringify(fail));
    const h = await until(async () => (await call(IDX_DEAD, "GET", "/health")).body);
    check("indexer with the RPC down: health reports head unknown; search still answers from its cache", h?.head === null && (await call(IDX_DEAD, "GET", "/search?q=river")).status === 200, JSON.stringify(h));

    check("public Base Sepolia V1 untouched (record count unchanged)", Number(await live.recordCount()) === liveBefore);
    check("no JavaScript errors", p.__errors.length + pub.__errors.length === 0, [...p.__errors, ...pub.__errors].join("; "));
    await ctx.close();
  } finally {
    await b?.close();
    server?.close();
    await Promise.all([indexer, attProc, deadAtt, deadIdx].map(stop));
    anvil.kill();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

module.exports = { run };
