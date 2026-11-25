// Operational helpers shared by the services (Stage 6): per-client rate limiting, request metrics and JSON access logs.
// Logs carry the path only (no query strings, no headers), so search text, tokens and wallets never reach them.
"use strict";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_CLIENTS = 10_000;

function createOps({ service, limit = Infinity, windowMs = 60_000, log = false, now = () => Date.now(), trustProxy = false }) {
  const hits = new Map(), lat = [], stats = { started: now(), requests: 0, byStatus: {}, rateLimited: 0 };
  const pct = (p) => { if (!lat.length) return null; const s = [...lat].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 100) / 100; };
  // Behind a reverse proxy every socket is the proxy itself, so with TRUST_PROXY=1 the client is the address the proxy
  // appended last to X-Forwarded-For (earlier entries are whatever the client claimed, so they are ignored).
  const clientIp = (req) => {
    if (trustProxy) {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress ?? "?";
  };
  return {
    clientIp,
    // Fixed window per client address. Returns seconds to wait, or 0 when the request may go ahead.
    throttle(req) {
      if (limit === Infinity) return 0;
      const key = clientIp(req), t = now();
      let h = hits.get(key);
      if (!h || t >= h.reset) {
        if (!h && hits.size >= MAX_CLIENTS) for (const [k, v] of hits) if (t >= v.reset) hits.delete(k); // keep memory bounded
        h = { count: 0, reset: t + windowMs };
        hits.set(key, h);
      }
      if (++h.count <= limit) return 0;
      stats.rateLimited++;
      return Math.ceil((h.reset - t) / 1000);
    },
    // /metrics: with METRICS_TOKEN set it needs "Authorization: Bearer <token>"; without one, loopback clients only.
    metricsAllowed(req, token) {
      if (token) { const got = Buffer.from(String(req.headers.authorization ?? "")), want = Buffer.from(`Bearer ${token}`); return got.length === want.length && require("node:crypto").timingSafeEqual(got, want); }
      if (!trustProxy && req.headers["x-forwarded-for"]) return false; // came through a proxy we weren't told to trust
      return LOOPBACK.has(clientIp(req));
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
