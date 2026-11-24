// Shared helpers for the ProofHours end-to-end tests.
// Browsers always start with a fresh temporary profile: never the user's own Chrome/Edge profile or wallet.
const fs = require("fs");
const http = require("http");
const path = require("path");
const puppeteer = require("puppeteer-core");

const DOCS = path.join(__dirname, "..", "docs");
const SHOTS = path.join(__dirname, "..", "screenshots");
const BROWSER = process.env.BROWSER || [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => fs.existsSync(p));
const LIVE = { chainId: 84532, address: "0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b", rpc: "https://base-sepolia-rpc.publicnode.com", walletRpc: "https://sepolia.base.org" }; // wallet stand-in RPC; drpc's free tier times out too often
const ADMIN = "0x99f3a8E50c1d14AB62c2688f6f21635E32B10674"; // live admin + Green Shores coordinator (read-only use)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// docs/*.js assign to window.*; load them fresh each time (Node caches require()).
function loadDocsGlobal(file, key) { const f = require.resolve(path.join(DOCS, file)); delete require.cache[f]; global.window = {}; require(f); return window[key]; }
const loadConfig = () => loadDocsGlobal("config.js", "CONFIG");
const loadDemo = () => loadDocsGlobal("demo-volunteers.js", "DEMO_VOLUNTEERS");

// ---- results ----
const results = [];
let section = "";
const group = (name) => { section = name; console.log(`\n## ${name}`); };
function check(name, ok, detail = "") {
  results.push({ section, name, ok: !!ok, detail: String(detail).replace(/\s+/g, " ").slice(0, 240) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + String(detail).replace(/\s+/g, " ").slice(0, 240)}`);
}

// ---- tiny static server for docs/ (no Python needed) ----
const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
function serveDocs(port = 8799) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(DOCS, rel);
    if (!file.startsWith(DOCS) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ url: `http://localhost:${port}/`, close: () => server.close() })));
}

const launch = () => puppeteer.launch({ executablePath: BROWSER, headless: true, args: ["--no-first-run", "--no-default-browser-check"] });

// ---- wallet stand-ins (EIP-1193) ----
// Read-only stand-in: answers reads from an RPC as `address`, REFUSES every eth_sendTransaction (counted in __sends).
// window.__mode switches behaviour: sync | lagN | flaky | down | wrongid | reject
function readOnlyWallet(address, rpcUrl) {
  window.__mode = "sync"; window.__sends = 0; window.__flaky = 0; window.__addr = address;
  const L = {};
  const rpc = (m, p) => fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
  window.__setAccount = (a) => { window.__addr = a; (L.accountsChanged || []).forEach((f) => f([a])); };
  window.ethereum = {
    on: (e, f) => (L[e] ||= []).push(f),
    request: async ({ method, params }) => {
      const mode = window.__mode;
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [window.__addr];
      if (method === "eth_chainId") return mode === "wrongid" ? "0x1" : "0x" + (84532).toString(16);
      if (method === "wallet_switchEthereumChain") { window.__mode = "sync"; return null; }
      if (method === "eth_sendTransaction") { window.__sends++; throw Object.assign(new Error("User rejected the request."), { code: 4001 }); }
      const lag = mode.startsWith("lag") ? Number(mode.slice(3)) : 0;
      if (method === "eth_blockNumber" && lag) return "0x" + (parseInt((await rpc(method, [])).result, 16) - lag).toString(16);
      if (mode === "down" && (method === "eth_blockNumber" || method === "eth_getBlockByNumber")) throw Object.assign(new Error("Internal JSON-RPC error."), { code: -32603 });
      if (mode === "flaky" && method === "eth_getBlockByNumber" && window.__flaky++ < 2) throw Object.assign(new Error("Request timed out"), { code: -32603 });
      const r = await rpc(method, params);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.result;
    },
  };
}

// Signing stand-in for an ISOLATED local chain: holds throwaway private keys and signs real transactions
// (EIP-155, nonce, gas) with ethers, like a wallet would, then sends them with eth_sendRawTransaction.
// window.__mode: sync | down | other (wallet RPC = a different chain with the same id) | wrongid | reject
function signingWallet(keys, rpcUrl, otherRpcUrl) {
  window.__mode = "sync"; window.__sends = 0; window.__idx = 0;
  const L = {};
  const url = () => (window.__mode === "other" ? otherRpcUrl : rpcUrl);
  const rpc = (m, p) => fetch(url(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
  const wallet = () => new ethers.Wallet(keys[window.__idx], new ethers.JsonRpcProvider(url(), undefined, { staticNetwork: true }));
  window.__setAccount = (i) => { window.__idx = i; (L.accountsChanged || []).forEach((f) => f([wallet().address])); };
  window.ethereum = {
    on: (e, f) => (L[e] ||= []).push(f),
    request: async ({ method, params }) => {
      const mode = window.__mode;
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [wallet().address];
      if (method === "eth_chainId" && mode === "wrongid") return "0x1";
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") { window.__mode = "sync"; return null; }
      if (mode === "down" && (method === "eth_blockNumber" || method === "eth_getBlockByNumber")) throw Object.assign(new Error("Internal JSON-RPC error."), { code: -32603 });
      if (method === "eth_sendTransaction") {
        if (mode === "reject") throw Object.assign(new Error("User rejected the request."), { code: 4001 });
        window.__sends++;
        const { to, data, value } = params[0];
        const tx = await wallet().sendTransaction({ to, data, value: value ?? 0 });
        return tx.hash;
      }
      const r = await rpc(method, params);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
      return r.result;
    },
  };
}

// LOCAL CHAINS ONLY: acts as `address` and sends via anvil's account impersonation (no key exists here).
// Used where a test needs a specific real wallet (e.g. the V1 issuer) to sign on an isolated fork.
function impersonatingWallet(address, rpcUrl) {
  window.__sends = 0;
  const rpc = (m, p) => fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }).then((r) => r.json());
  window.ethereum = {
    on: () => {},
    request: async ({ method, params }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "eth_sendTransaction") { window.__sends++; params = [{ ...params[0], from: address }]; }
      const r = await rpc(method, params);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data });
      return r.result;
    },
  };
}

