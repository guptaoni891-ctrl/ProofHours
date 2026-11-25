// V2 end to end on an ISOLATED fork of Base Sepolia (127.0.0.1:8647, chain 31337):
// deploys the V2 suite from the fixed local deployer (same addresses as docs/config.js), then drives the real UI:
// opt-in, event creation, issuance with real signatures, automatic soulbound badges, correction burning a badge,
// daily cap, unauthorized writes, V1 link request + approval by the real V1 issuer wallet, and on-chain checks.
// Also checks that on the default network (Base Sepolia) the V2 screens honestly say V2 is not deployed.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, nav, submit, sleep } = L;

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8647";
const DEPLOYER = "0x0000000000000000000000000000000050000001";
const artifact = (file, name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "out", file, `${name}.json`), "utf8"));

async function deployV2(provider, C) {
  await provider.send("anvil_impersonateAccount", [DEPLOYER]);
  await provider.send("anvil_setBalance", [DEPLOYER, "0x56BC75E2D63100000"]);
  const signer = await provider.getSigner(DEPLOYER);
  const b = artifact("ProofHoursBadges.sol", "ProofHoursBadges"), l = artifact("ProofHoursLedger.sol", "ProofHoursLedger");
  const badges = await (await new ethers.ContractFactory(b.abi, b.bytecode.object, signer).deploy(DEPLOYER)).waitForDeployment();
  const ledger = await (await new ethers.ContractFactory(l.abi, l.bytecode.object, signer).deploy(DEPLOYER, await badges.getAddress(), L.LIVE.address)).waitForDeployment();
  await (await badges.grantRole(await badges.MINTER_ROLE(), await ledger.getAddress())).wait();
  return { badges, ledger, signer, addresses: { badges: await badges.getAddress(), ledger: await ledger.getAddress() }, expected: C.local.v2 };
}

