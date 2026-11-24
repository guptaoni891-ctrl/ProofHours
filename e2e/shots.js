// Visual QA: screenshots of every screen at the target widths (read-only; the wallet stand-in never sends).
// node shots.js [widths]   e.g. node shots.js 360,1440
const L = require("./lib");

(async () => {
  const widths = (process.argv[2] || "360,390,768,1440,1920").split(",").map(Number);
  const server = await L.serveDocs(8797);
  const b = await L.launch();
  const errors = [];
  for (const w of widths) {
    const h = w < 768 ? 800 : w < 1200 ? 1024 : 900;
    const p = await L.openPage(b, server.url, { width: w, height: h, wallet: L.readOnlyWallet, args: [L.ADMIN, L.LIVE.walletRpc] });
    await L.sleep(3500);
    const over = [];
    const snap = async (name) => { if (await L.overflow(p)) over.push(name); await L.shot(p, `ui-${w}-${name}`); };
    await snap("landing");
    await L.nav(p, "verify"); await p.$eval('[data-demo="S-002"]', (x) => x.click()); await L.sleep(5500); await snap("verify");
    await L.nav(p, "impact"); await p.$eval('[data-impact-demo="S-002"]', (x) => x.click()); await L.sleep(4500); await snap("impact");
    await L.nav(p, "coord", 3500); await snap("coord");
    await L.nav(p, "admin", 2500);
    await p.evaluate(() => { document.querySelector("#aRevAddr").value = "0x000000000000000000000000000000000000dEaD"; document.querySelector("#revForm").requestSubmit(); });
    await p.waitForSelector("#revForm .confirm-card", { timeout: 15000 }).catch(() => {});
    await snap("admin");
    await L.nav(p, "demo", 500); await p.$eval('[data-refusal="overHours"]', (x) => x.click()); await L.sleep(4000); await snap("demo");
    await L.nav(p, "network", 6000); await snap("network");
    if (w < 1025) { await p.click("#menuBtn"); await L.sleep(350); await p.screenshot({ path: require("path").join(__dirname, "..", "screenshots", `ui-${w}-drawer.png`) }); await p.keyboard.press("Escape"); }
    console.log(`${w}px: overflow on [${over.join(", ") || "none"}]`);
    errors.push(...p.__errors);
    await p.close();
  }
  console.log("page errors:", errors.join("; ") || "none");
  await b.close(); server.close();
})();
