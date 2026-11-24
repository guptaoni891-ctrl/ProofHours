// ProofHours end-to-end runner: `node run.js` (live read-only + isolated fork), `node run.js live`, `node run.js fork`, `node run.js v2`, `node run.js attend`, `node run.js discover`.
// Needs Node 18+, the packages in package.json, a Chromium-based browser (or BROWSER=path), and Foundry's anvil for fork tests.
const L = require("./lib");

(async () => {
  const which = process.argv[2] || "all";
  const server = await L.serveDocs(Number(process.env.PORT || 8799));
  try {
    if (which === "all" || which === "live") await require("./live.test").run(server.url);
    if (which === "all" || which === "fork") await require("./fork.test").run(server.url);
    if (which === "all" || which === "v2") await require("./v2.test").run(server.url);
    if (which === "all" || which === "attend") await require("./attend.test").run(server.url);
    if (which === "all" || which === "discover") await require("./discover.test").run(server.url);
  } catch (e) {
    L.check("suite crashed", false, e.stack || e.message);
  } finally {
    server.close();
  }
  process.exit(L.summary() ? 1 : 0);
})();
