// Attendance service tests: node --test server/  (real HTTP, real wallet signatures with throwaway keys, fake chain, fake clock)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { ethers } = require("ethers");
const { createApp, openDb, QR_WINDOW } = require("./attendance");

const T0 = Date.UTC(2026, 10, 24, 8, 0, 0); // 08:00 UTC
const DAY = Math.floor(T0 / 86400000);
const sec = (ms) => Math.floor(ms / 1000);

async function setup() {
  const [coord, coord2, vol, vol2, outsider] = Array.from({ length: 5 }, () => ethers.Wallet.createRandom());
  let clock = T0;
  const chain = {
    orgs: { [coord.address]: 1, [coord2.address]: 2 },
    events: { 1: { orgId: 1, maxHours: 12, serviceDay: DAY }, 2: { orgId: 1, maxHours: 4, serviceDay: DAY }, 3: { orgId: 1, maxHours: 8, serviceDay: DAY } },
    opted: new Set([vol.address, vol2.address]),
    suspended: {},
    logs: {},
    coordinatorOrg: async (a) => chain.orgs[a] || 0,
    optedIn: async (a) => chain.opted.has(a),
    orgSuspended: async (id) => !!chain.suspended[id],
    event: async (id) => chain.events[id] ?? null,
    issued: async (h) => chain.logs[h] ?? [],
    recs: {},
    totalHours: async (a) => (chain.recs[a] ?? []).reduce((x, r) => x + r.hours, 0),
    records: async (a) => chain.recs[a] ?? [],
  };
  const server = http.createServer(createApp({ db: openDb(":memory:"), chain, secret: "test-secret", chainId: 31337, now: () => clock }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const signIn = async (w) => {
    const { body: n } = await call("POST", "/auth/nonce", null, { address: w.address });
    const { body } = await call("POST", "/auth", null, { address: w.address, nonce: n.nonce, signature: await w.signMessage(n.message) });
    return body.token;
  };
  const tok = {};
  const refresh = async () => { for (const [k, w] of Object.entries({ coord, coord2, vol, vol2, outsider })) tok[k] = await signIn(w); };
  await refresh();
  const shift = async (over = {}) => (await call("POST", "/shifts", tok.coord, { eventId: 1, start: sec(T0) - 600, end: sec(T0) + 4 * 3600, capacity: 10, ...over })).body;
  const qr = async (id, kind = "in") => (await call("GET", `/shifts/${id}/qr?kind=${kind}`, tok.coord)).body.token;
  return { coord, coord2, vol, vol2, outsider, chain, wallets: { coord, coord2, vol, vol2, outsider }, call, signIn, tok, shift, qr, advance: async (s, keepSessions) => { clock += s * 1000; if (!keepSessions) await refresh(); }, /* sessions last 2 h */ close: () => server.close() };
}

test("sign-in: one-time nonce, wallet must match, tokens can't be forged or outlive their expiry", async (t) => {
  const s = await setup();
  t.after(s.close);
  const { body: n } = await s.call("POST", "/auth/nonce", null, { address: s.vol.address });
  const sig = await s.vol.signMessage(n.message);
  assert.equal((await s.call("POST", "/auth", null, { address: s.vol.address, nonce: n.nonce, signature: sig })).status, 200);
  assert.equal((await s.call("POST", "/auth", null, { address: s.vol.address, nonce: n.nonce, signature: sig })).status, 401, "nonce replay");
  const { body: n2 } = await s.call("POST", "/auth/nonce", null, { address: s.vol.address });
  const r = await s.call("POST", "/auth", null, { address: s.vol.address, nonce: n2.nonce, signature: await s.outsider.signMessage(n2.message) });
  assert.equal(r.status, 401, "someone else's signature");
  const [a, exp, mac] = s.tok.vol.split(".");
  assert.equal((await s.call("GET", "/me/attendance", `${s.outsider.address}.${exp}.${mac}`)).status, 401, "token moved to another wallet");
  assert.equal((await s.call("GET", "/me/attendance", `${a}.${Number(exp) + 9999}.${mac}`)).status, 401, "expiry extended");
  await s.advance(2 * 3600 + 1, true);
  assert.match((await s.call("GET", "/me/attendance", s.tok.vol)).body.error, /expired/);
});

test("shifts: only the event's own NGO coordinator; times validated", async (t) => {
  const s = await setup();
  t.after(s.close);
  const sh = await s.shift({ site: { lat: 25.2, lng: 55.27, radius: 200 } });
  assert.deepEqual([sh.id, sh.eventId, sh.capacity, sh.site.radius], [1, 1, 10, 200]);
  assert.equal((await s.call("POST", "/shifts", s.tok.vol, { eventId: 1, start: sec(T0), end: sec(T0) + 3600, capacity: 1 })).status, 403);
  assert.equal((await s.call("POST", "/shifts", s.tok.coord2, { eventId: 1, start: sec(T0), end: sec(T0) + 3600, capacity: 1 })).status, 403, "other NGO");
  assert.equal((await s.call("POST", "/shifts", s.tok.coord, { eventId: 99, start: sec(T0), end: sec(T0) + 3600, capacity: 1 })).status, 404);
  assert.equal((await s.call("POST", "/shifts", s.tok.coord, { eventId: 1, start: sec(T0), end: sec(T0), capacity: 1 })).status, 400);
  assert.equal((await s.call("POST", "/shifts", s.tok.coord, { eventId: 1, start: sec(T0) + 5 * 86400, end: sec(T0) + 5 * 86400 + 3600, capacity: 1 })).status, 400, "not on the service date");
  s.chain.suspended[1] = true;
  assert.match((await s.call("POST", "/shifts", s.tok.coord, { eventId: 1, start: sec(T0), end: sec(T0) + 3600, capacity: 1 })).body.error, /suspended/);
  s.chain.suspended[1] = false;
  assert.equal((await s.call("GET", `/shifts/${sh.id}/qr`, s.tok.vol)).status, 403, "volunteers can't fetch QR codes");
  assert.equal((await s.call("GET", `/shifts/${sh.id}/qr`, s.tok.coord2)).status, 403);
  assert.equal((await s.call("GET", "/shifts", s.tok.coord)).body.length, 1);
});

test("opportunities: public list of shifts that haven't ended, with spots taken and no attendee data", async (t) => {
  const s = await setup();
  t.after(s.close);
  const a = await s.shift(), b = await s.shift({ eventId: 2, start: sec(T0) + 3600, end: sec(T0) + 2 * 3600 });
  await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(a.id) });
  const list = (await s.call("GET", "/opportunities")).body; // no sign-in needed
  assert.deepEqual(list.map((o) => [o.id, o.attending, o.capacity]), [[a.id, 1, 10], [b.id, 0, 10]]);
  assert.ok(!JSON.stringify(list).includes(s.vol.address), "no volunteer wallets");
  await s.advance(5 * 3600, true);
  assert.deepEqual((await s.call("GET", "/opportunities")).body, [], "ended shifts drop off");
});

