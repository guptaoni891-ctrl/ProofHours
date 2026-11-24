// Operational helpers shared by the services (Stage 6): per-client rate limiting, request metrics and JSON access logs.
// Logs carry the path only (no query strings, no headers), so search text, tokens and wallets never reach them.
"use strict";

function createOps({ service, limit = Infinity, windowMs = 60_000, log = false, now = () => Date.now() }) {
  const hits = new Map(), lat = [], stats = { started: now(), requests: 0, byStatus: {}, rateLimited: 0 };
  const pct = (p) => { if (!lat.length) return null; const s = [...lat].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 100) / 100; };
  return {
    // Fixed window per client address. Returns seconds to wait, or 0 when the request may go ahead.
    throttle(req) {
      if (limit === Infinity) return 0;
      const key = req.socket.remoteAddress ?? "?", t = now();
      let h = hits.get(key);
      if (!h || t >= h.reset) { h = { count: 0, reset: t + windowMs }; hits.set(key, h); }
      if (++h.count <= limit) return 0;
      stats.rateLimited++;
      if (hits.size > 10_000) for (const [k, v] of hits) if (t >= v.reset) hits.delete(k); // keep memory bounded
      return Math.ceil((h.reset - t) / 1000);
    },
    record(req, status, ms) {
      stats.requests++;
      stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
      lat.push(ms);
      if (lat.length > 2000) lat.shift();
      if (log) console.log(JSON.stringify({ t: new Date(now()).toISOString(), service, method: req.method, path: new URL(req.url, "http://x").pathname, status, ms: Math.round(ms * 10) / 10 }));
    },
    metrics: () => ({ service, uptimeS: Math.round((now() - stats.started) / 1000), requests: stats.requests, byStatus: stats.byStatus, rateLimited: stats.rateLimited, latencyMs: { p50: pct(50), p95: pct(95), p99: pct(99), window: lat.length }, limitPerMinute: limit === Infinity ? null : Math.round((limit * 60_000) / windowMs) }),
  };
}

module.exports = { createOps };