async function run(base) {
  const C = L.loadConfig();
  const b = await L.launch();

  group("V2 on the default network (Base Sepolia): honest 'not deployed' state");
  let p = await L.openPage(b, base);
  for (const [page, notice] of [["passport", "#ppNotice"], ["issue2", "#isNotice"]]) {
    await nav(p, page, 1500);
    check(`${page}: says V2 is not deployed on Base Sepolia, shows no fake data`, /not deployed on Base Sepolia yet/.test(await txt(p, notice)) && (await p.$eval(page === "passport" ? "#ppBody" : "#isBody", (e) => e.hidden)));
  }
  await p.close();

  const live = new ethers.Contract(L.LIVE.address, C.abi, new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true }));
  const liveBefore = Number(await live.recordCount());
  const proc = spawn(ANVIL, ["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8647", "--silent"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(FORK, 31337, { staticNetwork: true });
  try {
    for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }

    group("V2 deployment on the isolated fork");
    const d = await deployV2(provider, C);
    check("deployed at the addresses in config.js (deterministic local deployer)", d.addresses.ledger === d.expected.ledger && d.addresses.badges === d.expected.badges, JSON.stringify(d.addresses));
    const [vol, coord, outsider] = [0, 1, 2].map(() => ethers.Wallet.createRandom());
    for (const w of [vol, coord, outsider]) await provider.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await (await d.ledger.registerOrg("QA Green NGO (demo)", DEPLOYER, 500)).wait();
    await (await d.ledger.setCoordinator(coord.address, 1)).wait();
    await (await d.ledger.setCoordinator(L.ADMIN, 1)).wait(); // the live V1 issuer, so a V1 link can be approved on the fork
    await provider.send("anvil_impersonateAccount", [L.ADMIN]); // fork only: lets the V1 issuer wallet sign here
    await provider.send("anvil_setBalance", [L.ADMIN, "0x8AC7230489E80000"]);
    check("ledger reads the real V1 contract", (await d.ledger.v1()) === L.LIVE.address);
    check("badges declare ERC-5192 and ERC-5484", (await d.badges.supportsInterface("0xb45a3c0e")) && (await d.badges.supportsInterface(ethers.dataSlice(ethers.id("burnAuth(uint256)"), 0, 4))));

    const url = `${base}?local&rpc=${FORK}`;
    p = await L.openPage(b, url, { wallet: L.signingWallet, args: [[vol.privateKey, coord.privateKey, outsider.privateKey], FORK, FORK] });

    group("Volunteer passport: consent");
    await nav(p, "passport", 2500);
    check("passport visible on the local chain, opt-in offered", !(await p.$eval("#ppBody", (e) => e.hidden)) && /Opt in to receive hours/.test(await txt(p, "#ppConsent")));
    let m = await submit(p, "ppOptForm");
    check("opt in → real signed tx, summary from receipt", new RegExp(`${vol.address.slice(0, 6)}… ?.* opted in|opted in`).test(m) && /Confirmed in block/.test(m), m);
    await sleep(1500);
    check("consent now shows 'Receiving hours'", /Receiving hours/.test(await txt(p, "#ppConsent")));
    check("chain: optedIn(vol)", await d.ledger.optedIn(vol.address));

    group("Coordinator: event and issuance");
    await p.evaluate(() => window.__setAccount(1));
    await nav(p, "issue2", 2500);
    check("issuance context names the NGO", /Coordinator for QA Green NGO \(demo\)/.test(await txt(p, "#isContext")), await txt(p, "#isContext"));
    await p.evaluate(() => { document.querySelector("#v2Code").value = "EVT-201 Mangrove Planting (demo)"; document.querySelector("#v2Cat").value = "0"; document.querySelector("#v2Max").value = "12"; });
    m = await submit(p, "v2EventForm");
    check("create V2 event → 'V2 event #1 … created (Environmental, max 12h)'", /V2 event #1 "EVT-201 Mangrove Planting \(demo\)" created \(Environmental, max 12h\)/.test(m), m);
    await p.waitForFunction(() => document.querySelector("#v2IssueEvent").value === "1", { timeout: 15000 }).catch(() => {});
    await p.$eval("#v2Roster", (t, a) => (t.value = `${a}, 10`), vol.address);
    m = await submit(p, "v2IssueForm");
    check("issue 10h → 'Record #1: 10h Environmental'", /Record #1: 10h Environmental/.test(m), m);
    check("chain: totals 10, Environmental 10", Number(await d.ledger.totalHours(vol.address)) === 10 && Number((await d.ledger.categoryHours(vol.address))[0]) === 10);
    const key = (k, t) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8", "uint16"], [vol.address, k, t]));
    const tok10 = await d.badges.tokenOfKey(key(0, 10));
    check("chain: 10h total + 10h Environmental badges minted to the volunteer", tok10 !== 0n && (await d.badges.ownerOf(tok10)) === vol.address && (await d.badges.tokenOfKey(key(1, 10))) !== 0n);

    group("Anti-farming and authorization");
    await p.evaluate(() => { document.querySelector("#v2Code").value = "EVT-202 Same-day (demo)"; document.querySelector("#v2Max").value = "6"; });
    await submit(p, "v2EventForm");
    await p.waitForFunction(() => [...document.querySelectorAll("#v2IssueEvent option")].some((o) => o.value === "2"), { timeout: 15000 }).catch(() => {});
    await p.select("#v2IssueEvent", "2");
    await p.$eval("#v2Roster", (t, a) => (t.value = `${a}, 6`), vol.address);
    let sends = await p.evaluate(() => window.__sends);
    m = await submit(p, "v2IssueForm");
    check("16h on one day → refused before signing (DailyCapExceeded explained)", /16 hours on one day; the limit is 12/.test(m) && (await p.evaluate(() => window.__sends)) === sends, m);
    await p.$eval("#v2Roster", (t) => (t.value = "0x1234, 4"));
    m = await submit(p, "v2IssueForm");
    check("bad roster line → explained, nothing sent", /not a wallet address/.test(m), m);
    await p.$eval("#v2Roster", (t, a) => (t.value = `${a}, 2`), outsider.address);
    m = await submit(p, "v2IssueForm");
    check("issuing to a wallet that never opted in → refused (consent)", /has not opted in/.test(m), m);
    await p.evaluate(() => window.__setAccount(2));
    await sleep(1500);
    await nav(p, "issue2", 2500);
    check("outsider sees 'not a V2 coordinator'", /is not a V2 coordinator/.test(await txt(p, "#isContext")));
    await p.evaluate(() => { document.querySelector("#v2Code").value = "EVT-X (should fail)"; });
    sends = await p.evaluate(() => window.__sends);
    m = await submit(p, "v2EventForm");
    check("outsider create event → refused before signing", /is not a V2 coordinator for any NGO/.test(m) && (await p.evaluate(() => window.__sends)) === sends, m);

    group("Trophy Vault shows the real on-chain badges");
    await p.evaluate(() => window.__setAccount(0));
    await sleep(1200);
    await nav(p, "passport", 4000);
    check("passport total 10h", /Verified hours\s*10\b/.test(await txt(p, "#ppSummary")), await txt(p, "#ppSummary"));
    const vault = await p.$$eval("#ppVault .trophy:not(.goal)", (f) => f.map((x) => ({ t: x.innerText.replace(/\s+/g, " "), img: x.querySelector("img")?.src.slice(0, 26) })));
    check("vault: two earned badges with on-chain SVG art", vault.length === 2 && vault.every((v) => v.img === "data:image/svg+xml;base64,") && vault.some((v) => /10h total/.test(v.t)) && vault.some((v) => /10h Environmental/.test(v.t)), JSON.stringify(vault));
    check("vault: next goals are outlines labelled 'Not earned yet'", /Not earned yet · 15h to go/.test(await txt(p, "#ppVault")));
    check("records list shows record #1, Valid, 10h", /EVT-201 Mangrove Planting \(demo\)[\s\S]*Valid[\s\S]*10h/.test(await txt(p, "#ppRecords")));
    await L.shot(p, "v2-passport-badges");

    group("Correction below the milestone burns the badge");
    await p.evaluate(() => window.__setAccount(1));
    await nav(p, "issue2", 2000);
    await p.evaluate(() => { document.querySelector("#v2FixId").value = "1"; document.querySelector("#v2FixHours").value = "8"; });
    m = await submit(p, "v2CorrectForm");
    check("correct #1 to 8h → 'Record #2 corrects #1 to 8h'", /Record #2 corrects #1 to 8h/.test(m), m);
    check("chain: badges burned (no longer earned), token gone", (await d.badges.tokenOfKey(key(0, 10))) === 0n && (await d.badges.balanceOf(vol.address)) === 0n);

    group("V1 link: volunteer consent, then approval by the real V1 issuer wallet");
    await p.evaluate(() => window.__setAccount(0));
    await nav(p, "passport", 2500);
    await p.$eval("#v1LinkId", (i) => (i.value = "1"));
    m = await submit(p, "v1LinkForm");
    check("volunteer requests link to V1 record #1", /Link to V1 record #1 requested/.test(m), m);
    const q = await L.openPage(b, url, { wallet: L.impersonatingWallet, args: [L.ADMIN, FORK] });
    await nav(q, "issue2", 2500);
    await q.evaluate((w) => { document.querySelector("#v1ApproveWallet").value = w; document.querySelector("#v1ApproveId").value = "1"; document.querySelector("#v1ApproveCat").value = "0"; }, vol.address);
    m = await submit(q, "v1ApproveForm");
    check("V1 issuer approves → 'V1 record #1 imported as #3 (4h)'", /V1 record #1 imported as #3 \(4h\)/.test(m), m);
    await q.close();
    check("chain: total 12h (8 issued + 4 imported from V1), badges re-minted", Number(await d.ledger.totalHours(vol.address)) === 12 && (await d.badges.tokenOfKey(key(0, 10))) !== 0n);
    await nav(p, "passport", 4000);
    check("passport shows the imported record as 'From V1'", /V1 record #1[\s\S]*From V1[\s\S]*4h/.test(await txt(p, "#ppRecords")), await txt(p, "#ppRecords"));
    await L.shot(p, "v2-passport-after-v1-link");
    await p.$eval("#v1LinkId", (i) => (i.value = "1"));
    m = await submit(p, "v1LinkForm");
    check("the same V1 record cannot be claimed again", /already linked/.test(m), m);

    group("Soulbound on-chain");
    const volSigner = vol.connect(provider);
    const tok = await d.badges.tokenOfKey(key(0, 10));
    let blocked = false;
    try { await d.badges.connect(volSigner).transferFrom.staticCall(vol.address, outsider.address, tok); } catch (e) { blocked = /Soulbound/.test(e.message) || e.data === d.badges.interface.getError("Soulbound").selector; }
    check("holder cannot transfer the badge", blocked);
    check("no JavaScript errors", p.__errors.length === 0, p.__errors.join("; "));
    await p.close();
  } finally {
    await b.close();
    proc.kill();
  }
  group("Public Base Sepolia untouched");
  check(`V1 record count unchanged (${liveBefore})`, Number(await live.recordCount()) === liveBefore);
}

module.exports = { run, deployV2 };
