// Progress rules (docs/progress.js): node --test server/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../docs/progress.js");

// 2026-11-23 is a Monday (UTC); helper for "Monday of week k after it"
const MON = Math.floor(Date.UTC(2026, 10, 23) / 86400000);
const wk = (k, dayOfWeek = 2) => MON + 7 * k + dayOfWeek;

test("civic level curve", () => {
  assert.deepEqual([0, 4, 5, 14, 15, 30, 50, 224, 225].map((h) => P.level(h).level), [1, 1, 2, 2, 3, 4, 5, 9, 10]);
  assert.deepEqual(P.level(12), { level: 2, floor: 5, next: 15, into: 7, need: 3 });
});

test("weeks start on Monday", () => {
  assert.equal(P.weekOf(MON), P.weekOf(MON + 6));
  assert.equal(P.weekOf(MON + 7), P.weekOf(MON) + 1);
  assert.equal(P.weekOf(MON - 1), P.weekOf(MON) - 1);
});

test("streak: consecutive active weeks, current week never breaks it", () => {
  assert.deepEqual(P.streak([], wk(0)), { weeks: 0, best: 0, shields: 0, frozen: 0, activeThisWeek: false });
  assert.equal(P.streak([wk(0), wk(1), wk(2)], wk(2)).weeks, 3);
  assert.equal(P.streak([wk(0), wk(1), wk(2)], wk(3)).weeks, 3, "this week isn't over");
  assert.equal(P.streak([wk(0), wk(1), wk(2)], wk(4)).weeks, 0, "a full missed week with no shield resets");
  assert.equal(P.streak([wk(0), wk(0, 4), wk(0, 6)], wk(0)).weeks, 1, "several days in one week count once");
  assert.equal(P.streak([0, wk(0)], wk(0)).weeks, 1, "V1 imports (service day 0) don't count");
});

test("streak freeze shields: earned every 4th active week, max 2, spent on a missed week", () => {
  const four = [0, 1, 2, 3].map((k) => wk(k));
  assert.equal(P.streak(four, wk(3)).shields, 1);
  const s = P.streak([...four, wk(5)], wk(5)); // week 4 missed
  assert.deepEqual([s.weeks, s.shields, s.frozen], [5, 0, 1], "shield used, streak survives (5 active weeks)");
  const twoGaps = P.streak([...four, wk(6)], wk(6)); // weeks 4 and 5 missed, one shield
  assert.deepEqual([twoGaps.weeks, twoGaps.best], [1, 4], "second miss without a shield resets");
  const twelve = Array.from({ length: 12 }, (_, k) => wk(k));
  assert.equal(P.streak(twelve, wk(11)).shields, 2, "at most 2 shields held");
  assert.deepEqual(P.streak(twelve, wk(11)), P.streak([...twelve].reverse(), wk(11)), "order-independent");
});

test("skill trees, polymath, companion, first spark, twin", () => {
  const t = P.trees([55, 0, 10, 9, 500]);
  assert.deepEqual(t.map((a) => a.tiers.filter((x) => x.reached).length), [2, 0, 1, 0, 5]);
  assert.deepEqual(t.map((a) => a.next), [100, 10, 50, 10, null]);
  assert.deepEqual([P.polymath([10, 10, 9, 0, 0]).tier, P.polymath([10, 10, 10, 0, 0]).tier, P.polymath([10, 10, 10, 10, 10]).tier], [0, 1, 2]);
  assert.deepEqual([1, 2, 4, 7, 10].map(P.companion), [0, 1, 2, 3, 4]);
  assert.deepEqual(P.firstSpark({ opted: true, total: 0 }).map((s) => s.done), [true, false, false], "opting in is real progress");
  assert.equal(P.twin(10, { perHour: 36.14 }), 361);
  assert.equal(P.twin(10, null), null);
});