test("QR codes: forged, wrong kind, expired and replayed codes are refused", async (t) => {
  const s = await setup();
  t.after(s.close);
  const sh = await s.shift();
  const token = await s.qr(sh.id);
  const [id, kind, win, mac] = token.split(".");
  assert.match((await s.call("POST", "/checkin", s.tok.vol, { token: `${id}.${kind}.${win}.${mac.replace(/^./, (c) => (c === "A" ? "B" : "A"))}` })).body.error, /not valid/);
  assert.match((await s.call("POST", "/checkin", s.tok.vol, { token: `${id}.${kind}.${Number(win) + 5}.${mac}` })).body.error, /not valid/, "window can't be edited");
  assert.match((await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(sh.id, "out") })).body.error, /check-out code/);
  assert.equal((await s.call("POST", "/checkin", s.tok.outsider, { token })).status, 403, "wallet not opted in");
  const ok = await s.call("POST", "/checkin", s.tok.vol, { token, atSite: true });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.status, ok.body.atSiteIn], ["checked_in", true]);
  assert.match((await s.call("POST", "/checkin", s.tok.vol, { token })).body.error, /already checked in/, "replay");
  await s.advance(2 * QR_WINDOW);
  assert.match((await s.call("POST", "/checkin", s.tok.vol2, { token })).body.error, /expired/);
  assert.equal((await s.call("POST", "/checkin", s.tok.vol2, { token: await s.qr(sh.id) })).status, 200, "a fresh code works");
});

