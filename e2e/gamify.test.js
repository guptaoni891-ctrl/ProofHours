// Stage 4 progress end to end on an ISOLATED fork (127.0.0.1:8651) with the attendance service in-process (leagues).
// Real signatures throughout. Proves progress comes only from verified on-chain data: a revocation lowers the level,
// removes the Polymath title and breaks the streak. Also: Arcade/Clean views, badge renounce + reclaim on-chain,
// unlock animation once, opt-in league by alias with leave, public passport defaults to the clean view.
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, nav, sleep, waitText, submit } = L;
const { deployV2 } = require("./v2.test");
const att = require("../server/attendance");

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8651";
const ATT_PORT = 8795;
const DEPLOYER = "0x0000000000000000000000000000000050000001";
const click = (p, sel) => p.$eval(sel, (e) => e.click());

async function run(base) {
  const C = L.loadConfig();
  const live = new ethers.Contract(L.LIVE.address, C.abi, new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true }));
  const liveBefore = Number(await live.recordCount());
  const proc = spawn(ANVIL, ["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8651", "--silent"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(FORK, 31337, { staticNetwork: true, cacheTimeout: -1 });
  let b, api;
  try {
    for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }
    group("Progress: setup on the isolated fork");
    const d = await deployV2(provider, C);
    const [coord, vol, fresh, m1, m2] = [0, 1, 2, 3, 4].map(() => ethers.Wallet.createRandom().connect(provider));
    for (const w of [coord, vol, fresh, m1, m2]) await provider.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await (await d.ledger.registerOrg("QA Progress NGO (demo)", DEPLOYER, 500)).wait();
    await (await d.ledger.setCoordinator(coord.address, 1)).wait();
    for (const w of [vol, fresh, m1, m2]) await (await d.ledger.connect(w).optIn()).wait();
    const today = Math.floor((await provider.getBlock("latest")).timestamp / 86400);
    const L2 = d.ledger.connect(coord);
    // four consecutive weeks of service in three areas: 10 Env (3 weeks ago), 10 Edu (2 weeks), 10 Health (1 week), 2 Env (today)
    for (const [code, cat, day] of [["EVT-501 Mangroves (demo)", 0, today - 21], ["EVT-502 Tutoring (demo)", 1, today - 14], ["EVT-503 Clinic (demo)", 2, today - 7], ["EVT-504 Beach (demo)", 0, today]])
      await (await L2.createEvent(code, cat, 12, day)).wait();
    for (const [ev, h] of [[1, 10], [2, 10], [3, 10], [4, 2]]) await (await L2.issueHours(ev, vol.address, h, ethers.id(`demo ${ev}`))).wait();
    await (await L2.issueHours(4, m1.address, 12, ethers.ZeroHash)).wait();
    await (await L2.issueHours(2, m2.address, 11, ethers.ZeroHash)).wait();
    const db = att.openDb(":memory:");
    api = http.createServer(att.createApp({ db, chain: att.ledgerChain(FORK, d.addresses.ledger, 31337), secret: ethers.hexlify(ethers.randomBytes(32)), chainId: 31337 }));
    await new Promise((r) => api.listen(ATT_PORT, "127.0.0.1", r));
    const A = `http://127.0.0.1:${ATT_PORT}`;
    const call = (m, p, token, body) => fetch(A + p, { method: m, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body && JSON.stringify(body) }).then((r) => r.json());
    const signIn = async (w) => { const n = await call("POST", "/auth/nonce", null, { address: w.address }); return (await call("POST", "/auth", null, { address: w.address, nonce: n.nonce, signature: await w.signMessage(n.message) })).token; };
    for (const w of [m1, m2]) await call("POST", "/league/join", await signIn(w));
    check("32 verified hours in 3 areas over 4 weeks; two other league members joined", Number(await d.ledger.totalHours(vol.address)) === 32 && db.prepare("SELECT COUNT(*) AS n FROM league").get().n === 2);

    b = await L.launch();
    const url = `${base}?local&rpc=${FORK}&api=${A}`;
    const p = await L.openPage(b, url, { wallet: L.signingWallet, args: [[vol.privateKey, fresh.privateKey], FORK, FORK] });
    await p.evaluate(() => localStorage.clear());

    group("Arcade view: level, streak, Polymath, Impact Twin, companion, skill trees");
    await nav(p, "passport", 5000);
    const stats = await txt(p, "#ppStats");
    check("Arcade is the default for your own passport", !(await p.$eval("#ppGame", (g) => g.hidden)));
    check("civic level 4 (30h floor), 18h to level 5", /Civic level\s*4[\s\S]*18h to level 5/.test(stats), stats);
    check("weekly streak 4 wk with 1 freeze shield earned", /Weekly streak\s*4 wk[\s\S]*1 freeze shield /.test(stats), stats);
    check("Polymath title (3 of 5 areas at 10h+)", /Polymath\s*Polymath\s*3 of 5 areas/.test(stats), stats);
    check("Impact Twin ≈ $1,156, labelled an estimate and not money", /Impact Twin[\s\S]*estimate[\s\S]*≈ \$1,156[\s\S]*not money earned, paid or owed/.test(stats), stats);
    check("Impact Companion at stage 'Sapling' (level 4)", /Sapling/.test(await txt(p, "#ppCompanion")));
    check("skill trees: first tier reached in Environmental, Education, Healthcare only", JSON.stringify(await p.$$eval("#ppTrees .tree", (t) => t.map((x) => x.querySelectorAll("li.on").length))) === "[1,1,1,0,0]");
    check("First Spark hidden once 10h are reached", await p.$eval("#ppSpark", (x) => x.hidden));

    group("Trophy Vault: unlock animation once, renounce and reclaim on-chain");
    check("5 real badges, all animated as newly unlocked on first view", (await p.$$eval("#ppVault .trophy.unlocked", (x) => x.length)) === 5 && (await p.$$eval("#ppVault .trophy:not(.goal):not(.renounced)", (x) => x.length)) === 5);
    await nav(p, "verify", 300);
    await nav(p, "passport", 4000);
    check("…and not again on the next view", (await p.$$eval("#ppVault .trophy.unlocked", (x) => x.length)) === 0);
    const key = (k, t) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8", "uint16"], [vol.address, k, t]));
    const envTok = await d.badges.tokenOfKey(key(1, 10));
    await click(p, `#ppVault [data-renounce="${envTok}"]`);
    let m = await L.confirmCard(p, "vaultForm");
    check("renounce (after confirming) → 'Badge #… renounced and burned'", new RegExp(`Badge #${envTok} renounced and burned`).test(m), m);
    check("chain: token gone, renounced flag set, hours unchanged", (await d.badges.tokenOfKey(key(1, 10))) === 0n && (await d.badges.renounced(key(1, 10))) && Number(await d.ledger.totalHours(vol.address)) === 32);
    await sleep(2500);
    check("vault shows it as 'Earned · renounced by you' with Reclaim", /10h Environmental\s*Earned · renounced by you/.test(await txt(p, "#ppVault")));
    await click(p, '#ppVault [data-reclaim="1:10"]');
    check("reclaim → two transactions → 'Badge #… minted'", await waitText(p, "#vaultForm .msg", /Badge #\d+ minted/, 60000), await txt(p, "#vaultForm .msg"));
    check("chain: badge minted again, flag cleared", (await d.badges.tokenOfKey(key(1, 10))) !== 0n && !(await d.badges.renounced(key(1, 10))));

    group("Opt-in league");
    await sleep(2500);
    check("league offered, explained as optional, nothing joined yet", /Leagues are optional/.test(await txt(p, "#lgBody")) && db.prepare("SELECT COUNT(*) AS n FROM league").get().n === 2);
    m = await submit(p, "leagueForm");
    check("join → 'You're in this month's league'", /You're in this month's league\. Rank \d of 3/.test(m), m);
    const lg = await txt(p, "#lgBody");
    check("strip shows aliases and hours, marks you, never wallets", /\(you\)/.test(lg) && /Regulars \(10–49h\)/.test(lg) && ![vol, m1, m2].some((w) => lg.toLowerCase().includes(w.address.slice(2, 10).toLowerCase())), lg);
    m = await submit(p, "leagueForm");
    check("leave → 'no longer ranked anywhere', removed from the service", /no longer ranked anywhere/.test(m) && !db.prepare("SELECT 1 FROM league WHERE wallet = ?").get(vol.address), m);

    group("Clean view and a new volunteer");
    await click(p, '#ppMode [data-mode="clean"]');
    check("Clean view hides the game layer, keeps the verified data", (await p.$eval("#ppGame", (g) => g.hidden)) && /Verified hours\s*32/.test(await txt(p, "#ppSummary")));
    await p.reload({ waitUntil: "networkidle0" });
    await nav(p, "passport", 4000);
    check("the choice is remembered", await p.$eval("#ppGame", (g) => g.hidden));
    await click(p, '#ppMode [data-mode="arcade"]');
    await p.evaluate(() => window.__setAccount(1));
    await sleep(4000);
    check("new volunteer: First Spark starts at 1 of 3 (opting in is real progress)", /First Spark\s*1 of 3 done/.test(await txt(p, "#ppSpark")) && !(await p.$eval("#ppSpark", (x) => x.hidden)), await txt(p, "#ppSpark"));
    check("new volunteer: level 1, 0 wk streak, no Impact Twin figure", /Civic level\s*1[\s\S]*Weekly streak\s*0 wk/.test(await txt(p, "#ppStats")) && !/Impact Twin/.test(await txt(p, "#ppStats")));
    await p.setViewport({ width: 375, height: 812 });
    await sleep(500);
    check("passport with progress at 375px: no sideways scrolling", !(await L.overflow(p)));
    await p.setViewport({ width: 1366, height: 900 });

    group("Public passport (fresh browser profile)");
    const ctx = await b.createBrowserContext();
    const pub = await L.openPage(ctx, `${url}#passport=${vol.address}`);
    await sleep(4000);
    check("a direct public passport link loads, in the Clean view by default", (await txt(pub, "#pageTitle")) === "Public passport" && (await pub.$eval("#ppGame", (g) => g.hidden)));
    await click(pub, '#ppMode [data-mode="arcade"]');
    check("Arcade on someone else's passport: progress shown, but no league, quest or renounce controls", !(await pub.$eval("#ppGame", (g) => g.hidden)) && (await pub.$eval("#leagueForm", (f) => f.hidden)) && (await pub.$$eval("[data-renounce], [data-reclaim]", (x) => x.length)) === 0);
    await ctx.close();

    group("Progress follows the chain: a revocation lowers everything");
    await (await L2.revoke(3, ethers.encodeBytes32String("ATTENDANCE_VOID"))).wait();
    await p.evaluate(() => window.__setAccount(0));
    await sleep(5000);
    const after = await txt(p, "#ppStats");
    check("after revoking the 10h Healthcare record: level 3, no Polymath, streak broken to 1 wk (best 2)", /Civic level\s*3/.test(after) && /Polymath\s*—\s*2 of 5/.test(after) && /Weekly streak\s*1 wk[\s\S]*best 2 wk/.test(after), after);
    check("Healthcare tree node switched off", JSON.stringify(await p.$$eval("#ppTrees .tree", (t) => t.map((x) => x.querySelectorAll("li.on").length))) === "[1,1,0,0,0]");
    await L.shot(p, "v2-passport-progress");
    check("no JavaScript errors", p.__errors.length === 0, p.__errors.join("; "));
  } finally {
    await b?.close();
    api?.close();
    proc.kill();
  }
  group("Public Base Sepolia untouched");
  check(`V1 record count unchanged (${liveBefore})`, Number(await live.recordCount()) === liveBefore);
}

module.exports = { run };
