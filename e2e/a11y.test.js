// Accessibility: automated WCAG 2.0/2.1/2.2 A + AA checks with axe-core on every page, at desktop and mobile widths,
// on the default network (read-only) and on an isolated fork with real V2 data and services. Plus keyboard checks.
// Automated checks find roughly a third to a half of WCAG issues; they don't replace a manual audit with assistive tech.
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const L = require("./lib");
const { check, group, nav, sleep } = L;
const { deployV2 } = require("./v2.test");
const att = require("../server/attendance");
const idx = require("../server/indexer");

const ANVIL = process.env.ANVIL || path.join(os.homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
const FORK = "http://127.0.0.1:8653";
const [ATT_PORT, IDX_PORT] = [8798, 8799 + 100];
const DEPLOYER = "0x0000000000000000000000000000000050000001";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const PAGES = ["overview", "verify", "opps", "reports", "impact", "passport", "checkin", "coord", "admin", "issue2", "attend", "audit", "demo", "network"];

// Toasts fading out (260 ms) are excluded: their text is mid-animation and already announced.
async function axe(p) {
  // evaluated over the DevTools protocol: the page's CSP rightly blocks injected <script> tags
  if (!(await p.evaluate(() => !!window.axe))) await p.evaluate(require("fs").readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"));
  const r = await p.evaluate((tags) => window.axe.run({ exclude: [[".toast.out"]] }, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] }), TAGS);
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, where: v.nodes.slice(0, 2).map((x) => x.target.join(" ")).join(" | "), help: v.help }));
}
// Runs axe on each page and reports every violation (any impact), grouped by page.
async function audit(p, label, pages = PAGES) {
  const found = [];
  for (const pg of pages) {
    await nav(p, pg, 2200);
    for (const v of await axe(p)) found.push({ page: pg, ...v });
  }
  check(`${label}: no WCAG A/AA violations found by axe on ${pages.length} pages`, found.length === 0, found.map((v) => `${v.page}: ${v.id} (${v.impact}, ${v.n}×) ${v.where}`).join(" || "));
  return found;
}