test("check-in rules: window, capacity, no overlapping attendance, one per event", async (t) => {
  const s = await setup();
  t.after(s.close);
  const later = await s.shift({ start: sec(T0) + 3 * 3600, end: sec(T0) + 5 * 3600 });
  assert.match((await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(later.id) })).body.error, /opens 30 minutes before/);
  const one = await s.shift({ capacity: 1 });
  assert.equal((await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(one.id) })).status, 200);
  assert.match((await s.call("POST", "/checkin", s.tok.vol2, { token: await s.qr(one.id) })).body.error, /full/);
  const other = await s.shift({ eventId: 2 });
  assert.match((await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(other.id) })).body.error, /still checked in to shift #2/, "overlap");
  assert.equal((await s.call("POST", "/checkout", s.tok.vol, { token: await s.qr(one.id, "out") })).status, 200);
  const sameEvent = await s.shift();
  assert.match((await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(sameEvent.id) })).body.error, /one record per volunteer per event/);
  assert.equal((await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(other.id) })).status, 200, "after checking out, another event is fine");
  assert.match((await s.call("POST", "/checkout", s.tok.vol2, { token: await s.qr(one.id, "out") })).body.error, /not checked in/);
  await s.advance(7 * 3600);
  assert.match((await s.call("POST", "/checkout", s.tok.vol, { token: await s.qr(other.id, "out") })).body.error, /closed 2 hours after/);
});

test("approval: QR and location alone issue nothing; durations computed and capped; only the NGO's coordinator decides", async (t) => {
  const s = await setup();
  t.after(s.close);
  const sh = await s.shift({ eventId: 3, start: sec(T0) - 3600, end: sec(T0) + 10 * 3600 });
  const a = (await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(sh.id), atSite: true, lat: 1, lng: 2 })).body;
  assert.equal(a.atSiteIn, true);
  assert.match((await s.call("POST", `/attendance/${a.id}/approve`, s.tok.coord)).body.error, /not checked out/);
  await s.advance(9.5 * 3600);
  const out = (await s.call("POST", "/checkout", s.tok.vol, { token: await s.qr(sh.id, "out"), atSite: "yes" })).body;
  assert.deepEqual([out.status, out.atSiteOut], ["checked_out", null], "only real booleans are stored");
  assert.deepEqual((await s.call("GET", `/shifts/${sh.id}/issuable`, s.tok.coord)).body.volunteers, [], "checked in and out, but nothing to issue before approval");
  const list = (await s.call("GET", `/shifts/${sh.id}/attendance`, s.tok.coord)).body;
  assert.equal(list[0].hours, 8, "9.5 h attended, capped at the event's 8 h maximum");
  assert.equal((await s.call("GET", `/shifts/${sh.id}/attendance`, s.tok.vol)).status, 403, "volunteers can't list others' attendance");
  assert.equal((await s.call("POST", `/attendance/${a.id}/approve`, s.tok.vol)).status, 403, "can't approve yourself");
  assert.equal((await s.call("POST", `/attendance/${a.id}/approve`, s.tok.coord2)).status, 403, "other NGO");
  const ok = (await s.call("POST", `/attendance/${a.id}/approve`, s.tok.coord)).body;
  assert.equal(ok.status, "approved");
  assert.equal(ok.evidenceHash, ethers.id(ok.evidence));
  const ev = JSON.parse(ok.evidence);
  assert.deepEqual([ev.hours, ev.volunteer, ev.atSiteIn, ev.approvedBy], [8, s.vol.address, true, s.coord.address]);
  assert.ok(!("lat" in ev) && !ok.evidence.includes('"lng"'), "no coordinates anywhere");
  assert.match((await s.call("POST", `/attendance/${a.id}/approve`, s.tok.coord)).body.error, /already approved/);
  const iss = (await s.call("GET", `/shifts/${sh.id}/issuable`, s.tok.coord)).body;
  assert.deepEqual([iss.eventId, iss.volunteers, iss.hours, iss.evidence], [3, [s.vol.address], [8], [ok.evidenceHash]]);
});