// ---- page helpers ----
async function openPage(browser, url, { width = 1366, height = 900, wallet, args = [] } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: width < 768 ? 2 : 1 });
  page.__errors = [];
  page.on("pageerror", (e) => page.__errors.push(e.message));
  if (wallet) await page.evaluateOnNewDocument(wallet, ...args);
  await page.goto(url, { waitUntil: "networkidle0" });
  await sleep(1500);
  return page;
}
const txt = (p, s) => p.$eval(s, (e) => e.innerText).catch(() => "");
const visible = (p, s) => p.$eval(s, (e) => !e.hidden && e.offsetParent !== null).catch(() => false);
const nav = async (p, page, ms = 400) => {
  // on narrow app screens, go through the drawer like a user would (the landing page has no app menu)
  if (await p.$eval("#menuBtn", (b) => b.offsetParent !== null && getComputedStyle(b).display !== "none")) { await p.click("#menuBtn"); await sleep(300); }
  await p.$eval(`.nav-item[data-page="${page}"]`, (b) => b.click());
  await sleep(ms);
};
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const waitText = (p, sel, re, timeout = 20000) => p.waitForFunction((s, r) => new RegExp(r).test(document.querySelector(s)?.innerText ?? ""), { timeout }, sel, re.source).then(() => true).catch(() => false);
// Submits a form and waits until its status line settles on ok/err (not the transient "Checking…" states).
async function submit(p, formId, timeout = 40000) {
  await p.$eval(`#${formId}`, (f) => { f.querySelector(".msg").textContent = ""; f.requestSubmit(); });
  await p.waitForFunction((f) => { const m = document.querySelector(`#${f} .msg`); return (m.classList.contains("ok") || m.classList.contains("err")) && !/Checking|Confirm in your wallet|waiting/.test(m.textContent); }, { timeout }, formId).catch(() => {});
  return txt(p, `#${formId} .msg`);
}
async function confirmCard(p, formId, timeout = 40000) {
  await p.waitForSelector(`#${formId} .confirm-card [data-ok]`, { timeout: 15000 });
  await p.$eval(`#${formId} .confirm-card [data-ok]`, (b) => b.click());
  await p.waitForFunction((f) => { const m = document.querySelector(`#${f} .msg`); return (m.classList.contains("ok") || m.classList.contains("err")) && !/Checking|Confirm in your wallet|waiting/.test(m.textContent); }, { timeout }, formId).catch(() => {});
  return txt(p, `#${formId} .msg`);
}
async function shot(p, name, full = true) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const vp = p.viewport();
  if (full) { await p.evaluate(() => window.scrollTo(0, 0)); const h = await p.evaluate(() => document.documentElement.scrollHeight); await p.setViewport({ ...vp, height: Math.max(vp.height, h) }); await sleep(300); }
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  if (full) await p.setViewport(vp);
}

function summary() {
  const pass = results.filter((r) => r.ok).length, fail = results.length - pass;
  console.log(`\n=== ${pass} passed, ${fail} failed (of ${results.length}) ===`);
  for (const r of results.filter((x) => !x.ok)) console.log(`FAIL [${r.section}] ${r.name}: ${r.detail}`);
  return fail;
}

module.exports = { LIVE, ADMIN, sleep, loadConfig, loadDemo, group, check, results, summary, serveDocs, launch, readOnlyWallet, signingWallet, impersonatingWallet, openPage, txt, visible, nav, overflow, waitText, submit, confirmCard, shot };
