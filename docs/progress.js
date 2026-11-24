// ProofHours V2 progress rules (Stage 4). Pure functions over VERIFIED on-chain data only: latest record entries from
// ProofHoursLedger (revoked = 0 hours) and the totals it keeps. Nothing here can be raised by the volunteer.
// Loaded by the page (window.Progress) and by the Node tests (module.exports).
(function (root) {
  const TOTAL_T = [10, 25, 50, 100, 250, 500];
  const CAT_T = [10, 50, 100, 250, 500];

  // Civic level: reaching level n takes 5·n·(n−1)/2 verified hours (L2 at 5h, L3 15h, L4 30h, L5 50h, L10 225h…).
  const levelFloor = (n) => (5 * n * (n - 1)) / 2;
  function level(hours) {
    let n = 1;
    while (levelFloor(n + 1) <= hours) n++;
    return { level: n, floor: levelFloor(n), next: levelFloor(n + 1), into: hours - levelFloor(n), need: levelFloor(n + 1) - hours };
  }

  // Weeks start on Monday (UTC). Day 0 (1970-01-01) was a Thursday.
  const weekOf = (day) => Math.floor((day + 3) / 7);

  // Weekly streak with freeze shields, deterministic:
  // - a week is active if at least one verified, non-revoked V2 record has its service day in it;
  // - every 4th consecutive active week earns a shield (at most 2 held);
  // - a missed week uses a shield if one is held (the streak survives but doesn't grow), otherwise the streak resets;
  // - the current week never breaks a streak: it isn't over yet.
  function streak(serviceDays, today) {
    const active = new Set(serviceDays.filter((d) => d > 0).map(weekOf));
    const now = weekOf(today);
    if (!active.size) return { weeks: 0, best: 0, shields: 0, frozen: 0, activeThisWeek: false };
    let weeks = 0, best = 0, shields = 0, frozen = 0, run = 0;
    for (let w = Math.min(...active); w <= now; w++) {
      if (active.has(w)) {
        weeks++; run++;
        if (run % 4 === 0 && shields < 2) shields++;
      } else if (w === now) {
        // in progress
      } else if (shields > 0) {
        shields--; frozen++; run = 0;
      } else {
        weeks = 0; run = 0; frozen = 0;
      }
      best = Math.max(best, weeks);
    }
    return { weeks, best, shields, frozen, activeThisWeek: active.has(now) };
  }

  // Skill trees: tiers reached per impact area.
  const trees = (catHours) => catHours.map((h) => ({ hours: h, tiers: CAT_T.map((t) => ({ threshold: t, reached: h >= t })), next: CAT_T.find((t) => h < t) ?? null }));

  // Polymath: breadth across areas (computed title, not an on-chain badge).
  function polymath(catHours) {
    const areas = catHours.filter((h) => h >= 10).length;
    return { areas, tier: areas >= 5 ? 2 : areas >= 3 ? 1 : 0 };
  }

  // Impact Companion stage (0–4) grows with civic level.
  const companion = (lvl) => (lvl >= 10 ? 4 : lvl >= 7 ? 3 : lvl >= 4 ? 2 : lvl >= 2 ? 1 : 0);

  // "First Spark": the starter quest. Opting in is a real first step, so new volunteers start with progress.
  const firstSpark = ({ opted, total }) => [
    { label: "Opt in to receive verified hours", done: !!opted },
    { label: "Get your first verified hour from an NGO", done: total >= 1 },
    { label: "Reach 10 verified hours (your first badge)", done: total >= 10 },
  ];

  // Labelled estimate of the value of volunteer time. Never a payment or something earned.
  const twin = (hours, rate) => (rate && rate.perHour > 0 ? Math.round(hours * rate.perHour) : null);

  const api = { TOTAL_T, CAT_T, level, levelFloor, weekOf, streak, trees, polymath, companion, firstSpark, twin };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Progress = api;
})(typeof window !== "undefined" ? window : globalThis);