test("rejection and sub-hour attendance", async (t) => {
  const s = await setup();
  t.after(s.close);
  const sh = await s.shift();
  const a = (await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(sh.id) })).body;
  const b = (await s.call("POST", "/checkin", s.tok.vol2, { token: await s.qr(sh.id) })).body;
  await s.advance(50 * 60);
  await s.call("POST", "/checkout", s.tok.vol, { token: await s.qr(sh.id, "out") });
  assert.match((await s.call("POST", `/attendance/${a.id}/approve`, s.tok.coord)).body.error, /Less than one full hour/);
  assert.equal((await s.call("POST", `/attendance/${b.id}/reject`, s.tok.coord, {})).status, 400, "reason required");
  const r = (await s.call("POST", `/attendance/${b.id}/reject`, s.tok.coord, { reason: "Left early (demo)" })).body;
  assert.deepEqual([r.status, r.reason], ["rejected", "Left early (demo)"]);
  assert.match((await s.call("POST", `/attendance/${b.id}/approve`, s.tok.coord)).body.error, /already rejected/);
});

test("issued: marked only when the chain shows the matching event, wallet and evidence hash", async (t) => {
  const s = await setup();
  t.after(s.close);
  const sh = await s.shift();
  const a = (await s.call("POST", "/checkin", s.tok.vol, { token: await s.qr(sh.id) })).body;
  await s.advance(3 * 3600);
  await s.call("POST", "/checkout", s.tok.vol, { token: await s.qr(sh.id, "out") });
  const ok = (await s.call("POST", `/attendance/${a.id}/approve`, s.tok.coord)).body;
  const bad = ethers.id("tx-bad"), good = ethers.id("tx-good");
  s.chain.logs[bad] = [{ recordId: "7", eventId: 1, volunteer: s.vol.address, evidenceHash: ethers.id("something else") }];
  s.chain.logs[good] = [{ recordId: "8", eventId: 1, volunteer: s.vol.address, evidenceHash: ok.evidenceHash }];
  assert.equal((await s.call("POST", `/shifts/${sh.id}/issued`, s.tok.coord, { txHash: bad })).body.marked, 0);
  assert.equal((await s.call("POST", `/shifts/${sh.id}/issued`, s.tok.coord, { txHash: "0x12" })).status, 400);
  assert.equal((await s.call("POST", `/shifts/${sh.id}/issued`, s.tok.coord, { txHash: good })).body.marked, 1);
  const [mine] = (await s.call("GET", "/me/attendance", s.tok.vol)).body;
  assert.deepEqual([mine.status, mine.recordId, mine.txHash, mine.hours], ["issued", "8", good, 3]);
});

test("leagues: opt-in only, aliases not wallets, near-me strip only, season scores from verified hours, leaving removes you", async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.deepEqual((await s.call("GET", "/league/me", s.tok.vol)).body, { joined: false });
  assert.match((await s.call("POST", "/league/join", s.tok.outsider)).body.error, /Opt in on your passport first/);
  // ten opted-in members with verified hours this season (T0 is 24 Nov 2026), plus older and V1-imported hours that don't count
  const extra = await Promise.all(Array.from({ length: 8 }, async () => { const w = ethers.Wallet.createRandom(); s.chain.opted.add(w.address); return w; }));
  extra.forEach((w, i) => (s.chain.recs[w.address] = [{ hours: i + 1, serviceDay: DAY }]));
  s.chain.recs[s.vol.address] = [{ hours: 5, serviceDay: DAY }, { hours: 4, serviceDay: DAY - 40 }, { hours: 9, serviceDay: 0 }];
  s.chain.recs[s.vol2.address] = [{ hours: 1, serviceDay: DAY - 3 }];
  const me = (await s.call("POST", "/league/join", s.tok.vol)).body;
  assert.equal(me.hours, 5, "only this season's verified service counts (not last month's 4h, not the V1 import)");
  await s.call("POST", "/league/join", s.tok.vol2);
  for (const w of extra) await s.call("POST", "/league/join", await s.signIn(w));
  const vol2 = (await s.call("GET", "/league/me", s.tok.vol2)).body;
  assert.equal(vol2.band, "Newcomers (under 10h)");
  const v = (await s.call("GET", "/league/me", s.tok.vol)).body;
  assert.equal(v.band, "Regulars (10–49h)", "vol has 18h lifetime, so a different band from the newcomers");
  assert.equal(v.cohortSize, 1);
  assert.equal(vol2.cohortSize, 9);
  assert.ok(vol2.strip.length <= 7 && vol2.strip.some((x) => x.you), "only 3 above, you, 3 below");
  assert.deepEqual(vol2.strip.map((x) => x.rank), [...vol2.strip.map((x) => x.rank)].sort((a, b) => a - b));
  const all = JSON.stringify([vol2, v]);
  for (const w of [s.vol, s.vol2, ...extra]) assert.ok(!all.includes(w.address) && !all.toLowerCase().includes(w.address.slice(2, 10).toLowerCase()), "no wallets in league responses");
  assert.match(vol2.alias, /^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
  await s.call("POST", "/league/leave", s.tok.vol2);
  assert.deepEqual((await s.call("GET", "/league/me", s.tok.vol2)).body, { joined: false });
  const other = (await s.call("GET", "/league/me", await s.signIn(extra[0]))).body;
  assert.equal(other.cohortSize, 8, "a member who left is ranked nowhere");
});

