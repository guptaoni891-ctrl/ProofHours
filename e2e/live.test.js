// Read-only end-to-end tests against the LIVE Base Sepolia deployment. Nothing is ever sent:
// the wallet stand-in refuses eth_sendTransaction and every check also asserts that no send was attempted.
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, visible, nav, submit, sleep } = L;

const demo = L.loadDemo();
const fp = (id) => { const v = demo.find((d) => d.id === id); return ethers.solidityPackedKeccak256(["bytes32", "string"], [v.salt, v.id]); };

async function chainTruth() {
  group("On-chain validation (read-only calls to the live contract)");
  const C = L.loadConfig();
  const provider = new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true });
  const c = new ethers.Contract(L.LIVE.address, C.abi, provider);
  check("RPC is Base Sepolia (84532)", Number((await provider.getNetwork()).chainId) === 84532);
  check("contract code present", (await provider.getCode(L.LIVE.address)).length > 1000);
  check("admin() is the 0674 wallet", (await c.admin()).toLowerCase() === L.ADMIN.toLowerCase());
  const [gActive, gLabel] = await c.coordinators(L.ADMIN), [dActive, dLabel] = await c.coordinators("0x000000000000000000000000000000000000dEaD");
  check("Green Shores NGO (demo) is an active coordinator", gActive && gLabel === "Green Shores NGO (demo)");
  check("Desert Bloom NGO (demo) (0x…dEaD) is an active coordinator", dActive && dLabel === "Desert Bloom NGO (demo)");
  const nEv = Number(await c.eventCount()), nRec = Number(await c.recordCount());
  const ev1 = await c.events(1);
  check("event #1 is EVT-001 Beach Cleanup (demo), 6h, owned by Green Shores", ev1.eventCode === "EVT-001 Beach Cleanup (demo)" && Number(ev1.maxDurationHours) === 6 && ev1.coordinator === L.ADMIN);
  const expect = { "S-001": ["VALID", 4, [1]], "S-002": ["CORRECTED", 5, [2, 3]], "S-003": ["REVOKED", 0, [4, 5]], "S-004": [null], "S-005": [null], "S-404": [null] };
  for (const [id, [verdict, hours, trail]] of Object.entries(expect)) {
    const [ids] = await c.getRecordsByCommitment(fp(id), 0, 50);
    if (!verdict) { check(`${id}: no on-chain record`, ids.length === 0, ids.join(",")); continue; }
    const [head, t] = await c.getEffectiveRecord(ids[0]);
    const v = head.entryType === 2n ? "REVOKED" : head.replacesRecordId !== 0n ? "CORRECTED" : "VALID";
    const h = head.entryType === 2n ? 0 : Number(head.hoursLogged);
    check(`${id}: ${verdict}, ${hours}h, trail #${trail.join("→#")}, issued by Green Shores`, ids.length === 1 && v === verdict && h === hours && t.map(Number).join() === trail.join() && head.issuer === L.ADMIN, `${v} ${h}h trail ${t.join("→")}`);
  }
  const r2 = await c.getRecord(2), r3 = await c.getRecord(3), r5 = await c.getRecord(5);
  check("record #2 still 4h (append-only), superseded by #3", Number(r2.hoursLogged) === 4 && Number(r2.supersededBy) === 3);
  check("record #3 reason TYPO_FIX, #5 reason ATTENDANCE_VOID", ethers.decodeBytes32String(r3.reasonCode) === "TYPO_FIX" && ethers.decodeBytes32String(r5.reasonCode) === "ATTENDANCE_VOID");
  check("hasRecorded(1, S-001) true, (1, S-004) false", (await c.hasRecorded(1, fp("S-001"))) && !(await c.hasRecorded(1, fp("S-004"))));
  // Expected Overview figures, derived from the chain (not hard-coded)
  const recs = await Promise.all(Array.from({ length: nRec }, (_, i) => c.getRecord(i + 1)));
  const hours = recs.filter((r) => r.supersededBy === 0n).reduce((s, r) => s + (r.entryType === 2n ? 0 : Number(r.hoursLogged)), 0);
  const originals = recs.filter((r) => r.entryType === 0n).length;
  return { nEv, nRec, hours, originals };
}

