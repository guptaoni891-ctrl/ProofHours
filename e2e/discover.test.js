// Stage 3 discovery end to end on an ISOLATED fork (127.0.0.1:8650) with the real indexer + search API and the
// attendance service running in-process. Drives the real UI without a wallet (discovery is public):
// Ctrl+K search with facets, NGO → directory, volunteer wallets not text-searchable, paste-to-verify for wallets,
// transactions, records, badges and V1 links, public passport, opportunities directory filters, suspended NGO hidden.
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, nav, sleep, waitText } = L;
const { deployV2 } = require("./v2.test");
const att = require("../server/attendance");
const idx = require("../server/indexer");

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8650";
const [ATT_PORT, IDX_PORT] = [8793, 8794];
const click = (p, sel) => p.$eval(sel, (e) => e.click());

async function run(base) {
  const C = L.loadConfig();
  const live = new ethers.Contract(L.LIVE.address, C.abi, new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true }));
  const liveBefore = Number(await live.recordCount());
  const proc = spawn(ANVIL, ["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8650", "--silent"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(FORK, 31337, { staticNetwork: true, cacheTimeout: -1 }); // no call cache: quick consecutive txs need fresh nonces
  let b, servers = [];
  try {
    for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }
    group("Discovery: setup on the isolated fork");
    const forkBlock = await provider.getBlockNumber();
    const d = await deployV2(provider, C);
    const [coordA, coordB, vol] = [0, 1, 2].map(() => ethers.Wallet.createRandom().connect(provider));
    for (const w of [coordA, coordB, vol]) await provider.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await (await d.ledger.registerOrg("Green Shores NGO (demo)", L.ADMIN, 500)).wait();
    await (await d.ledger.registerOrg("Desert Bloom NGO (demo)", L.ADMIN, 500)).wait();
    await (await d.ledger.setCoordinator(coordA.address, 1)).wait();
    await (await d.ledger.setCoordinator(coordB.address, 2)).wait();
    await (await d.ledger.connect(vol).optIn()).wait();
    const today = Math.floor((await provider.getBlock("latest")).timestamp / 86400);
    for (const [w, code, cat] of [[coordA, "EVT-401 Mangrove Planting (demo)", 0], [coordA, "EVT-402 Reading Club (demo)", 1], [coordB, "EVT-403 Desert Clinic (demo)", 2]])
      await (await d.ledger.connect(w).createEvent(code, cat, 12, today)).wait();
    const issue = await (await d.ledger.connect(coordA).issueHours(1, vol.address, 10, ethers.id("demo evidence"))).wait();

    const attDb = att.openDb(":memory:");
    const secret = ethers.hexlify(ethers.randomBytes(32));
    servers.push(http.createServer(att.createApp({ db: attDb, chain: att.ledgerChain(FORK, d.addresses.ledger, 31337), secret, chainId: 31337 })));
    const idxDb = idx.openDb(":memory:");
    const indexer = idx.createIndexer({ db: idxDb, provider, ledger: d.addresses.ledger, startBlock: forkBlock + 1, confirmations: 0 });
    await indexer.syncAll();
    servers.push(http.createServer(idx.createApi({ db: idxDb, indexer, provider, confirmations: 0 })));
    await Promise.all(servers.map((s, i) => new Promise((r) => s.listen([ATT_PORT, IDX_PORT][i], "127.0.0.1", r))));
    // shifts, created through the attendance API with the coordinators' own signatures
    const A = `http://127.0.0.1:${ATT_PORT}`;
    const call = (m, p, token, body) => fetch(A + p, { method: m, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body && JSON.stringify(body) }).then((r) => r.json());
    const signIn = async (w) => { const n = await call("POST", "/auth/nonce", null, { address: w.address }); return (await call("POST", "/auth", null, { address: w.address, nonce: n.nonce, signature: await w.signMessage(n.message) })).token; };
    const [tA, tB, tV] = [await signIn(coordA), await signIn(coordB), await signIn(vol)];
    const now = Math.floor(Date.now() / 1000);
    await call("POST", "/shifts", tA, { eventId: 1, start: now + 3600, end: now + 4 * 3600, capacity: 3, site: { lat: 25.2, lng: 55.27, radius: 150 } });
    const full = await call("POST", "/shifts", tA, { eventId: 2, start: now - 600, end: now + 2 * 3600, capacity: 1 });
    await call("POST", "/shifts", tB, { eventId: 3, start: now + 7200, end: now + 5 * 3600, capacity: 4 });
    const qr = await call("GET", `/shifts/${full.id}/qr?kind=in`, tA);
    await call("POST", "/checkin", tV, { token: qr.token });
    const health = await fetch(`http://127.0.0.1:${IDX_PORT}/health`).then((r) => r.json());
    check("indexer caught up: 2 NGOs, 3 events; 3 shifts published", health.orgs === 2 && health.events === 3 && health.behind === 0, JSON.stringify(health));

    b = await L.launch();
    const url = `${base}?local&rpc=${FORK}&api=${A}&search=http://127.0.0.1:${IDX_PORT}`;
    const p = await L.openPage(b, url); // no wallet: discovery is public
    await nav(p, "verify", 800);

    group("Ctrl+K search");
    await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control");
    await sleep(600);
    check("Ctrl+K opens the search dialog with the input focused", await p.$eval("#omni", (d) => d.open && document.activeElement.id === "omniQ"));
    const type = async (q) => { await p.$eval("#omniQ", (i) => (i.value = "")); await p.type("#omniQ", q); await sleep(900); return txt(p, "#omniResults"); };
    let r = await type("mangr");
    check("prefix search 'mangr' finds the event, with its area and NGO", /EVT-401 Mangrove Planting \(demo\)[\s\S]*Green Shores NGO \(demo\)/.test(r), r);
    check("footer reports measured search time", /search [\d.]+ ms · round trip \d+ ms/.test(await txt(p, "#omniFoot")), await txt(p, "#omniFoot"));
    r = await type("demo");
    check("facets count the match: All 3, Environmental 1, Education 1, Healthcare 1", /All events 3[\s\S]*Environmental 1[\s\S]*Education 1[\s\S]*Healthcare 1/.test(await txt(p, "#omniFacets")), await txt(p, "#omniFacets"));
    await click(p, '#omniFacets [data-cat="2"]');
    await sleep(900);
    r = await txt(p, "#omniResults");
    check("Healthcare facet → only the Desert Clinic event", /EVT-403 Desert Clinic/.test(r) && !/Mangrove|Reading/.test(r), r);
    await click(p, '#omniFacets [data-cat=""]');
    r = await type(vol.address.slice(0, 12));
    check("a partial volunteer wallet finds nothing (wallets are never in the search index)", /No NGOs or events match/.test(r), r);
    r = await type("desert bloom");
    check("NGO names are searchable", /NGO[\s\S]*Desert Bloom NGO \(demo\)[\s\S]*See its shifts/.test(r), r);
    await click(p, "#omniResults button.omni-item");
    await sleep(2500);
    r = await txt(p, "#opList");
    check("NGO result → Opportunities filtered to that NGO", !(await p.$eval("#opps", (s) => s.hidden)) && /EVT-403 Desert Clinic/.test(r) && !/Mangrove|Reading/.test(r), r);

    group("Paste-to-verify (read from the chain)");
    const paste = async (q) => { await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control"); await sleep(300); await p.$eval("#omniQ", (i, v) => { i.value = v; i.dispatchEvent(new Event("input")); }, q); await sleep(2500); return txt(p, "#omniResults"); };
    r = await paste(vol.address);
    check("full wallet → 10h verified, 2 soulbound badges", new RegExp(`Wallet ${vol.address.slice(0, 6)}[\\s\\S]*10h verified in V2 · 2 soulbound badges[\\s\\S]*Open public passport`).test(r), r);
    await click(p, "#omniResults button.omni-item");
    await sleep(3500);
    check("public passport: titled as such, banner names the wallet, 10h, no opt-in or V1-link forms", (await txt(p, "#pageTitle")) === "Public passport" && /Public passport of/.test(await txt(p, "#ppPublic")) && /Verified hours\s*10\b/.test(await txt(p, "#ppSummary")) && (await p.$eval("#v1LinkForm", (f) => f.hidden)) && (await p.$eval("#ppOptForm button", (x) => x.hidden)), await txt(p, "#ppPublic"));
    check("public passport shows the real badges", (await p.$$eval("#ppVault .trophy:not(.goal) img", (x) => x.length)) === 2);
    await L.shot(p, "v2-public-passport");
    r = await paste(issue.hash);
    check("transaction hash → succeeded + 'Record #1: 10h Environmental'", /succeeded in block[\s\S]*Record #1: 10h Environmental/.test(r), r);
    r = await paste("record 1");
    check("'record 1' → V2 record #1 · Valid · 10h Environmental", /V2 record #1 · Valid[\s\S]*10h Environmental[\s\S]*Green Shores/.test(r), r);
    r = await paste("badge 1");
    check("'badge 1' → held, soulbound", /Badge #1 ·[\s\S]*Held by[\s\S]*locked: true/.test(r), r);
    r = await paste("badge 99");
    check("'badge 99' → not held (never minted or burned)", /Badge #99 · not held/.test(r), r);
    const demo = L.loadDemo()[0];
    r = await paste(`${url}#id=${demo.id}&salt=${demo.salt}`);
    check("V1 verification link → recognised", new RegExp(`V1 verification link · student ${demo.id}`).test(r), r);
    await click(p, "#omniResults button.omni-item");
    check("…and opens the V1 check on the forked V1 contract", await waitText(p, "#verifyOut", /verified hours|CORRECTED|VALID/i, 20000), await txt(p, "#verifyOut"));

    group("Opportunities directory");
    await p.evaluate(() => history.replaceState(null, "", location.pathname + location.search));
    await nav(p, "opps", 2500);
    await click(p, "#opEvent").catch(() => {}); // clear the event filter if one is set
    await p.select("#opOrg", "");
    await p.$eval("#opOrg", (s) => s.dispatchEvent(new Event("change")));
    await sleep(500);
    r = await txt(p, "#opList");
    check("all three upcoming shifts, with spots", /3 of 3 spots left/.test(r) && /Full/.test(r) && /4 of 4 spots left/.test(r) && (await p.$$eval("#opList .op", (x) => x.length)) === 3, r);
    check("area facets with counts", /All areas 3[\s\S]*Environmental 1[\s\S]*Education 1[\s\S]*Healthcare 1/.test(await txt(p, "#opCats")), await txt(p, "#opCats"));
    await click(p, "#opOpen");
    await sleep(300);
    check("'only spots left' hides the full shift", (await p.$$eval("#opList .op", (x) => x.length)) === 2 && !/Full/.test(await txt(p, "#opList")));
    check("Education facet is disabled with 0 while 'spots left' is on (its only shift is full)", await p.$eval('#opCats [data-cat="1"]', (x) => x.disabled && /Education 0/.test(x.innerText)));
    await click(p, "#opOpen");
    await sleep(300);
    await click(p, '#opCats [data-cat="1"]');
    await sleep(300);
    check("Education → the Reading Club shift", /EVT-402 Reading Club/.test(await txt(p, "#opList")) && (await p.$$eval("#opList .op", (x) => x.length)) === 1);
    await click(p, '#opCats [data-cat=""]');
    await L.shot(p, "v2-opportunities");
    await p.setViewport({ width: 375, height: 812 });
    await sleep(500);
    check("directory at 375px: no sideways scrolling", !(await L.overflow(p)));
    await p.setViewport({ width: 1366, height: 900 });
    await (await d.ledger.suspendOrg(2)).wait(); // governance (fork deployer) suspends Desert Bloom
    await nav(p, "verify", 300);
    await nav(p, "opps", 2500);
    check("a suspended NGO's shifts disappear from the directory", !/Desert Clinic/.test(await txt(p, "#opList")) && (await p.$$eval("#opList .op", (x) => x.length)) === 2, await txt(p, "#opList"));
    check("no JavaScript errors", p.__errors.length === 0, p.__errors.join("; "));
  } finally {
    await b?.close();
    servers.forEach((s) => s.close());
    proc.kill();
  }
  group("Public Base Sepolia untouched");
  check(`V1 record count unchanged (${liveBefore})`, Number(await live.recordCount()) === liveBefore);
}

module.exports = { run };
