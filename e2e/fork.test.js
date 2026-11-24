// Write journeys on ISOLATED local chains (never public Base Sepolia):
//   - a fork of Base Sepolia on 127.0.0.1:8645 (chain 31337) holding a copy of the live contract and records
//   - a separate plain chain on 127.0.0.1:8646 that reports the SAME chain id (the "different chain" case)
// Throwaway accounts are created here and sign real transactions (EIP-155, nonce, gas). On the fork only,
// one of them is made the contract admin (storage slot 0) so admin flows can be signed for real too.
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, txt, visible, nav, submit, confirmCard, sleep } = L;

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8645", OTHER = "http://127.0.0.1:8646";

async function startChain(args, url) {
  const proc = spawn(ANVIL, [...args, "--silent"], { stdio: "ignore" });
  const p = new ethers.JsonRpcProvider(url, 31337, { staticNetwork: true }); // both local chains use 31337
  for (let i = 0; i < 60; i++) { try { await p.getBlockNumber(); return { proc, p }; } catch { await sleep(500); } }
  proc.kill(); throw new Error(`anvil did not start on ${url}`);
}

async function run(base) {
  const ABI = L.loadConfig().abi;
  const live = new ethers.Contract(L.LIVE.address, ABI, new ethers.JsonRpcProvider(L.LIVE.rpc, L.LIVE.chainId, { staticNetwork: true }));
  const liveBefore = { rec: Number(await live.recordCount()), ev: Number(await live.eventCount()) };

  const fork = await startChain(["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8645"], FORK);
  const other = await startChain(["--chain-id", "31337", "--port", "8646"], OTHER);
  const b = await L.launch();
  try {
    group("Isolated fork setup");
    const c = new ethers.Contract(L.LIVE.address, ABI, fork.p);
    const [admin, coord, outsider] = [0, 1, 2].map(() => ethers.Wallet.createRandom());
    for (const w of [admin, coord, outsider]) await fork.p.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await fork.p.send("anvil_setStorageAt", [L.LIVE.address, "0x0", ethers.zeroPadValue(admin.address, 32)]);
    check("fork: copy of live contract with the seeded records", Number(await c.recordCount()) === liveBefore.rec && Number(await c.eventCount()) === liveBefore.ev);
    check("fork only: throwaway admin installed", (await c.admin()) === admin.address);
    const nEv = Number(await c.eventCount()), nRec = Number(await c.recordCount());

    const p = await L.openPage(b, `${base}?local&rpc=${FORK}`, { wallet: L.signingWallet, args: [[admin.privateKey, coord.privateKey, outsider.privateKey], FORK, OTHER] });
    check("page runs in local-fork mode (labelled, chain 31337)", /Anvil Local/.test(await txt(p, ".testnet")) && (await p.evaluate(() => CONFIG.chainId)) === 31337);
    check("throwaway admin → pill ADMIN", await L.waitText(p, "#rolePill", /^ADMIN$/));

    group("Admin: register a coordinator (real signed tx via confirmation card)");
    await nav(p, "admin", 1200);
    await p.evaluate((a) => { document.querySelector("#aAddr").value = a; document.querySelector("#aLabel").value = "QA Coordinator (fork)"; document.querySelector("#regForm").requestSubmit(); }, coord.address);
    let m = await confirmCard(p, "regForm");
    check("register → success summary from receipt", new RegExp(`registered as "QA Coordinator \\(fork\\)"`).test(m) && /Confirmed in block/.test(m), m);
    check("chain: coordinator active with label", (await c.coordinators(coord.address)).join() === "true,QA Coordinator (fork)");

    group("Coordinator: event → record → duplicate → correct → revoke");
    await p.evaluate(() => window.__setAccount(1));
    check("switch account → COORDINATOR: QA Coordinator (fork)", await L.waitText(p, "#rolePill", /^COORDINATOR: QA Coordinator \(fork\)$/));
    await nav(p, "coord", 1200);
    await p.evaluate(() => { document.querySelector("#eCode").value = "EVT-QA Fork E2E (demo)"; document.querySelector("#eMax").value = "6"; });
    m = await submit(p, "eventForm");
    const ev = nEv + 1;
    check(`create event → "Event #${ev} … created (max 6h)"`, m.includes(`Event #${ev} "EVT-QA Fork E2E (demo)" created (max 6h)`), m);
    await p.waitForFunction((e) => [...document.querySelectorAll("#rEvent option")].some((o) => o.value === String(e)), { timeout: 20000 }, ev).catch(() => {});
    await p.select("#rEvent", String(ev)); await p.select("#rPick", "new");
    await p.evaluate(() => { document.querySelector("#rId").value = "S-QA-001"; document.querySelector("#rHours").value = "4"; document.querySelector("#rId").dispatchEvent(new Event("input")); });
    await sleep(1500);
    m = await submit(p, "recordForm");
    const rec = nRec + 1;
    check(`record → "Record #${rec}: 4h recorded for event #${ev}" + receipt`, m.includes(`Record #${rec}: 4h recorded for event #${ev}`) && /Receipt: record #/.test(await txt(p, "#receipt")), m);
    const link = await p.$eval("#receiptLink", (i) => i.value);
    await sleep(2500);
    check("same volunteer again → duplicate warning, Record disabled", /S-QA-001 already has a record/.test(await txt(p, "#rDup")) && (await p.$eval("#recordForm button[type=submit]", (x) => x.disabled)));
    await p.waitForFunction((r) => !!document.querySelector(`#pickList [data-pick="${r}"]`), { timeout: 20000 }, String(rec)).catch(() => {});
    check(`picker shows new #${rec} as Current`, /Current/.test(await txt(p, `[data-pick="${rec}"]`)));
    await p.$eval(`[data-pick="${rec}"]`, (x) => x.click());
    await p.evaluate(() => { document.querySelector("#cHours").value = "5"; document.querySelector("#cReason").value = "TYPO_FIX"; });
    m = await submit(p, "correctForm");
    check(`correct via picker → "Record #${rec + 1} corrects #${rec} to 5h"`, m.includes(`Record #${rec + 1} corrects #${rec} to 5h`), m);
    await p.waitForFunction((r) => !!document.querySelector(`#pickList [data-pick="${r}"]`), { timeout: 20000 }, String(rec + 1)).catch(() => {});
    await p.$eval(`[data-pick="${rec + 1}"]`, (x) => x.click());
    m = await submit(p, "revokeForm");
    check(`revoke via picker → "Record #${rec + 2} revokes #${rec + 1}"`, m.includes(`Record #${rec + 2} revokes #${rec + 1}`), m);
    const head = (await c.getEffectiveRecord(rec))[0];
    check("chain: trail ends in a revocation issued by the coordinator", Number(head.id) === rec + 2 && head.entryType === 2n && head.issuer === coord.address);
    await p.$eval("#pickMine", (x) => { if (x.checked) x.click(); }); await sleep(300);
    check(`picker: #${rec} and #${rec + 1} superseded/disabled, #${rec + 2} revocation`, (await p.$eval(`[data-pick="${rec}"]`, (x) => x.getAttribute("aria-disabled"))) === "true" && /Revocation/.test(await txt(p, `[data-pick="${rec + 2}"]`)));

    group("Wallet edge cases with real signing");
    await p.evaluate(() => (window.__mode = "reject"));
    await p.select("#rPick", "S-005"); await sleep(1500);
    m = await submit(p, "recordForm");
    check("wallet rejects → 'You cancelled… Nothing was sent'", /You cancelled the request in your wallet. Nothing was sent/.test(m), m);
    await p.evaluate(() => (window.__mode = "down"));
    m = await submit(p, "recordForm");
    check("wallet RPC down → 'Couldn't confirm…' + Retry, nothing sent", /Couldn't confirm/.test(m) && !!(await p.$("#recordForm .msg .retry")), m);
    const sendsBefore = await p.evaluate(() => window.__sends);
    await p.evaluate(() => (window.__mode = "sync"));
    await p.$eval("#recordForm .msg .retry", (x) => x.click());
    await p.waitForFunction(() => /Confirmed in block|Refused|Couldn't|cancelled/.test(document.querySelector("#recordForm .msg").textContent) && !/Checking|Confirm in your wallet|waiting/.test(document.querySelector("#recordForm .msg").textContent), { timeout: 40000 }).catch(() => {});
    m = await txt(p, "#recordForm .msg");
    check("Retry after recovery → real tx confirmed", /Record #\d+: 4h recorded/.test(m) && (await p.evaluate(() => window.__sends)) === sendsBefore + 1, m);
    await p.evaluate(() => (window.__mode = "other"));
    await p.evaluate(() => { document.querySelector("#eCode").value = "EVT-QA should not exist"; });
    m = await submit(p, "eventForm");
    check("wallet on a different chain with the same id → 'different chains', no Retry", /different chains/.test(m) && !(await p.$("#eventForm .msg .retry")), m);
    await p.evaluate(() => { window.__mode = "wrongid"; window.__setAccount(1); });
    await sleep(1500);
    m = await submit(p, "eventForm");
    check("wrong chain id → 'wrong network'", /wrong network/.test(m), m);
    await p.evaluate(() => (window.__mode = "sync"));

    group("Unauthorized and revoked accounts");
    await p.evaluate(() => window.__setAccount(2));
    check("outsider account → NOT AUTHORIZED", await L.waitText(p, "#rolePill", /^NOT AUTHORIZED$/));
    let sends = await p.evaluate(() => window.__sends);
    m = await submit(p, "eventForm");
    check("outsider create event → refused by pre-check, wallet never asked", /not an active NGO coordinator/.test(m) && /not asked to sign/.test(m) && (await p.evaluate(() => window.__sends)) === sends, m);
    await p.evaluate(() => window.__setAccount(0));
    await L.waitText(p, "#rolePill", /^ADMIN$/);
    await nav(p, "admin", 1200);
    await p.evaluate((a) => { document.querySelector("#aRevAddr").value = a; document.querySelector("#revForm").requestSubmit(); }, coord.address);
    m = await confirmCard(p, "revForm");
    check("admin revokes coordinator via card → success summary", /revoked/.test(m) && !(await c.coordinators(coord.address))[0], m);
    await p.evaluate(() => window.__setAccount(1));
    await L.waitText(p, "#rolePill", /NOT AUTHORIZED/);
    await nav(p, "coord", 800);
    sends = await p.evaluate(() => window.__sends);
    await p.evaluate(() => { document.querySelector("#eCode").value = "EVT-QA after revoke"; });
    m = await submit(p, "eventForm");
    check("revoked coordinator → refused before signing", /not an active NGO coordinator/.test(m) && (await p.evaluate(() => window.__sends)) === sends, m);

    group("Verification of the new records on the fork");
    const p2 = await L.openPage(b, link.replace("?local", `?local&rpc=${FORK}`).replace(/\?local&rpc=[^#&]*&rpc=/, "?local&rpc="));
    await sleep(4000);
    check("receipt link → Verify shows REVOKED 0h for S-QA-001", /REVOKED/.test(await txt(p2, "#verifyOut")) && /S-QA|revoked/i.test(await txt(p2, "#verifyOut")), await txt(p2, "#verifyOut"));
    const salt = new URLSearchParams(link.split("#")[1]).get("salt");
    const p3 = await L.openPage(b, `${base}?local&rpc=${FORK}#view=impact&id=S-QA-001&salt=${salt}`);
    await sleep(4000);
    check("My Impact for S-QA-001 → 0h REVOKED", /Verified hours\s*0\b/i.test(await txt(p3, "#impactOut")) && /REVOKED/.test(await txt(p3, "#impactOut")));
    for (const [id, re] of [["S-001", /VALID/], ["S-002", /CORRECTED/], ["S-003", /REVOKED/]]) {
      await nav(p2, "verify"); await p2.$eval(`[data-demo="${id}"]`, (x) => x.click()); await sleep(3500);
      check(`fork: seeded ${id} unchanged (${re.source})`, re.test(await txt(p2, "#verifyOut")));
    }
    check("no JavaScript errors", [p, p2, p3].every((x) => x.__errors.length === 0), [p, p2, p3].flatMap((x) => x.__errors).join("; "));
  } finally {
    await b.close();
    fork.proc.kill(); other.proc.kill();
  }
  group("Public Base Sepolia untouched");
  const liveAfter = { rec: Number(await live.recordCount()), ev: Number(await live.eventCount()) };
  check(`public contract unchanged (${liveBefore.rec} records, ${liveBefore.ev} events)`, liveAfter.rec === liveBefore.rec && liveAfter.ev === liveBefore.ev, JSON.stringify({ liveBefore, liveAfter }));
  check("public admin still the 0674 wallet", (await live.admin()).toLowerCase() === L.ADMIN.toLowerCase());
}

module.exports = { run };