async function run(base) {
  const truth = await chainTruth();
  const b = await L.launch();
  const pageErrors = [];
  const open = async (path, opts) => { const p = await L.openPage(b, base + path, opts); pageErrors.push(p.__errors); return p; };
  const readOnly = (addr = L.ADMIN) => ({ wallet: L.readOnlyWallet, args: [addr, L.LIVE.walletRpc] });

  // ---------- default network ----------
  group("Default network is Base Sepolia");
  let p = await open("");
  const cfg = await p.evaluate(() => ({ chainId: CONFIG.chainId, netName: CONFIG.netName, address: CONFIG.address, rpcs: CONFIG.rpcs, local: LOCAL }));
  check("no URL options → chain 84532, Base Sepolia, live contract, public RPCs, not local", cfg.chainId === 84532 && cfg.netName === "Base Sepolia" && cfg.address === L.LIVE.address && cfg.rpcs.every((u) => /^https:\/\//.test(u)) && !cfg.local, JSON.stringify(cfg));
  check("labels say Base Sepolia, no warning banner", /Base Sepolia/.test(await txt(p, ".testnet")) && /Base Sepolia/.test(await txt(p, "#netBadge")) && (await p.$eval("#netAlert", (e) => e.hidden)));
  check("page actually reads a public Base Sepolia RPC", /^https:\/\/.*base/.test(await p.evaluate(() => activeRpc)), await p.evaluate(() => activeRpc));
  await p.close();
  p = await open("?rpc=https://sepolia.base.org");
  check("a public ?rpc= override keeps Base Sepolia (84532), not local", await p.evaluate(() => CONFIG.chainId === 84532 && !LOCAL));
  await p.close();

  // ---------- public verification, no wallet ----------
  group("Verify Hours with no wallet");
  p = await open("");
  check("no wallet: pill says NO WALLET", (await txt(p, "#rolePill")) === "NO WALLET");
  await nav(p, "verify");
  for (const [id, re] of [["S-001", /VALID[\s\S]*\b4\b[\s\S]*Green Shores/], ["S-002", /CORRECTED[\s\S]*\b5\b[\s\S]*TYPO_FIX/], ["S-003", /REVOKED[\s\S]*\b0\b/], ["S-404", /NOT FOUND/]]) {
    await p.$eval(`[data-demo="${id}"]`, (x) => x.click());
    await p.waitForFunction(() => !document.querySelector("#verifyOut .skeleton"), { timeout: 30000 }).catch(() => {});
    await sleep(2500);
    check(`verify ${id}`, re.test(await txt(p, "#verifyOut")), await txt(p, "#verifyOut"));
  }
  await p.$eval('[data-demo="S-002"]', (x) => x.click()); await sleep(5000);
  check("S-002 history has BaseScan proof links for #2 and #3", (await p.$$eval("#verifyOut .timeline a[href*='/tx/0x']", (a) => a.length)) >= 2);
  await p.evaluate(() => { document.querySelector("#vClaimed").value = "8"; document.querySelector("#verifyBtn").click(); }); await sleep(4000);
  check("claim check: claimed 8h vs 5h → CLAIM MISMATCH", /CLAIM MISMATCH: claimed 8h, on-chain 5h/.test(await txt(p, "#verifyOut")));
  await p.evaluate(() => { document.querySelector("#vSalt").value = "0x12"; document.querySelector("#verifyBtn").click(); }); await sleep(300);
  check("bad salt → friendly message", /64 hex/.test(await txt(p, "#verifyMsg")));
  // print view
  await p.$eval('[data-demo="S-002"]', (x) => x.click()); await sleep(5000);
  check("print button present", await visible(p, "[data-print]"));
  await p.emulateMediaType("print");
  const pr = await p.evaluate(() => ({ side: getComputedStyle(document.querySelector(".sidebar")).display, form: getComputedStyle(document.querySelector("#verifyForm")).display, head: getComputedStyle(document.querySelector(".print-head")).display, bg: getComputedStyle(document.body).backgroundColor, meta: document.querySelector("#printMeta").textContent }));
  check("print view: white report, no sidebar/form, header with student + contract", pr.side === "none" && pr.form === "none" && pr.head !== "none" && pr.bg === "rgb(255, 255, 255)" && /S-002/.test(pr.meta) && pr.meta.includes(L.LIVE.address), JSON.stringify(pr));
  await p.pdf({ path: require("path").join(__dirname, "..", "screenshots", "e2e-verify-print.pdf"), format: "A4" });
  await p.emulateMediaType("screen");
  await p.close();
  const salt2 = demo.find((d) => d.id === "S-002").salt;
  p = await open(`#id=S-002&salt=${salt2}`); await sleep(4000);
  check("receipt link #id=…&salt=… opens Verify with the result", (await txt(p, "#pageTitle")) === "Verify a record" && /CORRECTED/.test(await txt(p, "#verifyOut")));
  await p.close();

  // ---------- home + My Impact ----------
  group("Home and My Impact");
  p = await open("");
  check("landing is full width: no sidebar/topbar; app pages show the shell", await p.evaluate(() => document.body.dataset.view === "landing" && getComputedStyle(document.querySelector(".sidebar")).display === "none"));
  check("landing preview shows the real S-002 record (CORRECTED, 5h)", await L.waitText(p, "#lpPreview", /CORRECTED[\s\S]*5[\s\S]*Green Shores/, 30000), await txt(p, "#lpPreview"));
  check("landing primary action → My impact, secondary → Verify", (await p.$$eval(".lhero-actions .btn", (b) => b.map((x) => x.dataset.goto).join())) === "impact,verify");
  check("home: 4 role cards in order", (await p.$$eval(".role-card", (c) => c.map((x) => x.dataset.goto).join())) === "verify,impact,coord,admin");
  await sleep(2500);
  const m = { h: await txt(p, "#mHours"), r: await txt(p, "#mRecords"), e: await txt(p, "#mEvents") };
  check(`home metrics match chain (${truth.hours}h, ${truth.originals} records, ${truth.nEv} events)`, m.h === String(truth.hours) && m.r === String(truth.originals) && m.e === String(truth.nEv), JSON.stringify(m));
  for (const [goto, title] of [["verify", "Verify a record"], ["impact", "My impact"], ["coord", "Coordinator"], ["admin", "Admin"]]) {
    await nav(p, "overview", 200); await p.$eval(`.role-card[data-goto="${goto}"]`, (x) => x.click()); await sleep(250);
    check(`role card → ${title}`, (await txt(p, "#pageTitle")) === title);
  }
  check("app pages use the app shell", await p.evaluate(() => document.body.dataset.view === "app"));
  await nav(p, "impact");
  const impact = async (id) => { await p.$eval(`[data-impact-demo="${id}"]`, (x) => x.click()); await p.waitForFunction(() => !document.querySelector("#impactOut .skeleton"), { timeout: 30000 }).catch(() => {}); await sleep(2500); return txt(p, "#impactOut"); };
  let o = await impact("S-001");
  check("My Impact S-001: 4h, next First Spark 4/5h, proof link", /Verified hours\s*4\b/i.test(o) && /4 \/ 5h/.test(o) && (await p.$$eval("#impactOut [data-tx] a", (a) => a.length)) > 0, o);
  o = await impact("S-002");
  check("My Impact S-002: 5h CORRECTED, bar 50%, 'not minted' label", /CORRECTED/.test(o) && /5 \/ 10h/.test(o) && /not minted on-chain/.test(o) && (await p.$eval(".ms-bar span", (e) => e.style.getPropertyValue("--p"))) === "50%", o);
  o = await impact("S-003");
  check("My Impact S-003: 0h REVOKED", /Verified hours\s*0\b/i.test(o) && /REVOKED/.test(o), o);
  o = await impact("S-404");
  check("My Impact S-404: no hours found", /No verified hours found for S-404/.test(o), o);
  await p.close();

  // ---------- wallet connected (read-only stand-in as the live admin/coordinator) ----------
  group("Coordinator portal: picker, duplicate prevention, pre-check");
  p = await open("", readOnly());
  check("pill shows both roles", (await txt(p, "#rolePill")) === "ADMIN · COORDINATOR: Green Shores NGO (demo)", await txt(p, "#rolePill"));
  await nav(p, "coord");
  await p.waitForFunction(() => document.querySelectorAll("#pickList [data-pick]").length > 0, { timeout: 30000 }).catch(() => {});
  const ids = () => p.$$eval("#pickList [data-pick]", (bs) => bs.map((x) => x.dataset.pick).join());
  check("picker default lists only fixable #3, #1", (await ids()) === "3,1", await ids());
  await p.$eval("#pickMine", (c) => c.click()); await sleep(200);
  const all = await ids();
  check("picker 'all' lists every record, newest first", all.startsWith("5,4,3,2,1".slice(0, all.length)) && all.endsWith("2,1"), all);
  const row = (id) => p.$eval(`[data-pick="${id}"]`, (x) => ({ t: x.innerText.replace(/\s+/g, " "), off: x.getAttribute("aria-disabled") === "true" }));
  const r2 = await row(2), r3 = await row(3), r5 = await row(5);
  check("#2 superseded → disabled with reason", r2.off && /Superseded by #3/.test(r2.t) && /latest entry, #3/.test(r2.t), r2.t);
  check("#3 shows ID label, event, 4h original → 5h now, NGO, Current", !r3.off && /Demo volunteer S-002/.test(r3.t) && /EVT-001/.test(r3.t) && /4h original/.test(r3.t) && /5h now/.test(r3.t) && /Green Shores/.test(r3.t) && /Current/.test(r3.t), r3.t);
  check("#5 revocation → disabled", r5.off && /Revocation/.test(r5.t));
  await p.type("#pickSearch", "s-002"); await sleep(200);
  check("search s-002 → #3, #2", (await ids()) === "3,2", await ids());
  await p.$eval('[data-pick="2"]', (x) => x.click()); await sleep(150);
  check("clicking a disabled row selects nothing", (await p.$eval("#cId", (i) => i.value)) === "");
  await p.$eval('[data-pick="3"]', (x) => x.click()); await sleep(150);
  check("selecting #3 fills both fix forms with preview", (await p.$eval("#xId", (i) => i.value)) === "3" && /#3 · Demo volunteer S-002/.test(await txt(p, "#correctForm [data-preview]")));
  await p.$eval("#cId", (i) => { i.value = "2"; i.dispatchEvent(new Event("input")); }); await p.$eval("#cHours", (i) => (i.value = "6"));
  let msg = await submit(p, "correctForm", 8000);
  check("typed superseded #2 → blocked, nothing sent", /Already replaced/.test(msg) && /Nothing was sent/.test(msg), msg);
  await p.waitForFunction(() => [...document.querySelectorAll("#rEvent option")].some((o) => o.value === "1"), { timeout: 20000 }).catch(() => {});
  await p.select("#rEvent", "1"); await p.select("#rPick", "S-001"); await sleep(3500);
  check("S-001 on event #1 → duplicate warning, Record disabled", /S-001 already has a record for event #1/.test(await txt(p, "#rDup")) && (await p.$eval("#recordForm button[type=submit]", (x) => x.disabled)));
  await p.select("#rPick", "S-004"); await sleep(3500);
  check("S-004 → warning cleared, Record enabled", !(await visible(p, "#rDup")) && !(await p.$eval("#recordForm button[type=submit]", (x) => x.disabled)));
  await p.$eval("#rHours", (i) => (i.value = "10"));
  msg = await submit(p, "recordForm");
  check("10h on a 6h event → refused before wallet opens", /10 hours exceeds this event's 6-hour limit/.test(msg) && /wallet was not asked to sign/.test(msg), msg);
  check("no transaction attempted in coordinator tests", (await p.evaluate(() => window.__sends)) === 0);

  group("Admin confirmations (Cancel only)");
  await nav(p, "admin", 1500);
  const rnd = "0x1111111111111111111111111111111111111111";
  await p.evaluate((a) => { document.querySelector("#aAddr").value = a; document.querySelector("#aLabel").value = "Test NGO"; document.querySelector("#regForm").requestSubmit(); }, rnd);
  await p.waitForSelector("#regForm .confirm-card", { timeout: 15000 }).catch(() => {});
  check("register new wallet → card 'never been registered', Confirm focused", /never been registered/.test(await txt(p, "#regForm .confirm-card")) && (await p.evaluate(() => document.activeElement?.hasAttribute("data-ok"))));
  await p.$eval("#regForm [data-cancel]", (x) => x.click()); await sleep(150);
  check("Cancel removes card", !(await p.$("#regForm .confirm-card")));
  await p.evaluate(() => { document.querySelector("#aAddr").value = "0x000000000000000000000000000000000000dEaD"; document.querySelector("#aLabel").value = "Renamed"; document.querySelector("#regForm").requestSubmit(); });
  await p.waitForSelector("#regForm .confirm-card", { timeout: 15000 }).catch(() => {});
  check("register existing → warns it renames Desert Bloom", /already an active coordinator as Desert Bloom NGO \(demo\)/.test(await txt(p, "#regForm .confirm-card")));
  await p.$eval("#regForm [data-cancel]", (x) => x.click());
  await p.evaluate((a) => { document.querySelector("#aRevAddr").value = a; document.querySelector("#revForm").requestSubmit(); }, rnd); await sleep(3000);
  check("revoke non-coordinator → explained, no card", /not an active coordinator/.test(await txt(p, "#revForm .msg")) && !(await p.$("#revForm .confirm-card")));
  await p.evaluate(() => { document.querySelector("#aRevAddr").value = "0x000000000000000000000000000000000000dEaD"; document.querySelector("#revForm").requestSubmit(); });
  await p.waitForSelector("#revForm .confirm-card", { timeout: 15000 }).catch(() => {});
  check("revoke Desert Bloom → confirmation card with effect", /Revoke Desert Bloom NGO \(demo\)\?/.test(await txt(p, "#revForm .confirm-card")));
  await p.$eval("#revForm [data-cancel]", (x) => x.click());
  check("no transaction attempted in admin tests", (await p.evaluate(() => window.__sends)) === 0);

  group("Security Demo (V1 feature) still refuses as expected");
  await nav(p, "demo", 600);
  for (const k of ["wrongWallet", "duplicate", "overHours", "nonIssuer"]) {
    await p.$eval(`[data-refusal="${k}"]`, (x) => x.click());
    const ok = await p.waitForFunction((k) => /matches expected/.test(document.querySelector(`[data-refusal="${k}"]`).closest(".scenario").querySelector(".sc-result").innerText), { timeout: 30000 }, k).then(() => true).catch(() => false);
    check(`refusal ${k}: matches expected`, ok);
  }

  group("Wallet scenarios: account switch, wrong chain, chain verification, failover");
  await p.evaluate(() => window.__setAccount("0x2222222222222222222222222222222222222222"));
  check("switch to an unregistered account → NOT AUTHORIZED", await L.waitText(p, "#rolePill", /^NOT AUTHORIZED$/));
  await nav(p, "coord", 1500);
  await p.$eval("#pickMine", (c) => { if (!c.checked) c.click(); }); await sleep(2500);
  check("…its picker has nothing it can fix, banners warn", /No records your wallet can fix/.test(await txt(p, "#pickList")) && (await p.$eval("#coordBanner", (e) => e.classList.contains("warn"))));
  await p.evaluate((a) => window.__setAccount(a), L.ADMIN);
  check("switch back → ADMIN · COORDINATOR", await L.waitText(p, "#rolePill", /ADMIN · COORDINATOR/));
  const verifyAs = (mode) => p.evaluate(async (m) => { window.__mode = m; window.__flaky = 0; try { await walletContract(); return { ok: true }; } catch (e) { return { ok: false, code: e.code || "", msg: e.message }; } }, mode);
  let r = await verifyAs("sync");
  check("wallet in sync → verified", r.ok, JSON.stringify(r));
  r = await verifyAs("lag30");
  check("wallet RPC 30 blocks behind → verified", r.ok, JSON.stringify(r));
  r = await verifyAs("down");
  check("wallet RPC down → not verified, nothing sent (CHAIN_UNVERIFIED)", !r.ok && r.code === "CHAIN_UNVERIFIED", JSON.stringify(r));
  r = await verifyAs("wrongid");
  check("wrong chain id → 'wrong network'", !r.ok && /wrong network/.test(r.msg), JSON.stringify(r));
  await p.evaluate(() => { window.__mode = "wrongid"; window.__setAccount(window.__addr); });
  check("wrong chain shows badge + Switch button", (await L.waitText(p, "#netBadge", /wrong network/i)) && (await visible(p, "#switchBtn")));
  await p.click("#switchBtn");
  check("Switch button → back to Base Sepolia", await L.waitText(p, "#netBadge", /^Base Sepolia$/));
  await p.evaluate(() => (window.__mode = "sync"));
  check("no transaction attempted in wallet scenarios", (await p.evaluate(() => window.__sends)) === 0);
  await p.close();
  // failover: the RPC the page reads from fails mid-session (regression for "stuck on a timing-out RPC")
  p = await b.newPage(); await p.setViewport({ width: 1366, height: 900 });
  p.__errors = []; p.on("pageerror", (e) => p.__errors.push(e.message)); pageErrors.push(p.__errors);
  let fail = null; // null | "abort" | "408" | "all408"
  await p.setRequestInterception(true);
  p.on("request", (q) => {
    const u = q.url(), pub = u.includes("base-sepolia-rpc.publicnode.com"), anyRpc = pub || u.includes("sepolia.base.org") || u.includes("drpc.org");
    if (fail === "abort" && pub) return q.abort("failed");
    if (fail === "408" && pub) return q.respond({ status: 408, body: "timeout" });
    if (fail === "all408" && anyRpc && q.frame()) return q.respond({ status: 408, body: "timeout" });
    return q.continue();
  });
  await p.evaluateOnNewDocument(L.readOnlyWallet, L.ADMIN, L.LIVE.walletRpc);
  await p.goto(base, { waitUntil: "networkidle0" }); await sleep(2000);
  const before = await p.evaluate(() => activeRpc);
  fail = "abort";
  r = await p.evaluate(async () => { try { await walletContract(); return { ok: true }; } catch (e) { return { ok: false, msg: e.message }; } });
  let after = await p.evaluate(() => activeRpc);
  check("page RPC unreachable → chain check fails over and verifies", r.ok && /publicnode/.test(before) && !/publicnode/.test(after), `${before} → ${after} ${JSON.stringify(r)}`);
  // back on publicnode, then it starts answering 408 timeouts: Verify must move to another RPC
  fail = null;
  await p.evaluate(() => { rpcList.sort((x, y) => (y.includes("publicnode") ? 1 : 0) - (x.includes("publicnode") ? 1 : 0)); readerPromise = null; });
  await p.evaluate(() => reader()); check("(setup) reader back on publicnode", /publicnode/.test(await p.evaluate(() => activeRpc)));
  fail = "408";
  await nav(p, "verify"); await p.$eval('[data-demo="S-002"]', (x) => x.click());
  await p.waitForFunction(() => !document.querySelector("#verifyOut .skeleton"), { timeout: 30000 }).catch(() => {}); await sleep(1500);
  after = await p.evaluate(() => activeRpc);
  check("page RPC starts timing out (408) → Verify switches RPC and still shows CORRECTED", /CORRECTED/.test(await txt(p, "#verifyOut")) && !/publicnode/.test(after), `${after} | ${await txt(p, "#verifyMsg")}`);
  fail = "all408";
  await p.$eval('[data-demo="S-001"]', (x) => x.click());
  await p.waitForFunction(() => !document.querySelector("#verifyOut .skeleton"), { timeout: 30000 }).catch(() => {}); await sleep(1000);
  const vm = await txt(p, "#verifyMsg");
  check("every RPC timing out → plain message, no raw 'server response 408'", /didn't respond in time|Could not reach the Base Sepolia network/.test(vm) && !/server response|408/.test(vm), vm);
  fail = null;
  await p.close();

  group("Network Status page");
  p = await open("", readOnly());
  await nav(p, "network");
  await p.waitForFunction(() => /^Yes/.test(document.querySelector("#dSame")?.innerText ?? ""), { timeout: 30000 }).catch(() => {});
  const w = (await txt(p, "#walletInfo")).replace(/\n/g, " | ");
  check("diagnostics: contract deployed both sides, chain 84532, same chain Yes", /Contract \(page RPC\) \| Deployed/.test(w) && /84532 expected/.test(w) && /Same chain as page \| Yes/.test(w), w);
  check("RPC table lists the 3 public RPCs", (await p.$$eval("#rpcTable tr", (t) => t.length)) === 3);
  await p.close();

  // ---------- responsive ----------
  group("Responsive layouts (no sideways scrolling)");
  for (const [w, h, label] of [[375, 812, "mobile"], [768, 1024, "tablet"], [1366, 900, "laptop"], [1920, 1080, "desktop"]]) {
    p = await open("", { width: w, height: h, ...readOnly() });
    const bad = [];
    for (const pg of ["overview", "verify", "impact", "passport", "checkin", "coord", "admin", "issue2", "attend", "demo", "network"]) {
      await nav(p, pg, 500);
      if (pg === "verify") { await p.$eval('[data-demo="S-002"]', (x) => x.click()); await sleep(3500); }
      if (pg === "impact") { await p.$eval('[data-impact-demo="S-002"]', (x) => x.click()); await sleep(3500); }
      if (await L.overflow(p)) bad.push(pg);
      if (["overview", "impact", "coord"].includes(pg)) await L.shot(p, `e2e-${label}-${w}-${pg}`);
    }
    check(`${label} ${w}px: no page scrolls sideways`, bad.length === 0, bad.join(","));
    if (w <= 1024) check(`${label}: menu button opens the navigation drawer`, await (async () => { await p.click("#menuBtn"); await sleep(400); const ok = await p.evaluate(() => document.body.classList.contains("nav-open")); await p.keyboard.press("Escape"); return ok; })());
    await p.close();
  }

  check("no JavaScript errors on any page", pageErrors.flat().length === 0, pageErrors.flat().join("; "));
  await b.close();
}

module.exports = { run };
