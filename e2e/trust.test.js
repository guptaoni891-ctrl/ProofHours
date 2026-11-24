// Stage 5 end to end on an ISOLATED fork (127.0.0.1:8652) with the attendance service and the indexer in-process,
// sharing one session secret. Real signatures throughout:
// private profile (visibility, share link, erasure) · Open Badges 3.0 credential issued, verified, then revoked by a
// correction · printable transcript · NGO impact report matching the chain · auditor console: alerts are allegations
// that change nothing, case notes, "NGO suspended" refused until the auditor's wallet suspends on-chain, reproducible sample.
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, nav, sleep, waitText, submit } = L;
const { deployV2 } = require("./v2.test");
const att = require("../server/attendance");
const idx = require("../server/indexer");

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8652";
const [ATT_PORT, IDX_PORT] = [8796, 8797];
const DEPLOYER = "0x0000000000000000000000000000000050000001";
const click = (p, sel) => p.$eval(sel, (e) => e.click());

async function run(base) {
  const C = L.loadConfig();
  const live = new ethers.Contract(L.LIVE.address, C.abi, new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true }));
  const liveBefore = Number(await live.recordCount());
  const proc = spawn(ANVIL, ["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8652", "--silent"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(FORK, 31337, { staticNetwork: true, cacheTimeout: -1 });
  let b, servers = [];
  try {
    for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }
    group("Trust: setup on the isolated fork");
    const forkBlock = await provider.getBlockNumber();
    const d = await deployV2(provider, C);
    const [coord, vol, auditor] = [0, 1, 2].map(() => ethers.Wallet.createRandom().connect(provider));
    for (const w of [coord, vol, auditor]) await provider.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await (await d.ledger.registerOrg("Green Shores NGO (demo)", DEPLOYER, 500)).wait();
    await (await d.ledger.setCoordinator(coord.address, 1)).wait();
    await (await d.ledger.grantRole(await d.ledger.AUDITOR_ROLE(), auditor.address)).wait();
    await (await d.ledger.connect(vol).optIn()).wait();
    const today = Math.floor((await provider.getBlock("latest")).timestamp / 86400);
    await (await d.ledger.connect(coord).createEvent("EVT-701 Coastal Survey (demo)", 0, 12, today)).wait();
    await (await d.ledger.connect(coord).issueHours(1, vol.address, 12, ethers.id("demo evidence"))).wait();
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const attDb = att.openDb(":memory:"), keysDb = new DatabaseSync(":memory:");
    servers.push(http.createServer(att.createApp({ db: attDb, keysDb, chain: att.ledgerChain(FORK, d.addresses.ledger, 31337, d.addresses.badges), secret, chainId: 31337, publicUrl: `http://127.0.0.1:${ATT_PORT}` })));
    const idxDb = idx.openDb(":memory:");
    const indexer = idx.createIndexer({ db: idxDb, provider, ledger: d.addresses.ledger, startBlock: forkBlock + 1, confirmations: 0 });
    await indexer.syncAll();
    servers.push(http.createServer(idx.createApi({ db: idxDb, indexer, provider, confirmations: 0, ledger: d.addresses.ledger, secret })));
    await Promise.all(servers.map((s, i) => new Promise((r) => s.listen([ATT_PORT, IDX_PORT][i], "127.0.0.1", r))));
    const key = (k, t) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8", "uint16"], [vol.address, k, t]));
    const tok = await d.badges.tokenOfKey(key(0, 10));
    check("12h issued, 10h badges minted, auditor role granted, services up", tok !== 0n && (await d.ledger.hasRole(await d.ledger.AUDITOR_ROLE(), auditor.address)));

    b = await L.launch();
    const url = `${base}?local&rpc=${FORK}&api=http://127.0.0.1:${ATT_PORT}&search=http://127.0.0.1:${IDX_PORT}`;
    const p = await L.openPage(b, url, { wallet: L.signingWallet, args: [[vol.privateKey, auditor.privateKey], FORK, FORK] });
    await p.evaluate(() => { localStorage.clear(); window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });

    group("Private profile");
    await nav(p, "passport", 5000);
    check("profile panel offered on your own passport", !(await p.$eval("#profileForm", (f) => f.hidden)));
    await p.evaluate(() => {
      const set = (id, v) => (document.getElementById(id).value = v);
      set("pfName", "Aisha (demo)"); set("pfNameVis", "public"); set("pfSchool", "Demo University"); set("pfSchoolVis", "link"); set("pfBio", "Weekend beach cleanups (demo)."); set("pfBioVis", "private");
    });
    let m = await submit(p, "profileForm");
    check("save → 'Profile saved, encrypted'", /Profile saved, encrypted/.test(m), m);
    check("stored encrypted: no name in the service database", !JSON.stringify(attDb.prepare("SELECT * FROM profiles").all().map((r) => Buffer.from(r.data).toString("latin1"))).includes("Aisha"));
    const linkKey = attDb.prepare("SELECT link_key FROM profiles").get().link_key;

    group("Open Badges 3.0 credential");
    await click(p, `#ppVault [data-cred="${tok}"]`);
    check("credential issued with a download", await waitText(p, "#vaultForm .msg", /Open Badges 3\.0 credential issued for badge #/), await txt(p, "#vaultForm .msg"));
    const jwt = await p.$eval("#credDl", (a) => a.dataset.jwt);
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
    check("VC-JWT: OpenBadgeCredential for did:pkh of the wallet, 10h total", payload.vc.type.includes("OpenBadgeCredential") && payload.sub === `did:pkh:eip155:31337:${vol.address}` && payload.vc.credentialSubject.achievement.name === "10h total");

    group("Transcript");
    await click(p, "#ppPrint");
    await sleep(500);
    const tr = await txt(p, "#transcriptView");
    check("print view: title, profile name, total, record, badge, verification link and QR", (await p.evaluate(() => window.__printed)) === 1 && /Co-curricular volunteering transcript/.test(tr) && /Aisha \(demo\)/.test(tr) && /Verified hours: 12/.test(tr) && /EVT-701 Coastal Survey \(demo\)/.test(tr) && /10h total \(token #/.test(tr) && (await p.$eval("#transcriptView .tr-qr svg", () => true)), tr.slice(0, 200));
    await p.evaluate(() => window.dispatchEvent(new Event("afterprint")));

    group("Verify a credential, then revoke it through the chain");
    await nav(p, "verify", 800);
    await p.$eval("#credJwt", (t, v) => (t.value = v), jwt);
    m = await submit(p, "credForm");
    check("valid: signature, issuer, OB3 structure, badge still held", /Valid credential[\s\S]*Signature matches[\s\S]*Issued by this ProofHours deployment[\s\S]*Open Badges 3\.0 structure[\s\S]*Not revoked/.test(m), m);
    await (await d.ledger.connect(coord).correct(1, 8, ethers.encodeBytes32String("TYPO_FIX"))).wait(); // below 10h: badge burned
    m = await submit(p, "credForm");
    check("after a correction below 10h → 'Not valid · Revoked'", /Not valid[\s\S]*Revoked: the badge is no longer held/.test(m), m);
    await p.$eval("#credJwt", (t, v) => (t.value = v), jwt.slice(0, -4) + "AAAA");
    m = await submit(p, "credForm");
    check("tampered signature → not valid", /Not valid[\s\S]*✗ Signature/.test(m), m);

    group("Shared profile on a public passport");
    const ctx = await b.createBrowserContext();
    let pub = await L.openPage(ctx, `${url}#passport=${vol.address}&k=${linkKey}`);
    await sleep(3500);
    let view = await txt(pub, "#ppProfileView");
    check("share link shows public + link fields, never private", /Aisha \(demo\)/.test(view) && /Demo University/.test(view) && !/beach cleanups/.test(view), view);
    await pub.close();
    pub = await L.openPage(ctx, `${url}#passport=${vol.address}`);
    await sleep(3500);
    view = await txt(pub, "#ppProfileView");
    check("plain public link shows the public field only", /Aisha \(demo\)/.test(view) && !/Demo University/.test(view), view);
    await pub.close();

    group("Erasure");
    await nav(p, "passport", 4000);
    await click(p, "#pfDelete");
    m = await L.confirmCard(p, "profileForm");
    check("delete (after confirming) → 'Profile erased'", /Profile erased/.test(m), m);
    check("data key destroyed and profile row gone", keysDb.prepare("SELECT COUNT(*) AS n FROM keys").get().n === 0 && attDb.prepare("SELECT COUNT(*) AS n FROM profiles").get().n === 0);
    pub = await L.openPage(ctx, `${url}#passport=${vol.address}&k=${linkKey}`);
    await sleep(3500);
    check("the share link now shows no profile", await pub.$eval("#ppProfileView", (x) => x.hidden));
    await ctx.close();

    group("Impact report");
    await indexer.syncAll();
    await nav(p, "reports", 2500);
    m = await submit(p, "reportForm");
    const rep = await txt(p, "#rpOut");
    check("report for Green Shores: 8 verified hours (correction applied), 1 record, 1 corrected", /Report built/.test(m) && /Green Shores NGO \(demo\)/.test(rep) && /8\s*verified hours/.test(rep) && /1\s*records/.test(rep) && /1 \/ 0\s*corrected \/ revoked/.test(rep), rep);
    check("report total equals the ledger", Number(await d.ledger.totalHours(vol.address)) === 8);
    check("CSV download offered", /^blob:/.test(await p.$eval("#rpCsv", (a) => a.href)));

    group("Auditor console");
    await nav(p, "audit", 2500);
    check("volunteer wallet: told it doesn't hold the auditor role", /doesn't hold the auditor role/.test(await txt(p, "#auContext")));
    await p.evaluate(() => window.__setAccount(1));
    await sleep(2500);
    await nav(p, "audit", 2500);
    check("auditor wallet recognised, and the role badge says V2 AUDITOR", /Auditor wallet/.test(await txt(p, "#auContext")) && (await waitText(p, "#rolePill", /^V2 AUDITOR$/)), await txt(p, "#rolePill"));
    await click(p, "#auLoad");
    check("alerts load: 'Large single issuance', labelled an allegation", await waitText(p, "#auAlerts", /Large single issuance · Green Shores NGO \(demo\)[\s\S]*Allegation · needs human review/), await txt(p, "#auAlerts"));
    check("alerts changed nothing on-chain", !(await d.ledger.getOrg(1)).suspended);
    await click(p, "#auAlerts [data-case-subject]");
    check("open a case from the alert", await waitText(p, "#auCases", /Case #1 · alert[\s\S]*Open/), await txt(p, "#auCases"));
    await p.$eval('#auCases [data-note]', (i) => (i.value = "Checked the attendance log for record #1 (demo)."));
    await click(p, '#auCases [data-act="note"]');
    check("note recorded", await waitText(p, "#auCases", /Checked the attendance log/));
    await p.$eval('#auCases [data-note]', (i) => (i.value = "Suspending pending review (demo)."));
    await p.select('#auCases [data-outcome]', "org-suspended");
    await click(p, '#auCases [data-act="close"]');
    check("closing as 'NGO suspended' is refused until the chain shows it", await waitText(p, "#caseForm .msg", /doesn't show this NGO as suspended/));
    await click(p, '#auCases [data-act="suspend"]');
    m = await L.confirmCard(p, "caseForm");
    check("suspend NGO from the auditor wallet (real tx) → 'NGO #1 suspended'", /NGO #1 suspended/.test(m) && (await d.ledger.getOrg(1)).suspended, m);
    check("the suspension tx is linked in the case notes", await waitText(p, "#auCases", /Suspended NGO #1 on-chain[\s\S]*tx/));
    await p.$eval('#auCases [data-note]', (i) => (i.value = "Suspended pending NGO response (demo)."));
    await p.select('#auCases [data-outcome]', "org-suspended");
    await click(p, '#auCases [data-act="close"]');
    check("now the case closes as 'NGO suspended'", await waitText(p, "#auCases", /Closed: NGO suspended/), await txt(p, "#auCases"));
    await p.$eval("#smSeed", (i, s) => (i.value = s), ethers.id("audit seed"));
    await p.select("#smRate", "0.05");
    m = await submit(p, "sampleForm");
    const first = await txt(p, "#smList");
    m = await submit(p, "sampleForm");
    check("spot-audit sample is reproducible from its seed", /Sample: \d+ of 1 records at 5%/.test(m) && first === (await txt(p, "#smList")), m);
    await L.shot(p, "v2-auditor-console");
    await p.setViewport({ width: 375, height: 812 });
    await sleep(500);
    check("auditor console at 375px: no sideways scrolling", !(await L.overflow(p)));
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