test("operations: rate limit returns 429 with Retry-After, metrics count requests and latency", async (t) => {
  let clock = T0;
  const server = http.createServer(createApp({ db: openDb(":memory:"), chain: {}, secret: "s", chainId: 31337, now: () => clock, rateLimit: 3 }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const get = (p) => fetch(`http://127.0.0.1:${server.address().port}${p}`);
  assert.deepEqual(await Promise.all([1, 2, 3].map(async () => (await get("/health")).status)), [200, 200, 200]);
  const limited = await get("/health");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.match((await limited.json()).error, /Too many requests/);
  clock += 60_000; // a new window
  const m = await (await get("/metrics")).json();
  assert.deepEqual([m.service, m.requests, m.byStatus["200"], m.byStatus["429"], m.rateLimited, m.limitPerMinute], ["attendance", 4, 3, 1, 1, 3]);
  assert.ok(m.latencyMs.p95 >= 0);
});

test("offline vouchers: coordinator-only, tamper-evident, single use, redemption window, overlap, still need approval", async (t) => {
  const s = await setup();
  t.after(s.close);
  const sh = await s.shift({ start: sec(T0) - 4 * 3600, end: sec(T0) - 3600 }); // a 3h shift that has ended
  assert.equal((await s.call("POST", `/shifts/${sh.id}/vouchers`, s.tok.vol, { count: 2 })).status, 403);
  assert.equal((await s.call("POST", `/shifts/${sh.id}/vouchers`, s.tok.coord2, { count: 2 })).status, 403, "other NGO");
  const { codes } = (await s.call("POST", `/shifts/${sh.id}/vouchers`, s.tok.coord, { count: 3 })).body;
  assert.equal(codes.length, 3);
  assert.match(codes[0], /^PH-\d+-[0-9A-F]{8}-[0-9A-F]{10}$/);
  const forged = codes[0].slice(0, -1) + (codes[0].endsWith("A") ? "B" : "A");
  assert.match((await s.call("POST", "/vouchers/redeem", s.tok.vol, { code: forged })).body.error, /not valid/);
  assert.equal((await s.call("POST", "/vouchers/redeem", s.tok.outsider, { code: codes[0] })).status, 403, "consent first");
  const a = (await s.call("POST", "/vouchers/redeem", s.tok.vol, { code: ` ${codes[0].toLowerCase()} ` })).body; // typed by hand: case and spaces don't matter
  assert.deepEqual([a.status, a.source, a.hours, a.checkIn, a.checkOut], ["checked_out", "voucher", 3, sh.start, sh.end]);
  assert.match((await s.call("POST", "/vouchers/redeem", s.tok.vol2, { code: codes[0] })).body.error, /already been used/, "single use");
  assert.match((await s.call("POST", "/vouchers/redeem", s.tok.vol, { code: codes[1] })).body.error, /already have attendance for this shift/);
  // overlapping shift of another event
  const other = await s.shift({ eventId: 2, start: sec(T0) - 2 * 3600, end: sec(T0) - 1800 });
  const oc = (await s.call("POST", `/shifts/${other.id}/vouchers`, s.tok.coord, { count: 1 })).body.codes[0];
  assert.match((await s.call("POST", "/vouchers/redeem", s.tok.vol, { code: oc })).body.error, /overlaps attendance/);
  assert.deepEqual((await s.call("GET", `/shifts/${sh.id}/issuable`, s.tok.coord)).body.volunteers, [], "not issuable before approval");
  const ok = (await s.call("POST", `/attendance/${a.id}/approve`, s.tok.coord)).body;
  assert.equal(JSON.parse(ok.evidence).source, "voucher", "the evidence says how attendance was recorded");
  await s.advance(8 * 86400);
  assert.match((await s.call("POST", "/vouchers/redeem", s.tok.vol2, { code: codes[2] })).body.error, /expired/);
});