async function run(base) {
  const C = L.loadConfig();
  const b = await L.launch();
  const proc = spawn(ANVIL, ["--fork-url", L.LIVE.rpc, "--chain-id", "31337", "--port", "8653", "--silent"], { stdio: "ignore" });
  const servers = [];
  try {
    group("Accessibility on the default network (read-only)");
    let p = await L.openPage(b, base);
    await audit(p, "desktop 1366px");
    await p.setViewport({ width: 375, height: 812 });
    await audit(p, "mobile 375px", ["overview", "verify", "passport", "checkin", "opps"]);
    await p.close();

    group("Keyboard");
    p = await L.openPage(b, base);
    await p.keyboard.press("Tab");
    check("first Tab reaches the skip link", await p.evaluate(() => document.activeElement?.classList.contains("skip") || /skip/i.test(document.activeElement?.textContent ?? "")), await p.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)));
    await nav(p, "verify", 800);
    await p.focus("#vId");
    check("focused inputs show a visible focus ring", await p.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.boxShadow !== "none" || (s.outlineStyle !== "none" && s.outlineWidth !== "0px"); }));
    await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control");
    await sleep(400);
    check("Ctrl+K opens search with focus in the input", await p.evaluate(() => document.querySelector("#omni").open && document.activeElement.id === "omniQ"));
    await p.keyboard.press("Escape");
    await sleep(300);
    check("Esc closes search and focus returns to the page", await p.evaluate(() => !document.querySelector("#omni").open && document.activeElement?.id !== "omniQ"));
    await p.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    check("reduced motion: page transitions are switched off", await p.evaluate(() => { const d = getComputedStyle(document.querySelector(".page:not([hidden])")).animationDuration; return d === "0s" || parseFloat(d) <= 0.01; }));
    await p.close();

    group("Arabic, right to left");
    p = await L.openPage(b, base);
    await nav(p, "verify", 800);
    await p.$eval("#langBtn", (x) => x.click());
    await sleep(500);
    check("Arabic switches the page to lang=ar, dir=rtl", await p.evaluate(() => document.documentElement.lang === "ar" && document.documentElement.dir === "rtl"));
    check("menu, page title and Verify page are in Arabic", (await p.$eval('[data-i18n="nav.verify"]', (e) => e.textContent)) === "التحقق من سجل" && (await p.$eval("#pageTitle", (e) => e.textContent)) === "التحقق من سجل" && (await p.$eval('[data-i18n="verify.button"]', (e) => e.textContent)) === "تحقّق على السلسلة");
    check("layout mirrors: the sidebar is on the right", await p.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().left > window.innerWidth / 2));
    check("RTL: no sideways scrolling", !(await L.overflow(p)));
    await p.$eval('[data-demo="S-002"]', (x) => x.click());
    await sleep(4000);
    check("verification still works in Arabic (wallet-free check)", /CORRECTED|5\s*verified hours/i.test(await L.txt(p, "#verifyOut")));
    const rtl = await axe(p);
    check("RTL Verify page: no axe violations", rtl.length === 0, rtl.map((v) => `${v.id} ${v.where}`).join(" || "));
    await p.reload({ waitUntil: "networkidle0" });
    await sleep(1000);
    check("the language choice is remembered", await p.evaluate(() => document.documentElement.dir === "rtl"));
    await p.$eval("#langBtn", (x) => x.click());
    await sleep(300);
    check("switching back restores English and left to right", await p.evaluate(() => document.documentElement.dir === "ltr" && document.querySelector('[data-i18n="nav.verify"]').textContent === "Verify a record"));
    await p.close();
    p = await L.openPage(b, base);
    await p.close();

    group("Accessibility of V2 screens with real data (isolated fork)");
    const provider = new ethers.JsonRpcProvider(FORK, 31337, { staticNetwork: true, cacheTimeout: -1 });
    for (let i = 0; i < 60; i++) { try { await provider.getBlockNumber(); break; } catch { await sleep(500); } }
    const forkBlock = await provider.getBlockNumber();
    const d = await deployV2(provider, C);
    const [coord, vol] = [0, 1].map(() => ethers.Wallet.createRandom().connect(provider));
    for (const w of [coord, vol]) await provider.send("anvil_setBalance", [w.address, "0x8AC7230489E80000"]);
    await (await d.ledger.registerOrg("Green Shores NGO (demo)", DEPLOYER, 500)).wait();
    await (await d.ledger.setCoordinator(coord.address, 1)).wait();
    await (await d.ledger.grantRole(await d.ledger.AUDITOR_ROLE(), coord.address)).wait();
    await (await d.ledger.connect(vol).optIn()).wait();
    const today = Math.floor((await provider.getBlock("latest")).timestamp / 86400);
    await (await d.ledger.connect(coord).createEvent("EVT-801 Mangroves (demo)", 0, 12, today)).wait();
    await (await d.ledger.connect(coord).issueHours(1, vol.address, 12, ethers.ZeroHash)).wait();
    const secret = ethers.hexlify(ethers.randomBytes(32));
    servers.push(http.createServer(att.createApp({ db: att.openDb(":memory:"), chain: att.ledgerChain(FORK, d.addresses.ledger, 31337, d.addresses.badges), secret, chainId: 31337 })));
    const idxDb = idx.openDb(":memory:"), indexer = idx.createIndexer({ db: idxDb, provider, ledger: d.addresses.ledger, startBlock: forkBlock + 1, confirmations: 0 });
    await indexer.syncAll();
    servers.push(http.createServer(idx.createApi({ db: idxDb, indexer, provider, confirmations: 0, ledger: d.addresses.ledger, secret })));
    await Promise.all(servers.map((s, i) => new Promise((r) => s.listen([ATT_PORT, IDX_PORT][i], "127.0.0.1", r))));
    const url = `${base}?local&rpc=${FORK}&api=http://127.0.0.1:${ATT_PORT}&search=http://127.0.0.1:${IDX_PORT}`;
    p = await L.openPage(b, url, { wallet: L.signingWallet, args: [[vol.privateKey, coord.privateKey], FORK, FORK] });
    await audit(p, "volunteer wallet", ["passport", "checkin", "opps", "reports"]);
    await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control");
    await p.type("#omniQ", "mangr");
    await sleep(1200);
    const dlg = await axe(p);
    check("search dialog with results: no axe violations", dlg.length === 0, dlg.map((v) => `${v.id} ${v.where}`).join(" || "));
    await p.keyboard.press("Escape");
    await p.evaluate(() => window.__setAccount(1));
    await sleep(2000);
    await audit(p, "coordinator + auditor wallet", ["issue2", "attend", "audit"]);
    check("no JavaScript errors", p.__errors.length === 0, p.__errors.join("; "));
  } finally {
    await b.close();
    servers.forEach((s) => s.close());
    proc.kill();
  }
}

module.exports = { run };
