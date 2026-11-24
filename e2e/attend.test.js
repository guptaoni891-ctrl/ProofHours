// Stage 2 attendance end to end on an ISOLATED fork (127.0.0.1:8648, chain 31337) with the real attendance service
// running in-process (fake clock, in-memory database). Drives the real UI with real wallet signatures:
// coordinator creates a shift → rotating check-in QR → volunteer checks in (location yes/no) → replayed, forged and
// expired codes refused → nothing issued before approval → check-out QR → approval → issueBatch from the coordinator's
// wallet → service verifies the receipt → 10h on-chain with the attendance evidence hash → soulbound badge minted.
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, nav, submit, sleep, waitText } = L;
const { deployV2 } = require("./v2.test");
const { createApp, openDb, ledgerChain } = require("../server/attendance");

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8648";
const API_PORT = 8791;
const DEPLOYER = "0x0000000000000000000000000000000050000001";
// DOM click: works in background tabs (puppeteer's mouse click waits for a rendered frame, which hidden tabs don't produce)
const click = (p, sel) => p.$eval(sel, (e) => e.click());
const SITE = { lat: 25.2048, lng: 55.2708 }; // a public demo site, not a person's location

async function run(base) {
  const C = L.loadConfig();
  const live = new ethers.Contract(L.LIVE.address, C.abi, new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true }));
  const liveBefore = Number(await live.recordCount());
  const proc = spawn(ANVIL, ["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8648", "--silent"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(FORK, 31337, { staticNetwork: true });
  let b, api;
  try {
    for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }
    group("Attendance: setup on the isolated fork");
    const d = await deployV2(provider, C);
    const [coord, vol, outsider] = [0, 1, 2].map(() => ethers.Wallet.createRandom());
    for (const w of [coord, vol, outsider]) await provider.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await (await d.ledger.registerOrg("QA Attendance NGO (demo)", DEPLOYER, 500)).wait();
    await (await d.ledger.setCoordinator(coord.address, 1)).wait();
    await (await d.ledger.connect(vol.connect(provider)).optIn()).wait();
    const today = Math.floor((await provider.getBlock("latest")).timestamp / 86400);
    await (await d.ledger.connect(coord.connect(provider)).createEvent("EVT-301 Beach Cleanup (demo)", 0, 12, today)).wait();
    let clock = Date.now();
    const db = openDb(":memory:");
    api = http.createServer(createApp({ db, chain: ledgerChain(FORK, d.addresses.ledger, 31337), secret: ethers.hexlify(ethers.randomBytes(32)), chainId: 31337, now: () => clock }));
    await new Promise((r) => api.listen(API_PORT, "127.0.0.1", r));
    check("V2 deployed, NGO + coordinator + opted-in volunteer + event ready; attendance service up", (await fetch(`http://127.0.0.1:${API_PORT}/health`).then((r) => r.json())).ok === true);

    b = await L.launch();
    const url = `${base}?local&rpc=${FORK}&api=http://127.0.0.1:${API_PORT}`;
    const cp = await L.openPage(b, url, { wallet: L.signingWallet, args: [[coord.privateKey], FORK, FORK] });

    group("Coordinator: unified role pill, sign-in, shift");
    check("role pill shows the V2 role (V1: none)", await waitText(cp, "#rolePill", /^V2 COORDINATOR: QA Attendance NGO \(demo\)$/), await txt(cp, "#rolePill"));
    await nav(cp, "attend", 2500);
    check("attendance page names the NGO and the service", /Coordinator for QA Attendance NGO \(demo\)[\s\S]*127\.0\.0\.1:8791/.test(await txt(cp, "#atContext")), await txt(cp, "#atContext"));
    await click(cp, "#atSignIn");
    check("sign-in = one free message signature, no transaction", (await waitText(cp, "#shiftList", /No shifts yet/)) && (await cp.evaluate(() => [window.__signs, window.__sends])).join() === "1,0");
    await cp.evaluate((s, e, site) => {
      const local = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      document.querySelector("#shEvent").value = "1";
      document.querySelector("#shStart").value = local(s);
      document.querySelector("#shEnd").value = local(e);
      document.querySelector("#shCap").value = "5";
      Object.entries({ shLat: site.lat, shLng: site.lng, shRadius: 200 }).forEach(([id, v]) => (document.getElementById(id).value = v));
    }, clock - 10 * 60000, clock + 11 * 3600000, SITE);
    let m = await submit(cp, "shiftForm");
    check("create shift → 'Shift #1 created'", /Shift #1 created/.test(m), m);
    check("shift listed with capacity and site area", /Shift #1 · EVT-301 Beach Cleanup \(demo\)[\s\S]*0\/5 attending · site area set/.test(await txt(cp, "#shiftList")), await txt(cp, "#shiftList"));
    await click(cp, '[data-shift="1"] [data-qr="in"]');
    await cp.waitForFunction(() => document.querySelector("#qrLink")?.dataset.link, { timeout: 10000 }).catch(() => {});
    const inLink = await cp.$eval("#qrLink", (a) => a.dataset.link);
    const inToken = inLink.split("#checkin=")[1];
    check("check-in QR rendered as SVG for a link that carries this page's network settings", (await cp.$eval("#qrBox svg path", (p) => p.getAttribute("d").length > 500)) && inLink.startsWith(url) && /^1\.in\.\d+\.[\w-]+$/.test(inToken), inLink);
    await L.shot(cp, "v2-attendance-qr");

    group("Volunteer: check in from the code");
    await b.defaultBrowserContext().overridePermissions(new URL(base).origin, ["geolocation"]);
    const vp = await L.openPage(b, inLink, { wallet: L.signingWallet, args: [[vol.privateKey, outsider.privateKey], FORK, FORK] });
    await vp.setGeolocation({ latitude: SITE.lat + 0.0005, longitude: SITE.lng }); // ~55 m from the site centre
    check("link opens the check-in page with the shift and event", (await txt(vp, "#ciTitle")) === "Check in" && /EVT-301 Beach Cleanup \(demo\)[\s\S]*Shift #1/.test(await txt(vp, "#ciShift")), await txt(vp, "#ciShift"));
    check("role pill: V2 VOLUNTEER", await waitText(vp, "#rolePill", /^V2 VOLUNTEER$/), await txt(vp, "#rolePill"));
    check("location consent offered (site area set), unticked by default", await vp.$eval("#ciGeo", (c) => !c.checked && !c.closest("label").hidden));
    await click(vp, "#ciGeo");
    m = await submit(vp, "ciForm");
    check("check in → 'Checked in … Nothing is issued until the coordinator approves'", /Checked in at[\s\S]*Nothing is issued until the coordinator approves/.test(m), m);
    let row = db.prepare("SELECT * FROM attendance").get();
    check("service stored: checked_in, at site = yes, and no coordinates anywhere", row?.status === "checked_in" && row.in_site === 1 && !JSON.stringify(db.prepare("SELECT * FROM attendance").all()).includes("55.27"), JSON.stringify(row));
    const setHash = (p, token) => p.evaluate((t) => { location.hash = "checkin=" + t; }, token).then(() => sleep(1500));
    await setHash(vp, inToken);
    m = await submit(vp, "ciForm");
    check("replaying the same code → 'already checked in'", /already checked in/.test(m), m);
    const forged = inToken.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    await setHash(vp, forged);
    m = await submit(vp, "ciForm");
    check("forged code → 'not valid'", /not valid/.test(m), m);
    await vp.evaluate(() => window.__setAccount(1));
    await sleep(1500);
    await setHash(vp, inToken);
    m = await submit(vp, "ciForm");
    check("wallet that never opted in → refused (consent)", /Opt in on your passport first/.test(m), m);
    await vp.evaluate(() => window.__setAccount(0));
    clock += 70 * 1000;
    await sleep(1200);
    await setHash(vp, inToken);
    m = await submit(vp, "ciForm");
    check("code older than its window → 'expired'", /expired/.test(m), m);
    check("chain: no hours from check-in alone", Number(await d.ledger.totalHours(vol.address)) === 0);

    group("Check-out, review, approval");
    clock += 10 * 3600 * 1000; // ten hours later (service clock); sign-ins expire and are renewed automatically
    await cp.bringToFront(); // waits poll on animation frames, which only the front tab renders
    await click(cp, '[data-shift="1"] [data-qr="out"]');
    await cp.waitForFunction((old) => document.querySelector("#qrLink").dataset.link.includes(".out."), { timeout: 15000 }, inLink).catch(() => {});
    const outLink = await cp.$eval("#qrLink", (a) => a.dataset.link);
    check("check-out QR is a new, different code", /#checkin=1\.out\.\d+\./.test(outLink), outLink);
    await vp.bringToFront();
    await setHash(vp, outLink.split("#checkin=")[1]);
    if (!(await vp.$eval("#ciGeo", (c) => c.checked))) await click(vp, "#ciGeo");
    m = await submit(vp, "ciForm");
    check("check out → 'About 10h … no hours are issued yet'", /Checked out at[\s\S]*About 10h[\s\S]*no hours are issued yet/.test(m), m);
    check("chain: still no hours after check-in + check-out + location", Number(await d.ledger.totalHours(vol.address)) === 0);
    await cp.bringToFront();
    await click(cp, '[data-shift="1"] [data-review]');
    await waitText(cp, "#attList", /Awaiting approval/);
    check("review shows 10h, at site yes / yes, awaiting approval", /yes \/ yes[\s\S]*10h[\s\S]*Awaiting approval/.test(await txt(cp, "#attList")), await txt(cp, "#attList"));
    let sends = await cp.evaluate(() => window.__sends);
    m = await submit(cp, "issueAttForm");
    check("issuing before approval → 'Nothing approved to issue', no transaction", /Nothing approved to issue/.test(m) && (await cp.evaluate(() => window.__sends)) === sends, m);
    await click(cp, "[data-approve]");
    check("approve → 'Approved 10h … Not on-chain yet'", await waitText(cp, "#issueAttForm .msg", /Approved 10h for .*Not on-chain yet/), await txt(cp, "#issueAttForm .msg"));
    row = db.prepare("SELECT * FROM attendance").get();
    check("evidence recorded: hash = keccak256(evidence JSON), approver = coordinator", row.status === "approved" && row.evidence_hash === ethers.id(row.evidence) && JSON.parse(row.evidence).approvedBy === coord.address);

    group("Issue on-chain from the coordinator's wallet");
    m = await submit(cp, "issueAttForm");
    check("issueBatch (real signature) → 'Record #1: 10h Environmental'", /Record #1: 10h Environmental/.test(m), m);
    check("service verified the receipt and marked it issued", await waitText(cp, "#issueAttForm .msg", /marked 1 attendance record as issued/), await txt(cp, "#issueAttForm .msg"));
    const rec = await d.ledger.getRecord(1);
    check("chain: record #1 = 10h for the volunteer, evidence hash = attendance evidence", rec.volunteer === vol.address && Number(rec.hoursLogged) === 10 && rec.evidenceHash === row.evidence_hash);
    const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint8", "uint16"], [vol.address, 0, 10]));
    const tok = await d.badges.tokenOfKey(key);
    check("chain: 10h soulbound badge minted to the volunteer", tok !== 0n && (await d.badges.ownerOf(tok)) === vol.address);
    row = db.prepare("SELECT * FROM attendance").get();
    check("service: status issued, record #1, tx hash stored", row.status === "issued" && row.record_id === "1" && /^0x[0-9a-f]{64}$/.test(row.tx_hash));
    await waitText(cp, "#attList", /Issued on-chain/);
    check("review table shows 'Issued on-chain · record #1'", /Issued on-chain[\s\S]*record #1/.test(await txt(cp, "#attList")));
    sends = await cp.evaluate(() => window.__sends);
    m = await submit(cp, "issueAttForm");
    check("issuing again → nothing approved left, no transaction", /Nothing approved to issue/.test(m) && (await cp.evaluate(() => window.__sends)) === sends, m);
    await vp.bringToFront();
    await click(vp, "#ciMineBtn");
    check("volunteer's own list: 'Issued on-chain · record #1'", await waitText(vp, "#ciMine", /Issued on-chain · record #1/), await txt(vp, "#ciMine"));
    await L.shot(vp, "v2-checkin-volunteer");
    for (const [p, label] of [[vp, "check-in"], [cp, "attendance"]]) {
      await p.bringToFront();
      await p.setViewport({ width: 375, height: 812 }); // width only: toggling isMobile would reload and lose the page state
      await sleep(600);
      const page = label === "check-in" ? "#checkin" : "#attend";
      check(`${label} page at 375px: still showing its content, no sideways scrolling`, (await p.$eval(page, (e) => !e.hidden && e.querySelector(".v2-body:not([hidden]) .shift"))) && !(await L.overflow(p)));
    }
    await L.shot(vp, "v2-checkin-mobile");
    check("no JavaScript errors", cp.__errors.length + vp.__errors.length === 0, [...cp.__errors, ...vp.__errors].join("; "));
  } finally {
    await b?.close();
    api?.close();
    proc.kill();
  }
  group("Public Base Sepolia untouched");
  check(`V1 record count unchanged (${liveBefore})`, Number(await live.recordCount()) === liveBefore);
}

module.exports = { run };
