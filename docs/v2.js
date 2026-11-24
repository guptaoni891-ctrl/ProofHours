// ProofHours V2 screens: wallet-linked passport (totals by impact area, soulbound Trophy Vault, records, V1 links)
// and V2 issuance for NGO coordinators. Reads go through the app's public RPC reader; writes go through the
// app's send() with the same network checks, contract pre-check and Retry as V1.
// Only V2 contracts listed in config.js are used. If they are not deployed (Base Sepolia today), the screens say so.
(() => {
  const V2 = C.v2;
  const ABI = window.V2_ABI;
  const CATS = ["Environmental", "Education", "Healthcare", "Emergency response", "Inclusion"];
  const ENTRY2 = ["Original", "Correction", "Revocation", "Imported from V1"];
  const TOTAL_T = [10, 25, 50, 100, 250, 500];
  const CAT_T = [10, 50, 100, 250, 500];
  const lIface = new ethers.Interface(ABI.ledger);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  Object.assign(TX_LABEL, {
    optIn: "Opt in", requestV1Link: "Request V1 link", approveV1Link: "Approve V1 link", syncV1: "Sync V1 record",
    issueHours: "Issue hours", issueBatch: "Issue hours (batch)", correct: "Correct record", revoke: "Revoke record",
  });
  LOG_DECODERS.push((log) => {
    if (!V2 || log.address.toLowerCase() !== V2.ledger.toLowerCase()) return null;
    const e = lIface.parseLog(log), a = e?.args;
    if (!e) return null;
    if (e.name === "VolunteerOptedIn") return `${short(a.volunteer)} opted in`;
    if (e.name === "EventCreated") return `V2 event #${a.eventId} "${a.code}" created (${CATS[Number(a.category)]}, max ${a.maxHours}h)`;
    if (e.name === "HoursIssued") return `Record #${a.recordId}: ${a.hoursLogged}h ${CATS[Number(a.category)]} for ${short(a.volunteer)}`;
    if (e.name === "RecordCorrected") return `Record #${a.newRecordId} corrects #${a.replacesId} to ${a.newHours}h`;
    if (e.name === "RecordRevoked") return `Record #${a.newRecordId} revokes #${a.replacesId}`;
    if (e.name === "V1LinkRequested") return `Link to V1 record #${a.v1Id} requested`;
    if (e.name === "V1Migrated") return `V1 record #${a.v1Id} imported as #${a.recordId} (${a.hoursLogged}h)`;
    if (e.name === "OrgSuspended") return `NGO #${a.orgId} suspended`;
    return null;
  });

  const ledgerTarget = () => walletContract(V2.ledger, ABI.ledger);
  const badgesTarget = () => walletContract(V2.badges, ABI.badges);
  const bIface = new ethers.Interface(ABI.badges);
  Object.assign(TX_LABEL, { renounce: "Renounce badge", reclaim: "Reclaim badge", resyncBadges: "Re-mint badges" });
  LOG_DECODERS.push((log) => {
    if (!V2 || log.address.toLowerCase() !== V2.badges.toLowerCase()) return null;
    const e = bIface.parseLog(log), a = e?.args;
    if (e?.name === "BadgeRenounced") return `Badge #${a.tokenId} renounced and burned`;
    if (e?.name === "BadgeReclaimed") return "Badge reclaimed";
    if (e?.name === "Issued") return `Badge #${a.tokenId} minted`;
    return null;
  });
  const currentAccount = async () => (window.ethereum ? (await ethereum.request({ method: "eth_accounts" }))[0] : undefined);
  const keyOf = (v, kind, t) => ethers.keccak256(coder.encode(["address", "uint8", "uint16"], [v, kind, t]));
  const dayOf = (dateStr) => Math.floor(Date.parse(dateStr + "T00:00:00Z") / 86400000);
  const dateOf = (day) => new Date(Number(day) * 86400000).toISOString().slice(0, 10);

  async function contracts() {
    const r = (await reader()).runner;
    return { ledger: new ethers.Contract(V2.ledger, ABI.ledger, r), badges: new ethers.Contract(V2.badges, ABI.badges, r) };
  }

  // Shows an honest notice instead of the screen when V2 isn't available on this network.
  async function available(noticeId, bodyId) {
    const notice = $(noticeId), body = $(bodyId);
    const stop = (html) => { notice.innerHTML = `${ICON.info}<div>${html}</div>`; notice.hidden = false; body.hidden = true; return null; };
    if (!V2) return stop(`<strong>V2 is not deployed on ${esc(C.netName)} yet.</strong> Wallet-linked hours and soulbound badges run on the local test chain until a public deployment is approved. To try them, start the local fork, run <code>script/DeployV2.s.sol</code> and open this page with <code>?local</code>.`);
    try {
      const c = await contracts();
      if ((await c.ledger.runner.getCode(V2.ledger)) === "0x") return stop(`<strong>V2 contracts are not deployed on this local chain.</strong> Run <code>script/DeployV2.s.sol</code> against it (see the README), then reload.`);
      notice.hidden = true;
      body.hidden = false;
      return c;
    } catch (e) {
      return stop(esc(friendly(e)));
    }
  }

  const nextOf = (hours, ladder) => ladder.find((t) => hours < t);

  // ---------- Passport ----------
  // viewAddr: someone else's public passport (#passport=0x…). Everything shown is public on-chain data.
  let viewAddr = null, viewKey = null;
  async function loadPassport() {
    const c = await available("ppNotice", "ppBody");
    if (!c) return;
    const mine = await currentAccount();
    const me = viewAddr ?? mine, pub = !!viewAddr && viewAddr.toLowerCase() !== mine?.toLowerCase();
    const consent = $("ppConsent"), optForm = $("ppOptForm");
    $("ppPublic").hidden = !pub;
    $("pageTitle").textContent = document.querySelector("#passport .page-head h2").textContent = pub ? "Public passport" : "My passport";
    $("v1LinkForm").hidden = pub;
    if (pub) {
      $("ppPublic").innerHTML = `${ICON.info}<div><strong>Public passport of <code>${viewAddr}</code>.</strong> Everything here is public on-chain data anyone can read. <button type="button" class="btn btn-ghost sm" id="ppMine">View my own passport</button></div>`;
      $("ppMine").onclick = () => { viewAddr = viewKey = null; history.replaceState(null, "", location.pathname + location.search); loadPassport(); };
    }
    if (!me) {
      consent.innerHTML = `${ICON.info}<span><strong>Connect your wallet</strong> to see its passport. Your passport is tied to the wallet you volunteer with.</span>`;
      optForm.querySelector("button").hidden = true;
      $("ppSummary").innerHTML = "";
      $("ppVault").innerHTML = `<p class="muted small">Connect a wallet to see its badges.</p>`;
      $("ppRecords").innerHTML = `<li class="muted small">No wallet connected.</li>`;
      gameReady = false;
      applyMode();
      lastPassport = null;
      $("profileForm").hidden = $("ppProfileView").hidden = true;
      return;
    }
    const [opted, total, cats] = await Promise.all([c.ledger.optedIn(me), c.ledger.totalHours(me), c.ledger.categoryHours(me)]);
    optForm.querySelector("button").hidden = opted || pub;
    consent.innerHTML = pub
      ? (opted ? `${ICON.shield}<span><strong>Opted in.</strong> This wallet accepts verified hours from accredited NGOs.</span>` : `${ICON.info}<span><strong>Not opted in.</strong> NGOs can't issue hours to this wallet yet.</span>`)
      : opted
      ? `${ICON.shield}<span><strong>Receiving hours.</strong> Accredited NGOs can issue verified hours to ${short(me)}. Badges are minted to this wallet automatically.</span>`
      : `${ICON.info}<span><strong>Opt in to receive hours.</strong> NGOs can only issue hours to wallets that agreed to it. This also consents to badges being minted to this wallet; you can renounce any badge later.</span>`;
    optForm.classList.toggle("ok", opted);

    const t = Number(total), catH = cats.map(Number), next = nextOf(t, TOTAL_T);
    $("ppSummary").innerHTML = `<div class="pp-total"><span>Verified hours</span><strong>${t}</strong><small>across all impact areas, latest entries only</small></div>
      <div class="pp-next">${next ? `<div class="ms-top"><span>Next total milestone: <strong>${next}h</strong></span><span class="mono">${t} / ${next}h</span></div>
        <div class="ms-bar" role="progressbar" aria-label="Progress to ${next} hours" aria-valuemin="0" aria-valuemax="${next}" aria-valuenow="${t}"><span style="--p:${Math.round((t / next) * 100)}%"></span></div>` : `<p><strong>All total milestones earned.</strong></p>`}</div>
      <ul class="cat-list">${CATS.map((name, i) => {
        const h = catH[i], n = nextOf(h, CAT_T);
        return `<li class="cat c${i}"><span class="cat-name">${name}</span><span class="cat-bar" aria-hidden="true"><span style="--p:${n ? Math.round((h / n) * 100) : 100}%"></span></span><span class="cat-h mono">${h}h${n ? `<em> / ${n}</em>` : ""}</span></li>`;
      }).join("")}</ul>`;

    const badges = await renderVault(c, me, t, catH, !pub);
    const heads = await renderRecords(c, me);
    lastPassport = { me, own: !pub, total: t, catH, records: heads, badges };
    renderGame(t, catH, heads, opted, !pub);
    await renderLeague(!pub, opted);
    await renderProfile(!pub, me);
  }

  // ---------- Progress (Stage 4): everything below derives from verified on-chain data only ----------
  let gameReady = false;
  const MODE_KEY = "proofhours-view";
  // Arcade shows game elements; Clean is the institutional view (same verified data, no game layer).
  function applyMode() {
    const mode = localStorage.getItem(MODE_KEY) || (viewAddr ? "clean" : "arcade");
    $("ppGame").hidden = mode !== "arcade" || !gameReady;
    $("ppMode").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  }
  $("ppMode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) { localStorage.setItem(MODE_KEY, b.dataset.mode); applyMode(); } };

  const COMPANION = [
    '<svg viewBox="0 0 64 64"><path d="M8 52h48"/><ellipse cx="32" cy="48" rx="5" ry="3.5" class="fill"/></svg>',
    '<svg viewBox="0 0 64 64"><path d="M8 52h48M32 52V38"/><path d="M32 42c-6 0-9-4-9-8 5 0 9 3 9 8Zm0-2c5 0 8-3 8-7-5 0-8 3-8 7Z" class="fill"/></svg>',
    '<svg viewBox="0 0 64 64"><path d="M8 52h48M32 52V24"/><path d="M32 44c-7 0-11-4-11-9 6 0 11 4 11 9Zm0-8c7 0 10-4 10-9-6 0-10 4-10 9Zm0-6c-5 0-8-3-8-7 5 0 8 3 8 7Z" class="fill"/></svg>',
    '<svg viewBox="0 0 64 64"><path d="M8 52h48M32 52V34"/><circle cx="32" cy="26" r="13" class="fill"/></svg>',
    '<svg viewBox="0 0 64 64"><path d="M8 52h48M32 52V36"/><circle cx="32" cy="24" r="17" class="fill"/><circle cx="25" cy="20" r="2.2" class="fruit"/><circle cx="38" cy="27" r="2.2" class="fruit"/><circle cx="35" cy="15" r="2.2" class="fruit"/></svg>',
  ];
  const STAGE_NAMES = ["Seed", "Sprout", "Sapling", "Young tree", "Grove keeper"];

  function renderGame(total, catH, heads, opted, own) {
    const P = window.Progress, lv = P.level(total);
    const st = P.streak(heads.filter((h) => h.hours > 0).map((h) => h.serviceDay), Math.floor(Date.now() / 86400000));
    const pm = P.polymath(catH), stage = P.companion(lv.level), value = P.twin(total, C.impactRate);
    $("ppCompanion").innerHTML = COMPANION[stage] + `<span>${STAGE_NAMES[stage]}</span>`;
    $("ppCompanion").setAttribute("aria-label", `Impact Companion: ${STAGE_NAMES[stage]}, grows with verified hours`);
    const pct = Math.round((lv.into / (lv.next - lv.floor)) * 100);
    $("ppStats").innerHTML = `
      <div class="gs"><span>Civic level</span><strong>${lv.level}</strong>
        <div class="ms-bar" role="progressbar" aria-label="Progress to level ${lv.level + 1}" aria-valuemin="0" aria-valuemax="${lv.next - lv.floor}" aria-valuenow="${lv.into}"><span style="--p:${pct}%"></span></div>
        <small>${lv.need}h to level ${lv.level + 1}</small></div>
      <div class="gs"><span>Weekly streak</span><strong>${st.weeks} wk</strong><small>${st.shields} freeze shield${st.shields === 1 ? "" : "s"} · best ${st.best} wk${st.weeks && !st.activeThisWeek ? " · serve this week to extend it" : ""}</small></div>
      <div class="gs"><span>Polymath</span><strong>${["—", "Polymath", "Polymath II"][pm.tier]}</strong><small>${pm.areas} of 5 areas at 10h+ · title at 3, II at 5</small></div>
      ${!value ? "" : `<div class="gs twin"><span>Impact Twin <em class="badge neutral">estimate</em></span><strong>≈ ${value.toLocaleString("en-US", { style: "currency", currency: C.impactRate.currency, maximumFractionDigits: 0 })}</strong>
        <small>${total}h × ${C.impactRate.perHour} ${esc(C.impactRate.currency)}/h, the ${esc(C.impactRate.label)}. Context only: not money earned, paid or owed. <a href="${C.impactRate.source}" target="_blank" rel="noopener">Source</a></small></div>`}`;
    const spark = P.firstSpark({ opted, total });
    $("ppSpark").hidden = !own || spark.every((x) => x.done);
    $("ppSpark").innerHTML = `<div class="panel-head"><h3>First Spark</h3><span class="hint">${spark.filter((x) => x.done).length} of 3 done</span></div>
      <ol class="quest">${spark.map((x) => `<li class="${x.done ? "done" : ""}">${x.done ? ICON.check : '<span class="q-dot" aria-hidden="true"></span>'}<span>${x.label}</span>${x.done ? '<span class="badge ok">done</span>' : ""}</li>`).join("")}</ol>`;
    $("ppTrees").innerHTML = P.trees(catH).map((a, i) => `<div class="tree c${i}"><span class="tree-name">${CATS[i]}</span>
      <ol class="tree-nodes" aria-label="${CATS[i]}: ${a.tiers.filter((x) => x.reached).length} of 5 tiers">${a.tiers.map((x) => `<li class="${x.reached ? "on" : ""}" title="${x.threshold}h ${x.reached ? "reached" : "not reached"}">${x.threshold}</li>`).join("")}</ol>
      <span class="tree-h mono">${a.hours}h</span></div>`).join("");
    gameReady = true;
    applyMode();
  }

  async function renderLeague(own, opted) {
    const f = $("leagueForm");
    f.hidden = !(own && opted && API);
    if (f.hidden) return;
    f.querySelector(".msg").className = "msg";
    f.querySelector(".msg").textContent = "";
    showLeague((await signedIn()) ? await api("/league/me").catch(() => null) : null);
  }
  function showLeague(L) {
    $("lgBtn").textContent = L?.joined ? "Leave the league" : "Join or view my league";
    $("lgBtn").dataset.action = L?.joined ? "leave" : "join";
    $("lgBody").innerHTML = !L?.joined
      ? "Leagues are optional. Join to be ranked by a generated alias against up to 30 volunteers with similar experience, on verified hours served this month. You see only the 3 above and 3 below you, and you can leave at any time."
      : `<p>Season ${dateOf(L.season.start)} to ${dateOf(L.season.end)} · ${esc(L.band)} · you are <strong>${esc(L.alias)}</strong>, rank ${L.rank} of ${L.cohortSize}</p>
        <ol class="strip">${L.strip.map((x) => `<li class="${x.you ? "you" : ""}"><span class="mono">#${x.rank}</span><span>${esc(x.alias)}${x.you ? " (you)" : ""}</span><strong>${x.hours}h</strong></li>`).join("")}</ol>`;
  }
  $("leagueForm").onsubmit = (e) => {
    e.preventDefault();
    const leave = $("lgBtn").dataset.action === "leave";
    act(e.target, async () => { const L = await api(leave ? "/league/leave" : "/league/join", { method: "POST" }); showLeague(L); return L; },
      (L) => (L.joined ? `<strong>You're in this month's league.</strong> Rank ${L.rank} of ${L.cohortSize}.` : "<strong>You left the league.</strong> You are no longer ranked anywhere."));
  };

  let vaultOwner = null;
  async function renderVault(c, me, total, catH, own) {
    vaultOwner = me;
    const label = (k, th) => `${th}h ${k === 0 ? "total" : CATS[k - 1]}`;
    const slots = [...TOTAL_T.map((th) => [0, th]), ...CAT_T.flatMap((th) => [1, 2, 3, 4, 5].map((k) => [k, th]))];
    const ids = await Promise.all(slots.map(([k, th]) => c.badges.tokenOfKey(keyOf(me, k, th))));
    const earned = slots.map((s, i) => [...s, ids[i]]).filter(([, , id]) => id !== 0n);
    // milestones met but with no token: renounced by the holder (shown to the holder only)
    const met = slots.map((s, i) => [...s, ids[i]]).filter(([k, th, id]) => id === 0n && (k === 0 ? total : catH[k - 1]) >= th);
    const renounced = own ? (await Promise.all(met.map(async ([k, th]) => ((await c.badges.renounced(keyOf(me, k, th))) ? [k, th] : null)))).filter(Boolean) : [];
    // unlock animation for badges this browser hasn't shown before (per chain, contract and wallet)
    const seenKey = `proofhours-seen:${C.chainId}:${V2.badges}:${me}`;
    const seen = new Set(JSON.parse(localStorage.getItem(seenKey) || "[]"));
    const fresh = own ? earned.filter(([, , id]) => !seen.has(String(id))) : [];
    const art = await Promise.all(earned.map(async ([k, th, id]) => {
      const json = JSON.parse(atob((await c.badges.tokenURI(id)).split(",")[1]));
      const isNew = fresh.some(([, , f]) => f === id);
      return `<figure class="trophy${isNew ? " unlocked" : ""}"><img src="${json.image}" alt="${esc(json.name)}" width="120" height="120"><figcaption><strong>${label(k, th)}</strong><span>Token #${id} · soulbound${isNew ? ' · <em class="new-tag">new</em>' : ""}</span>
        ${own ? `<span class="trophy-btns">${API ? `<button type="button" class="btn btn-ghost sm" data-cred="${id}">Credential</button>` : ""}<button type="button" class="btn btn-ghost sm" data-renounce="${id}" data-label="${label(k, th)}">Renounce</button></span>` : ""}</figcaption></figure>`;
    }));
    const ren = renounced.map(([k, th]) => `<figure class="trophy renounced"><div class="goal-ring" aria-hidden="true"></div><figcaption><strong>${label(k, th)}</strong><span>Earned · renounced by you</span>
      <button type="button" class="btn btn-ghost sm" data-reclaim="${k}:${th}">Reclaim</button></figcaption></figure>`);
    if (own) localStorage.setItem(seenKey, JSON.stringify(earned.map(([, , id]) => String(id))));
    fresh.forEach(([k, th]) => toast(`Badge unlocked: ${label(k, th)}`, "ok"));
    // next goals: the next total milestone and the next one in every area already started (outlines, not art)
    const goals = [];
    const nt = nextOf(total, TOTAL_T);
    if (nt) goals.push([`${nt}h total`, nt - total]);
    catH.forEach((h, i) => { const n = nextOf(h, CAT_T); if (h > 0 && n) goals.push([`${n}h ${CATS[i]}`, n - h]); });
    $("ppVault").innerHTML = (art.length || ren.length ? art.join("") + ren.join("") : `<p class="muted small vault-empty">No badges yet. The first one is minted on-chain at 10 verified hours.</p>`) +
      goals.map(([label, left]) => `<figure class="trophy goal" aria-label="Not earned yet"><div class="goal-ring" aria-hidden="true"></div><figcaption><strong>${label}</strong><span>Not earned yet · ${left}h to go</span></figcaption></figure>`).join("");
    $("vaultForm").querySelector(".msg").className = "msg";
    $("vaultForm").querySelector(".msg").textContent = "";
    return earned.map(([k, th, id]) => `${label(k, th)} (token #${id})`);
  }

  $("ppVault").onclick = (e) => {
    const r = e.target.closest("[data-renounce]"), rc = e.target.closest("[data-reclaim]"), cr = e.target.closest("[data-cred]"), form = $("vaultForm");
    if (cr) getCredential(cr.dataset.cred);
    if (r) confirmCard(form, `<p><strong>Renounce "${esc(r.dataset.label)}"?</strong> The badge is burned now and won't be minted to this wallet again unless you reclaim it. Your verified hours don't change.</p>`,
      "Renounce badge", () => send(form, "renounce", () => [r.dataset.renounce], badgesTarget).then(after(loadPassport)));
    if (rc) {
      const [k, th] = rc.dataset.reclaim.split(":").map(Number);
      // two transactions: clear the renounced flag, then ask the ledger to re-mint (anyone may call resyncBadges)
      send(form, "reclaim", () => [k, th], badgesTarget).then((ok) => ok && send(form, "resyncBadges", () => [vaultOwner], ledgerTarget)).then(after(loadPassport));
    }
  };
  $("ppShare").onclick = async () => {
    if (!vaultOwner) return toast("Connect a wallet first.", "err");
    const withKey = profile.linkKey && Object.values(profile.visibility ?? {}).includes("link");
    const link = `${location.origin}${location.pathname}${location.search}#passport=${vaultOwner}${withKey ? `&k=${profile.linkKey}` : ""}`;
    try { await navigator.clipboard.writeText(link); toast(withKey ? "Share link copied. It includes your Link-visibility profile fields." : "Public passport link copied. It shows only public on-chain data.", "ok"); }
    catch { toast(link, "info"); }
  };

  async function renderRecords(c, me) {
    const [ids] = await c.ledger.originalsOf(me, 0, 100);
    if (!ids.length) { $("ppRecords").innerHTML = `<li class="muted small">No records yet. Hours appear here once an NGO issues them to this wallet.</li>`; return []; }
    const heads = [];
    const rows = await Promise.all(ids.map(async (id) => {
      const h = await c.ledger.headOf(id);
      const [ev, org] = await Promise.all([h.eventId ? c.ledger.getFunction("getEvent")(h.eventId) : null, c.ledger.getOrg(h.orgId)]);
      const t = Number(h.entryType);
      const status = t === 2 ? ["bad", "Revoked"] : t === 1 ? ["warn", "Corrected"] : t === 3 ? ["neutral", "From V1"] : ["ok", "Valid"];
      const what = ev ? esc(ev.code) : `V1 record #${h.v1RecordId}`;
      heads.push({ id: Number(id), hours: t === 2 ? 0 : Number(h.hoursLogged), serviceDay: Number(h.serviceDay), what: ev ? ev.code : `V1 record #${h.v1RecordId}`, org: org.name, area: CATS[Number(h.category)], status: status[1] });
      return `<li class="ir"><span class="vd ${status[0] === "ok" ? "valid" : status[0] === "warn" ? "corrected" : status[0] === "bad" ? "revoked" : "notfound"}" aria-hidden="true"></span>
        <div class="ir-main"><strong>${what}</strong><span>${esc(org.name)} · ${CATS[Number(h.category)]} · record #${id}${h.id !== id ? ` → #${h.id}` : ""}</span></div>
        <span class="badge ${status[0]}">${status[1]}</span><strong class="ir-h">${t === 2 ? 0 : h.hoursLogged}h</strong>
        <span class="ir-proof">${ENTRY2[t]}${h.reason !== ethers.ZeroHash ? " · " + esc(ethers.decodeBytes32String(h.reason)) : ""}</span></li>`;
    }));
    $("ppRecords").innerHTML = rows.join("");
    return heads.sort((a, b) => a.id - b.id);
  }

  // ---------- Issuance ----------
  let myOrg = 0n;
  async function orgEvents(c, org) {
    if (!org) return [];
    const n = Number(await c.ledger.eventCount());
    // shortcut: reads every event; Stage 3's indexer replaces this with a per-NGO query
    return (await Promise.all(Array.from({ length: n }, (_, i) => c.ledger.getFunction("getEvent")(i + 1)))).map((e, i) => [i + 1, e]).filter(([, e]) => e.orgId === org);
  }
  async function loadIssuance() {
    const c = await available("isNotice", "isBody");
    if (!c) return;
    if (!$("v2Day").value) $("v2Day").value = new Date().toISOString().slice(0, 10);
    const me = await currentAccount();
    const ctx = $("isContext");
    myOrg = me ? await c.ledger.coordinatorOrg(me) : 0n;
    if (!me) ctx.innerHTML = `${ICON.alert}<div><strong>No wallet connected.</strong> Connect the coordinator wallet your NGO admin registered for V2.</div>`;
    else if (myOrg === 0n) ctx.innerHTML = `${ICON.alert}<div><strong>${short(me)} is not a V2 coordinator.</strong> The contract will refuse writes from it. Your NGO admin assigns coordinator wallets.</div>`;
    else {
      const org = await c.ledger.getOrg(myOrg);
      ctx.innerHTML = `${org.suspended ? ICON.alert : ICON.shield}<div>Coordinator for <strong>${esc(org.name)}</strong>${org.suspended ? ' <span class="badge bad">suspended</span>' : ""} · daily issuance cap ${org.dailyIssueCap}h · writes are signed by ${short(me)}.</div>`;
    }
    ctx.className = "banner " + (me && myOrg !== 0n ? "ok" : "warn");
    const evs = await orgEvents(c, myOrg);
    $("v2Events").innerHTML = evs.length ? evs.map(([id, e]) => `<tr><td>#${id}</td><td>${esc(e.code)}</td><td>${CATS[Number(e.category)]}</td><td class="mono">${dateOf(e.serviceDay)}</td><td>${e.maxHours}h</td></tr>`).join("")
      : `<tr><td colspan="5" class="muted">${myOrg ? "No events yet. Create the first one." : "Connect a V2 coordinator wallet to see its events."}</td></tr>`;
    const sel = $("v2IssueEvent"), keep = sel.value;
    sel.innerHTML = evs.length ? evs.map(([id, e]) => `<option value="${id}">#${id} ${esc(e.code)} · ${CATS[Number(e.category)]} · max ${e.maxHours}h</option>`).join("") : `<option value="">Create an event first</option>`;
    if (keep && evs.some(([id]) => String(id) === keep)) sel.value = keep;
  }

  function parseRoster(text) {
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Add at least one line: wallet address, hours.");
    return lines.map((line, i) => {
      const [addr, h] = line.split(/[\s,;]+/);
      if (!ethers.isAddress(addr)) throw new Error(`Line ${i + 1}: "${addr}" is not a wallet address.`);
      const hours = Number(h);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw new Error(`Line ${i + 1}: hours must be a whole number from 1 to 24.`);
      // manual roster: evidence is a hash of the line; the Attendance page issues with real attendance evidence hashes
      return { addr: ethers.getAddress(addr), hours, evidence: ethers.id(`roster:${$("v2IssueEvent").value}:${addr.toLowerCase()}:${hours}`) };
    });
  }

  const after = (loader) => (r) => { if (r) loader(); };
  $("ppOptForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "optIn", () => [], ledgerTarget).then(after(loadPassport)); };
  $("v1LinkForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "requestV1Link", () => [$("v1LinkId").value], ledgerTarget).then(after(loadPassport)); };
  $("v2EventForm").onsubmit = (e) => {
    e.preventDefault();
    send(e.target, "createEvent", () => [$("v2Code").value.trim(), Number($("v2Cat").value), $("v2Max").value, dayOf($("v2Day").value)], ledgerTarget).then(after(loadIssuance));
  };
  $("v2IssueForm").onsubmit = (e) => {
    e.preventDefault();
    const batch = $("v2Roster").value.split("\n").filter((l) => l.trim()).length > 1;
    send(e.target, batch ? "issueBatch" : "issueHours", () => {
      const r = parseRoster($("v2Roster").value), ev = $("v2IssueEvent").value;
      if (!ev) throw new Error("Choose an event first.");
      return r.length === 1 ? [ev, r[0].addr, r[0].hours, r[0].evidence] : [ev, r.map((x) => x.addr), r.map((x) => x.hours), r.map((x) => x.evidence)];
    }, ledgerTarget).then(after(loadIssuance));
  };
  $("v2CorrectForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "correct", () => [$("v2FixId").value, $("v2FixHours").value, bytes32($("v2FixReason").value.trim())], ledgerTarget).then(after(loadIssuance)); };
  $("v2RevokeForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "revoke", () => [$("v2RevId").value, bytes32($("v2RevReason").value.trim())], ledgerTarget).then(after(loadIssuance)); };
  $("v1ApproveForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "approveV1Link", () => [$("v1ApproveId").value, Number($("v1ApproveCat").value)], ledgerTarget).then(after(loadIssuance)); };
  $("v1SyncForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "syncV1", () => [$("v1SyncId").value], ledgerTarget).then(after(loadIssuance)); };

  // ---------- Attendance (off-chain service: shifts, rotating QR, approvals) ----------
  // The service only records attendance. Hours reach the ledger when the coordinator's own wallet sends issueBatch.
  const API = (params.get("api") || C.attendance || "").replace(/\/$/, "");
  let session = null;
  const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");
  const fmtT = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");
  const fmtS = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const siteText = (v) => (v === true ? "yes" : v === false ? "no" : "not shared");
  const STATUS = { checked_in: ["neutral", "Checked in"], checked_out: ["warn", "Awaiting approval"], approved: ["ok", "Approved, not issued"], rejected: ["bad", "Rejected"], issued: ["ok", "Issued on-chain"] };

  async function api(path, { method = "GET", body, auth = true, retried = false } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) headers.authorization = "Bearer " + (await ensureSession()).token;
    let r;
    try { r = await fetch(API + path, { method, headers, body: body && JSON.stringify(body) }); }
    catch { throw new Error(`The attendance service at ${API} is not reachable. Start it with "node server/attendance.js", then try again.`); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && auth) {
      session = null;
      if (!retried) return api(path, { method, body, auth, retried: true }); // expired sign-in: sign in again once
    }
    if (!r.ok) throw new Error(j.error || `The attendance service answered with an error (${r.status}).`);
    return j;
  }
  // One free signature (no transaction) per wallet per 2 hours.
  async function ensureSession() {
    const me = await currentAccount();
    if (!me) throw new Error("Connect your wallet first.");
    if (session && session.address.toLowerCase() === me.toLowerCase() && session.expiresAt > Date.now() / 1000 + 60) return session;
    const { nonce, message } = await api("/auth/nonce", { method: "POST", auth: false, body: { address: me } });
    const signature = await (await new ethers.BrowserProvider(window.ethereum).getSigner(me)).signMessage(message);
    session = await api("/auth", { method: "POST", auth: false, body: { address: me, nonce, signature } });
    return session;
  }
  const signedIn = async () => !!session && session.address.toLowerCase() === (await currentAccount())?.toLowerCase();
  const declined = (e) => (e?.code === "ACTION_REJECTED" ? "You declined the signature in your wallet. Nothing was recorded." : e.message);

  // Runs a service call from a form and shows the outcome in its status line.
  async function act(form, fn, okHtml) {
    const btn = form.querySelector("button[type=submit]"), msg = form.querySelector(".msg");
    btn.disabled = true;
    msg.className = "msg";
    msg.textContent = (await signedIn()) ? "Working…" : "Sign the sign-in message in your wallet (free, no transaction)…";
    try {
      const out = await fn();
      msg.className = "msg ok";
      msg.innerHTML = `${ICON.check}<span>${okHtml(out)}</span>`;
      return out;
    } catch (e) {
      logError("attendance", e);
      msg.className = "msg err";
      msg.textContent = declined(e);
    } finally { btn.disabled = false; }
  }

  async function attendanceAvailable(noticeId, bodyId) {
    const c = await available(noticeId, bodyId);
    if (!c) return null;
    if (!API) {
      $(noticeId).innerHTML = `${ICON.info}<div><strong>The attendance service is not running for ${esc(C.netName)} yet.</strong> It runs locally for now: start it with <code>node server/attendance.js</code> and open this page with <code>?local</code>.</div>`;
      $(noticeId).hidden = false;
      $(bodyId).hidden = true;
      return null;
    }
    return c;
  }

  // ----- Coordinator: shifts, QR, review, issuance -----
  let shifts = [], current = null, qrTimer = null, atEvents = new Map();
  async function loadAttendance() {
    const c = await attendanceAvailable("atNotice", "atBody");
    if (!c) return;
    const me = await currentAccount(), org = me ? await c.ledger.coordinatorOrg(me) : 0n;
    const ctx = $("atContext");
    ctx.className = "banner " + (org ? "ok" : "warn");
    ctx.innerHTML = !me ? `${ICON.alert}<div><strong>No wallet connected.</strong> Connect your NGO's V2 coordinator wallet.</div>`
      : !org ? `${ICON.alert}<div><strong>${short(me)} is not a V2 coordinator.</strong> The attendance service refuses shift and approval actions from it.</div>`
      : `${ICON.shield}<div>Coordinator for <strong>${esc((await c.ledger.getOrg(org)).name)}</strong>. Attendance service: <code>${esc(API)}</code>.</div>`;
    const evs = await orgEvents(c, org);
    atEvents = new Map(evs.map(([id, e]) => [id, e]));
    const sel = $("shEvent"), keep = sel.value;
    sel.innerHTML = evs.length ? evs.map(([id, e]) => `<option value="${id}">#${id} ${esc(e.code)} · ${dateOf(e.serviceDay)} · max ${e.maxHours}h</option>`).join("") : `<option value="">Create a V2 event first (V2 issuance page)</option>`;
    if (keep && atEvents.has(Number(keep))) sel.value = keep;
    if (await signedIn()) await loadShifts();
  }

  async function loadShifts() {
    shifts = await api("/shifts");
    $("atSignIn").textContent = "Refresh";
    $("shiftList").innerHTML = shifts.length ? shifts.map((s) => {
      const e = atEvents.get(s.eventId);
      return `<li class="shift" data-shift="${s.id}" aria-current="${current?.id === s.id}"><div><strong>Shift #${s.id} · ${e ? esc(e.code) : "event #" + s.eventId}</strong><br>
        <span>${fmt(s.start)} – ${fmtT(s.end)} · ${s.attending}/${s.capacity} attending${s.site ? " · site area set" : ""}</span></div>
        <div class="shift-actions"><button type="button" class="btn btn-ghost sm" data-qr="in">Check-in QR</button><button type="button" class="btn btn-ghost sm" data-qr="out">Check-out QR</button><button type="button" class="btn btn-ghost sm" data-review>Review</button><button type="button" class="btn btn-ghost sm" data-vouchers>Offline vouchers</button></div></li>`;
    }).join("") : `<li class="muted small">No shifts yet. Create the first one.</li>`;
  }

  async function showQr(shift, kind) {
    clearTimeout(qrTimer);
    if ($("attend").hidden || $("qrPanel").hidden) return;
    try {
      const { token, rotatesAt, expiresAt, now } = await api(`/shifts/${shift.id}/qr?kind=${kind}`);
      const link = `${location.origin}${location.pathname}${location.search}#checkin=${token}`;
      const qr = qrcode(0, "M");
      qr.addData(link);
      qr.make();
      $("qrBox").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
      $("qrTitle").textContent = `${kind === "in" ? "Check-in" : "Check-out"} code · shift #${shift.id}`;
      $("qrLink").textContent = link;
      $("qrLink").href = link;
      $("qrLink").dataset.link = link;
      $("qrTimer").textContent = `Next code at ${fmtS(rotatesAt)} · this one stops working at ${fmtS(expiresAt)}`;
      // refresh 2 s before the service rotates the code, so the screen always shows a working one
      qrTimer = setTimeout(() => showQr(shift, kind), Math.max(3000, (rotatesAt - 2 - now) * 1000)); // service clock, not this device's
    } catch (e) {
      $("qrTimer").textContent = declined(e);
      qrTimer = setTimeout(() => showQr(shift, kind), 10000);
    }
  }

  async function loadReview(shift) {
    current = shift;
    document.querySelectorAll("#shiftList .shift").forEach((li) => li.setAttribute("aria-current", String(Number(li.dataset.shift) === shift.id)));
    const e = atEvents.get(shift.eventId);
    $("atShiftName").textContent = `shift #${shift.id}${e ? " · " + e.code : ""}`;
    const rows = await api(`/shifts/${shift.id}/attendance`);
    $("attList").innerHTML = rows.length ? rows.map((a) => {
      const [cls, label] = STATUS[a.status];
      const approve = a.status === "checked_out" ? `<button type="button" class="btn btn-primary sm" data-approve="${a.id}">Approve</button>` : "";
      const reject = ["checked_in", "checked_out"].includes(a.status) ? `<button type="button" class="btn btn-ghost sm" data-reject="${a.id}">Reject</button>` : "";
      return `<tr data-att="${a.id}"><td>${addrHtml(a.volunteer)}</td><td class="mono">${fmtT(a.checkIn)}</td><td class="mono">${fmtT(a.checkOut)}</td>
        <td>${siteText(a.atSiteIn)} / ${siteText(a.atSiteOut)}</td><td>${a.hours == null ? "—" : a.hours + "h"}</td>
        <td><span class="badge ${cls}">${label}</span>${a.source === "voucher" ? ' <span class="badge neutral">offline voucher</span>' : ""}${a.recordId ? ` <span class="small">record #${a.recordId}</span>` : ""}${a.reason ? ` <span class="small">${esc(a.reason)}</span>` : ""}</td>
        <td><div class="row-actions">${approve}${reject}</div></td></tr>`;
    }).join("") : `<tr><td colspan="7" class="muted">Nobody has checked in to this shift yet.</td></tr>`;
  }

  const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  $("shiftForm").onsubmit = (e) => {
    e.preventDefault();
    act(e.target, async () => {
      const start = Math.floor(new Date($("shStart").value).getTime() / 1000), end = Math.floor(new Date($("shEnd").value).getTime() / 1000);
      const lat = $("shLat").value, lng = $("shLng").value, radius = $("shRadius").value;
      if ([lat, lng, radius].some(Boolean) && ![lat, lng, radius].every(Boolean)) throw new Error("For a site area, fill in latitude, longitude and radius, or leave all three empty.");
      const s = await api("/shifts", { method: "POST", body: { eventId: Number($("shEvent").value), start, end, capacity: Number($("shCap").value), site: lat ? { lat: Number(lat), lng: Number(lng), radius: Number(radius) } : null } });
      await loadShifts();
      return s;
    }, (s) => `<strong>Shift #${s.id} created.</strong> Show its check-in QR when volunteers arrive.`);
  };
  $("atSignIn").onclick = async () => {
    const b = $("atSignIn");
    b.disabled = true;
    try { await ensureSession(); await loadShifts(); } catch (e) { toast(declined(e), "err"); } finally { b.disabled = false; }
  };
  $("shiftList").onclick = (e) => {
    const b = e.target.closest("button"), li = e.target.closest("[data-shift]");
    if (!b || !li) return;
    const shift = shifts.find((s) => s.id === Number(li.dataset.shift));
    if (b.dataset.qr) { $("qrPanel").hidden = false; showQr(shift, b.dataset.qr); $("qrPanel").scrollIntoView({ block: "nearest" }); }
    else if ("vouchers" in b.dataset) printVouchers(shift).catch((err) => toast(declined(err), "err"));
    else loadReview(shift).catch((err) => toast(declined(err), "err"));
  };
  $("qrClose").onclick = () => { clearTimeout(qrTimer); $("qrPanel").hidden = true; };
  $("attList").onclick = async (e) => {
    const b = e.target.closest("button[data-approve], button[data-reject]");
    if (!b) return;
    const msg = $("issueAttForm").querySelector(".msg");
    b.disabled = true;
    try {
      const a = b.dataset.approve
        ? await api(`/attendance/${b.dataset.approve}/approve`, { method: "POST" })
        : await api(`/attendance/${b.dataset.reject}/reject`, { method: "POST", body: { reason: $("atReason").value } });
      msg.className = "msg ok";
      msg.innerHTML = `${ICON.check}<span>${a.status === "approved" ? `<strong>Approved ${a.hours}h for ${short(a.volunteer)}.</strong> Not on-chain yet: issue the approved hours below.` : `<strong>Rejected ${short(a.volunteer)}.</strong> No hours will be issued for it.`}</span>`;
      await loadReview(current);
    } catch (err) { msg.className = "msg err"; msg.textContent = declined(err); b.disabled = false; }
  };
  $("issueAttForm").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target, msg = form.querySelector(".msg");
    const stop = (t) => { msg.className = "msg err"; msg.textContent = t; };
    if (!current) return stop("Choose a shift and review its attendance first.");
    msg.className = "msg";
    msg.textContent = "Checking what's approved…";
    let iss;
    try { iss = await api(`/shifts/${current.id}/issuable`); } catch (err) { return stop(declined(err)); }
    if (!iss.volunteers.length) return stop("Nothing approved to issue for this shift. Approve attendance first.");
    const receipt = await send(form, "issueBatch", () => [iss.eventId, iss.volunteers, iss.hours, iss.evidence], ledgerTarget);
    if (!receipt) return;
    try {
      const { marked } = await api(`/shifts/${current.id}/issued`, { method: "POST", body: { txHash: receipt.hash } });
      msg.insertAdjacentHTML("beforeend", `<br>The attendance service checked the receipt and marked ${marked} attendance record${marked === 1 ? "" : "s"} as issued.`);
    } catch (err) { msg.insertAdjacentHTML("beforeend", `<br>${esc("Issued on-chain, but the attendance service could not be updated: " + err.message)}`); }
    loadReview(current).catch(() => {});
    loadShifts().catch(() => {});
  };

  // Offline vouchers: a printable sheet of single-use codes for a shift at a site without a signal.
  async function printVouchers(shift) {
    const v = await api(`/shifts/${shift.id}/vouchers`, { method: "POST", body: { count: 20 } }), e = atEvents.get(shift.eventId);
    $("transcriptView").innerHTML = `<header class="tr-head"><div><h1>Offline vouchers · shift #${shift.id}</h1><p>${e ? esc(e.code) : "event #" + shift.eventId} · ${fmt(shift.start)} – ${fmtT(shift.end)}</p>
        <p>Hand one slip to each volunteer at the end of the shift. Each code works once, until ${fmt(v.redeemUntil)}. Redeeming it records attendance for the whole shift, which you still approve before any hours are issued.</p></div></header>
      <ol class="voucher-sheet">${v.codes.map((c) => `<li><span>Redeem on the Shift check-in page</span><code>${c}</code></li>`).join("")}</ol>`;
    document.body.classList.add("print-transcript");
    $("transcriptView").hidden = false;
    toast(`${v.codes.length} single-use vouchers created for shift #${shift.id}.`, "ok");
    window.print();
  }

  // ----- Volunteer: check in / out from a scanned code -----
  let ciToken = null, ciShift = null;
  function v2FromHash() {
    const m = /^#checkin=([\w-]+\.(?:in|out)\.\d+\.[\w-]+)$/.exec(location.hash);
    const pp = /^#passport=(0x[0-9a-fA-F]{40})(?:&k=([\w-]{8,64}))?$/.exec(location.hash);
    if (m) { ciToken = m[1]; showPage("checkin"); }
    else if (pp) { viewAddr = ethers.getAddress(pp[1]); viewKey = pp[2] ?? null; $("passport").hidden ? showPage("passport") : loadPassport(); }
    return !!(m || pp);
  }
  async function loadCheckin() {
    const c = await attendanceAvailable("ciNotice", "ciBody");
    if (!c) return;
    const btn = $("ciBtn"), kind = ciToken?.split(".")[1], msg = $("ciForm").querySelector(".msg");
    msg.className = "msg";
    msg.textContent = "";
    btn.hidden = true;
    $("ciGeoRow").hidden = true;
    if (!ciToken) {
      $("ciTitle").textContent = "Scan a code";
      $("ciShift").textContent = "Open this page by scanning the QR code shown at your shift.";
    } else {
      try {
        ciShift = await api(`/shifts/${ciToken.split(".")[0]}`, { auth: false });
        const e = await c.ledger.getFunction("getEvent")(ciShift.eventId);
        $("ciTitle").textContent = kind === "in" ? "Check in" : "Check out";
        $("ciShift").innerHTML = `<strong>${esc(e.code)}</strong><br>Shift #${ciShift.id} · ${fmt(ciShift.start)} – ${fmtT(ciShift.end)} · ${CATS[Number(e.category)]}`;
        btn.textContent = kind === "in" ? "Check in" : "Check out";
        btn.hidden = false;
        $("ciGeoRow").hidden = !ciShift.site;
      } catch (err) { $("ciShift").textContent = friendly(err); }
    }
    if (await signedIn()) await loadMine();
  }
  const metres = (a, b) => {
    const r = Math.PI / 180, h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  // The position is compared on this device and discarded; only the yes/no answer leaves it.
  const atSite = () => new Promise((resolve, reject) => navigator.geolocation
    ? navigator.geolocation.getCurrentPosition((p) => resolve(metres({ lat: p.coords.latitude, lng: p.coords.longitude }, ciShift.site) <= ciShift.site.radius),
      () => reject(new Error("Location was not available or not allowed. Untick the location box to continue without it.")), { timeout: 15000, maximumAge: 60000 })
    : reject(new Error("This browser has no location support. Untick the location box to continue without it.")));
  async function loadMine() {
    const rows = await api("/me/attendance");
    $("ciMineBtn").textContent = "Refresh";
    $("ciMine").innerHTML = rows.length ? rows.map((a) => {
      const [cls, label] = STATUS[a.status];
      return `<li class="shift"><div><strong>Shift #${a.shiftId} · event #${a.eventId}</strong><br><span>In ${fmt(a.checkIn)} · out ${fmtT(a.checkOut)}${a.hours != null ? ` · ${a.hours}h` : ""}</span></div>
        <span class="badge ${cls}">${label}${a.recordId ? ` · record #${a.recordId}` : ""}</span></li>`;
    }).join("") : `<li class="muted small">No attendance yet.</li>`;
  }
  $("ciForm").onsubmit = (e) => {
    e.preventDefault();
    const kind = ciToken?.split(".")[1];
    act(e.target, async () => {
      const site = ciShift?.site && $("ciGeo").checked ? await atSite() : null;
      const a = await api(kind === "in" ? "/checkin" : "/checkout", { method: "POST", body: { token: ciToken, atSite: site } });
      ciToken = null; // the next step needs the next code
      history.replaceState(null, "", location.pathname + location.search);
      $("ciBtn").hidden = true;
      $("ciGeoRow").hidden = true;
      await loadMine();
      return a;
    }, (a) => kind === "in"
      ? `<strong>Checked in at ${fmtT(a.checkIn)}.</strong> Scan the check-out code when you leave. Nothing is issued until the coordinator approves your attendance.`
      : `<strong>Checked out at ${fmtT(a.checkOut)}.</strong> About ${a.hours}h inside the shift. Waiting for the coordinator's approval; no hours are issued yet.`);
  };
  $("voucherForm").onsubmit = (e) => {
    e.preventDefault();
    act(e.target, async () => { const a = await api("/vouchers/redeem", { method: "POST", body: { code: $("vcCode").value } }); $("vcCode").value = ""; await loadMine(); return a; },
      (a) => `<strong>Voucher accepted for shift #${a.shiftId}</strong> (about ${a.hours}h). Waiting for the coordinator's approval; no hours are issued yet.`);
  };
  $("ciMineBtn").onclick = () => loadMine().catch((e) => toast(declined(e), "err"));

  // ---------- Discovery: Cmd/Ctrl+K search, paste-to-verify resolver, opportunities directory ----------
  // Text search goes to the indexer (public NGO and event data only). Pasted wallets, transactions, record and badge
  // numbers and verification links are resolved straight from the chain, so they work without any service.
  const IDX = (params.get("search") || C.indexer || "").replace(/\/$/, "");
  const omni = $("omni"), omniQ = $("omniQ");
  let omniSeq = 0, omniCat = "", omniTimer = null;

  const openPassport = (addr) => { location.hash = "passport=" + ethers.getAddress(addr); };
  const goOpps = (filter) => { opFilter = { ...opFilter, ...filter }; showPage("opps"); };

  // Pasted things → what they are, read from the chain. Each item: { title, detail (html), go? }
  async function resolvePaste(raw) {
    const s = raw.trim();
    try {
      const u = new URL(s);
      const h = new URLSearchParams(u.hash.slice(1));
      if (h.get("checkin")) return [{ title: "Shift check-in code", detail: "Opens the check-in page for that shift.", go: () => { location.hash = u.hash; } }];
      if (h.get("passport")) return resolvePaste(h.get("passport"));
      if (h.get("id") && h.get("salt")) return [{ title: `V1 verification link · student ${esc(h.get("id"))}`, detail: "Checks the record and its full history on the ledger.", go: () => { location.hash = u.hash; } }];
      return [];
    } catch { /* not a URL */ }
    if (ethers.isAddress(s)) {
      const parts = [], a = ethers.getAddress(s);
      const [active, label] = await (await reader()).coordinators(a).catch(() => [false, ""]);
      if (label) parts.push(`V1 coordinator "${esc(label)}"${active ? "" : " (revoked)"}`);
      const c = V2 && (await contracts().catch(() => null));
      if (c && (await c.ledger.runner.getCode(V2.ledger)) !== "0x") {
        const [org, opted, total, badgeCount] = await Promise.all([c.ledger.coordinatorOrg(a), c.ledger.optedIn(a), c.ledger.totalHours(a), c.badges.balanceOf(a)]);
        if (org) parts.push(`V2 coordinator for ${esc((await c.ledger.getOrg(org)).name)}`);
        parts.push(`${total}h verified in V2 · ${badgeCount} soulbound badge${badgeCount === 1n ? "" : "s"}${opted ? "" : " · not opted in"}`);
      }
      return [{ title: `Wallet ${short(a)}`, detail: parts.join(" · ") || "No ProofHours activity found.", go: V2 ? () => openPassport(a) : null, cta: "Open public passport" }];
    }
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
      const r = await (await reader()).runner.getTransactionReceipt(s);
      if (!r) return [{ title: "Transaction not found", detail: `No transaction with this hash on ${esc(C.netName)}.` }];
      return [{ title: `Transaction ${short(s)} · ${r.status === 1 ? "succeeded" : "failed"} in block ${r.blockNumber}`, detail: `${esc(summarize(r) || "No ProofHours events in this transaction.")}${C.explorers.length ? " · " + links("tx/" + s) : ""}` }];
    }
    const rec = /^(?:v2\s*)?record\s*#?\s*(\d+)$|^#(\d+)$/i.exec(s), badge = /^badge\s*#?\s*(\d+)$/i.exec(s);
    if ((rec || badge) && V2) {
      const c = await contracts();
      if (rec) {
        const id = BigInt(rec[1] ?? rec[2]);
        if (id < 1n || id > (await c.ledger.recordCount())) return [{ title: `V2 record #${id}`, detail: "No such record on this chain." }];
        const h = await c.ledger.headOf(id), t = Number(h.entryType);
        const status = t === 2 ? "Revoked" : t === 1 ? `Corrected (now #${h.id})` : t === 3 ? "Imported from V1" : "Valid";
        return [{ title: `V2 record #${id} · ${status}`, detail: `${t === 2 ? 0 : h.hoursLogged}h ${CATS[Number(h.category)]} for ${short(h.volunteer)} · ${esc((await c.ledger.getOrg(h.orgId)).name)}`, go: () => openPassport(h.volunteer), cta: "Open passport" }];
      }
      const id = BigInt(badge[1]);
      const owner = await c.badges.ownerOf(id).catch(() => null);
      if (!owner) return [{ title: `Badge #${id} · not held`, detail: "This badge was never minted or has been burned (its milestone no longer holds, or the holder renounced it)." }];
      const json = JSON.parse(atob((await c.badges.tokenURI(id)).split(",")[1]));
      return [{ title: `Badge #${id} · ${esc(json.name)}`, detail: `Held by ${short(owner)} · soulbound (locked: ${await c.badges.locked(id)})`, go: () => openPassport(owner), cta: "Open passport" }];
    }
    return null; // not a paste: run a text search
  }

  function renderOmni(items, foot) {
    $("omniResults").innerHTML = items.length ? items.map((it, i) => it.go
      ? `<button type="button" class="omni-item" data-i="${i}"><span class="omni-kind">${it.kind ?? "Result"}</span><strong>${it.title}</strong><span class="omni-detail">${it.detail}</span><span class="omni-cta">${it.cta ?? "Open"} →</span></button>`
      : `<div class="omni-item static"><span class="omni-kind">${it.kind ?? "Result"}</span><strong>${it.title}</strong><span class="omni-detail">${it.detail}</span></div>`).join("")
      : `<p class="omni-empty">${foot.empty ?? "No matches."}</p>`;
    $("omniResults").onclick = (e) => { const b = e.target.closest("button.omni-item"); if (b) { omni.close(); items[Number(b.dataset.i)].go(); } };
    $("omniFoot").innerHTML = foot.text ?? "";
  }

  async function runOmni() {
    const q = omniQ.value, seq = ++omniSeq;
    try {
      const pasted = q.trim() ? await resolvePaste(q) : null;
      if (seq !== omniSeq) return;
      if (pasted) { $("omniFacets").innerHTML = ""; return renderOmni(pasted.map((p) => ({ kind: "On-chain", ...p })), { text: "Read live from the chain, not from the search index." }); }
      if (!IDX) { $("omniFacets").innerHTML = ""; return renderOmni([], { empty: `Text search isn't running for ${esc(C.netName)} yet. You can still paste a wallet address, transaction hash, "record 12", "badge 3" or a verification link.` }); }
      const t0 = performance.now();
      const r = await fetch(`${IDX}/search?q=${encodeURIComponent(q)}&category=${omniCat}&limit=12`).then((x) => x.json());
      if (seq !== omniSeq) return;
      const total = Object.values(r.facets.category).reduce((a, b) => a + b, 0);
      $("omniFacets").innerHTML = [`<button type="button" class="facet${omniCat === "" ? " on" : ""}" data-cat="">All events <em>${total}</em></button>`,
        ...CATS.map((name, i) => r.facets.category[i] ? `<button type="button" class="facet c${i}${omniCat === String(i) ? " on" : ""}" data-cat="${i}">${name} <em>${r.facets.category[i]}</em></button>` : "")].join("");
      renderOmni(r.results.map((x) => x.kind === "org"
        ? { kind: "NGO", title: esc(x.title), detail: esc(x.detail), cta: "See its shifts", go: () => goOpps({ org: String(x.id), event: null }) }
        : { kind: CATS[x.category] ?? "Event", title: esc(x.title), detail: `Event #${x.id} · ${esc(x.detail)}`, cta: "See shifts", go: () => goOpps({ event: x.id, org: "" }) }),
        { text: `${r.results.length} result${r.results.length === 1 ? "" : "s"} · search ${r.tookMs} ms · round trip ${Math.round(performance.now() - t0)} ms · public NGO and event data only; volunteers are never searchable`, empty: q.trim() ? "No NGOs or events match." : "No NGOs or events indexed yet." });
    } catch (e) {
      if (seq !== omniSeq) return;
      logError("search", e);
      renderOmni([], { empty: e instanceof TypeError ? `The search service at ${esc(IDX)} is not reachable. Start it with <code>node server/indexer.js</code>.` : esc(friendly(e)) });
    }
  }
  const openOmni = () => { if (!omni.open) { omni.showModal(); omniQ.select(); runOmni(); } };
  omniQ.oninput = () => { clearTimeout(omniTimer); omniTimer = setTimeout(runOmni, 120); };
  $("omniFacets").onclick = (e) => { const b = e.target.closest("[data-cat]"); if (b) { omniCat = b.dataset.cat; runOmni(); omniQ.focus(); } };
  omni.addEventListener("keydown", (e) => {
    const items = [...omni.querySelectorAll("button.omni-item")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1 + (i < 0 ? 1 : 0))) % items.length]?.focus(); }
    else if (e.key === "Enter" && document.activeElement === omniQ) { e.preventDefault(); items[0]?.click(); }
  });
  omni.addEventListener("click", (e) => { if (e.target === omni) omni.close(); }); // backdrop click
  $("searchBtn").onclick = openOmni;
  document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); omni.open ? omni.close() : openOmni(); } });

  // ----- Opportunities directory -----
  let opFilter = { cat: "", org: "", open: false, event: null }, opCache = null;
  const evMeta = new Map(), orgMeta = new Map();
  async function loadOpps() {
    const c = await available("opNotice", "opBody");
    if (!c) return;
    if (!API) {
      $("opNotice").innerHTML = `${ICON.info}<div><strong>No shift directory for ${esc(C.netName)} yet.</strong> Shifts come from the attendance service, which runs locally for now (<code>node server/attendance.js</code>, then open this page with <code>?local</code>).</div>`;
      $("opNotice").hidden = false;
      $("opBody").hidden = true;
      return;
    }
    const shifts = await api("/opportunities", { auth: false });
    const ids = [...new Set(shifts.map((s) => s.eventId))].filter((id) => !evMeta.has(id));
    await Promise.all(ids.map(async (id) => evMeta.set(id, await c.ledger.getFunction("getEvent")(id))));
    // events never change, so they're cached; NGOs are re-read each time because they can be suspended
    const orgIds = [...new Set(shifts.map((s) => evMeta.get(s.eventId).orgId))];
    await Promise.all(orgIds.map(async (id) => orgMeta.set(id, await c.ledger.getOrg(id))));
    // shifts of suspended NGOs are left out: they can't issue hours
    opCache = shifts.map((s) => ({ ...s, ev: evMeta.get(s.eventId), org: orgMeta.get(evMeta.get(s.eventId).orgId) })).filter((s) => !s.org.suspended);
    const orgs = [...new Map(opCache.map((s) => [String(s.ev.orgId), s.org.name])).entries()];
    $("opOrg").innerHTML = `<option value="">All NGOs</option>` + orgs.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("");
    renderOpps();
  }
  function renderOpps() {
    if (!opCache) return;
    const f = opFilter;
    $("opOrg").value = f.org;
    $("opOpen").checked = f.open;
    const base = opCache.filter((s) => (!f.org || String(s.ev.orgId) === f.org) && (!f.open || s.attending < s.capacity) && (!f.event || s.eventId === f.event));
    const shown = base.filter((s) => f.cat === "" || String(s.ev.category) === f.cat);
    const count = (i) => base.filter((s) => Number(s.ev.category) === i).length;
    $("opCats").innerHTML = [`<button type="button" class="facet${f.cat === "" ? " on" : ""}" data-cat="">All areas <em>${base.length}</em></button>`,
      ...CATS.map((name, i) => `<button type="button" class="facet c${i}${f.cat === String(i) ? " on" : ""}" data-cat="${i}" ${count(i) ? "" : "disabled"}>${name} <em>${count(i)}</em></button>`)].join("");
    const ev = f.event && evMeta.get(f.event);
    $("opEvent").hidden = !ev;
    if (ev) $("opEvent").innerHTML = `Event: ${esc(ev.code)} <span aria-hidden="true">×</span>`;
    $("opList").innerHTML = shown.length ? shown.map((s) => {
      const left = s.capacity - s.attending, hrs = Math.round(((s.end - s.start) / 3600) * 10) / 10;
      return `<li class="op c${Number(s.ev.category)}"><div class="op-main"><span class="op-cat">${CATS[Number(s.ev.category)]}</span><strong>${esc(s.ev.code)}</strong>
        <span>${esc(s.org.name)} · up to ${s.ev.maxHours} verified hours</span></div>
        <div class="op-when"><strong>${fmt(s.start)}</strong><span>until ${fmtT(s.end)} · ${hrs}h shift</span></div>
        <div class="op-spots"><span class="badge ${left > 0 ? "ok" : "neutral"}">${left > 0 ? `${left} of ${s.capacity} spots left` : "Full"}</span>${s.site ? '<span class="small muted">optional location check</span>' : ""}</div></li>`;
    }).join("") : `<li class="muted small">${opCache.length ? "No shifts match these filters." : "No upcoming shifts right now. NGOs publish shifts from their Attendance page."}</li>`;
  }
  $("opCats").onclick = (e) => { const b = e.target.closest("[data-cat]"); if (b) { opFilter.cat = b.dataset.cat; renderOpps(); } };
  $("opOrg").onchange = () => { opFilter.org = $("opOrg").value; renderOpps(); };
  $("opOpen").onchange = () => { opFilter.open = $("opOpen").checked; renderOpps(); };
  $("opEvent").onclick = () => { opFilter.event = null; renderOpps(); };

  // ---------- Stage 5: credentials, private profile, transcript, impact reports, auditor console ----------
  async function idxFetch(path, auth) {
    const headers = auth ? { authorization: "Bearer " + (await ensureSession()).token } : {};
    let r;
    try { r = await fetch(IDX + path, { headers }); } catch { throw new Error(`The indexer at ${IDX} is not reachable. Start it with "node server/indexer.js".`); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `The indexer answered with an error (${r.status}).`);
    return j;
  }
  const download = (name, text, type) => Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  // CSV cell: quoted, and a leading = + - @ is neutralised so spreadsheets don't run it as a formula
  const csvq = (v) => `"${String(v).replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"`;

  // ----- Open Badges 3.0 credential for one badge -----
  async function getCredential(tokenId) {
    const msg = $("vaultForm").querySelector(".msg");
    msg.className = "msg";
    msg.textContent = (await signedIn()) ? "Issuing…" : "Sign the sign-in message in your wallet (free, no transaction)…";
    try {
      const { jwt, credential } = await api("/credentials", { method: "POST", body: { tokenId } });
      const a = download(`proofhours-badge-${tokenId}.jwt`, jwt, "application/jwt");
      msg.className = "msg ok";
      msg.innerHTML = `${ICON.check}<span><strong>Open Badges 3.0 credential issued for badge #${tokenId}.</strong> <a href="${a.href}" download="${a.download}" id="credDl" data-jwt="${jwt}">Download .jwt</a>
        <details class="cred-json"><summary>Show the credential</summary><pre>${esc(JSON.stringify(credential, null, 2))}</pre></details>
        It stays valid while the badge is held; anyone can check it on the Verify page.</span>`;
    } catch (err) { logError("credential", err); msg.className = "msg err"; msg.textContent = declined(err); }
  }
  $("credForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = e.target.querySelector(".msg");
    if (!API) { msg.className = "msg err"; msg.textContent = `Credential checks need the ProofHours service, which isn't running for ${C.netName} yet.`; return; }
    msg.className = "msg";
    msg.textContent = "Checking…";
    try {
      const v = await api("/credentials/verify", { method: "POST", auth: false, body: { jwt: $("credJwt").value.trim() } });
      msg.className = "msg " + (v.valid ? "ok" : "err");
      msg.innerHTML = `<strong>${v.valid ? "Valid credential" : "Not valid"}</strong>${v.achievement ? ` · ${esc(v.achievement)} for <code>${esc(v.subject ?? "")}</code>` : ""}
        <ul class="checks">${v.checks.map((c) => `<li class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${esc(c.what)}</li>`).join("")}</ul>`;
    } catch (err) { msg.className = "msg err"; msg.textContent = err.message; }
  };

  // ----- private profile (encrypted vault) -----
  let profile = { fields: {}, visibility: {}, linkKey: null };
  const PF = [["displayName", "pfName"], ["school", "pfSchool"], ["bio", "pfBio"]];
  function showProfile(p) {
    profile = p;
    PF.forEach(([f, id]) => { $(id).value = p.fields?.[f] ?? ""; $(id + "Vis").value = p.visibility?.[f] ?? "private"; });
    $("pfLoad").textContent = "Reload";
  }
  async function renderProfile(own, me) {
    $("profileForm").hidden = !(own && API);
    $("ppProfileView").hidden = true;
    if (own && API) { if (await signedIn()) showProfile(await api("/profile").catch(() => profile)); return; }
    if (!own && API && me) {
      const shared = await api(`/profile/public/${me}${viewKey ? `?k=${encodeURIComponent(viewKey)}` : ""}`, { auth: false }).catch(() => ({ fields: {} }));
      const parts = [shared.fields.displayName, shared.fields.school, shared.fields.bio].filter(Boolean);
      $("ppProfileView").hidden = !parts.length;
      $("ppProfileView").innerHTML = `${ICON.info}<div><strong>Shared by this volunteer:</strong> ${parts.map(esc).join(" · ")} <span class="small muted">(off-chain profile, not verified by NGOs)</span></div>`;
    }
  }
  $("profileForm").onsubmit = (e) => {
    e.preventDefault();
    act(e.target, async () => showProfile(await api("/profile", { method: "PUT", body: {
      fields: Object.fromEntries(PF.map(([f, id]) => [f, $(id).value])), visibility: Object.fromEntries(PF.map(([f, id]) => [f, $(id + "Vis").value])) } })) ?? profile,
    () => "<strong>Profile saved, encrypted.</strong> Fields set to Link are visible to people you send your share link to.");
  };
  $("pfLoad").onclick = () => act($("profileForm"), async () => { showProfile(await api("/profile")); return profile; }, () => "Profile loaded.");
  $("pfDelete").onclick = () => confirmCard($("profileForm"), "<p><strong>Delete your profile?</strong> Its encryption key is destroyed, so the data can't be recovered by anyone, including from backups. Your on-chain hours and badges are not affected.</p>",
    "Delete profile", () => act($("profileForm"), async () => { await api("/profile", { method: "DELETE" }); showProfile({ fields: {}, visibility: {}, linkKey: null }); return true; }, () => "<strong>Profile erased.</strong> The key is destroyed; the data is unrecoverable."));

  // ----- printable transcript (Save as PDF from the print dialog) -----
  let lastPassport = null;
  $("ppPrint").onclick = () => {
    const P = lastPassport;
    if (!P) return toast("Connect a wallet or open a passport first.", "err");
    const link = `${location.origin}${location.pathname}${location.search}#passport=${P.me}`;
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    const name = P.own ? profile.fields?.displayName : null;
    $("transcriptView").innerHTML = `<header class="tr-head"><div><h1>Co-curricular volunteering transcript</h1>
        <p>${name ? `<strong>${esc(name)}</strong> · ` : ""}wallet <code>${P.me}</code></p>
        <p>Generated ${new Date().toLocaleString()} · ${esc(C.netName)} (chain ${C.chainId}) · ProofHoursLedger <code>${V2.ledger}</code></p></div>
        <div class="tr-qr">${qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true })}<small>Scan to verify live</small></div></header>
      <h2>Verified hours: ${P.total}</h2>
      <table><thead><tr><th>Impact area</th><th>Verified hours</th></tr></thead><tbody>${CATS.map((c, i) => `<tr><td>${c}</td><td>${P.catH[i]}h</td></tr>`).join("")}</tbody></table>
      <h2>Records</h2>
      <table><thead><tr><th>Record</th><th>Event</th><th>NGO</th><th>Area</th><th>Service date</th><th>Status</th><th>Hours</th></tr></thead>
        <tbody>${P.records.map((r) => `<tr><td>#${r.id}</td><td>${esc(r.what)}</td><td>${esc(r.org)}</td><td>${r.area}</td><td>${r.serviceDay ? dateOf(r.serviceDay) : "V1 import"}</td><td>${r.status}</td><td>${r.hours}h</td></tr>`).join("") || `<tr><td colspan="7">No records.</td></tr>`}</tbody></table>
      <h2>Soulbound badges</h2><p>${P.badges.map(esc).join(" · ") || "None yet."}</p>
      <footer>Every figure is read from the ProofHours ledger. Hours come only from accredited NGOs; the latest entry of each record counts, so corrections and revocations are applied. Check it live: ${esc(link)}</footer>`;
    document.body.classList.add("print-transcript");
    $("transcriptView").hidden = false;
    window.print();
  };
  window.addEventListener("afterprint", () => { document.body.classList.remove("print-transcript"); $("transcriptView").hidden = true; });

  // ----- impact reports -----
  async function loadReports() {
    const c = await available("rpNotice", "rpBody");
    if (!c) return;
    if (!IDX) {
      $("rpNotice").innerHTML = `${ICON.info}<div><strong>Impact reports aren't available for ${esc(C.netName)} yet.</strong> They come from the indexer, which runs locally for now (<code>node server/indexer.js</code>, then open this page with <code>?local</code>).</div>`;
      $("rpNotice").hidden = false;
      $("rpBody").hidden = true;
      return;
    }
    const orgs = await idxFetch("/reports/orgs"), keep = $("rpOrg").value;
    $("rpOrg").innerHTML = orgs.length ? orgs.map((o) => `<option value="${o.id}">${esc(o.name)}${o.suspended ? " (suspended)" : ""}</option>`).join("") : `<option value="">No NGOs indexed yet</option>`;
    if (keep) $("rpOrg").value = keep;
  }
  $("reportForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = e.target.querySelector(".msg");
    msg.className = "msg";
    msg.textContent = "Building…";
    try {
      const qs = new URLSearchParams();
      if ($("rpFrom").value) qs.set("from", $("rpFrom").value);
      if ($("rpTo").value) qs.set("to", $("rpTo").value);
      const r = await idxFetch(`/reports/org/${$("rpOrg").value}?${qs}`);
      if (!r.org) throw new Error("Choose an NGO.");
      const period = `${r.from ? dateOf(r.from) : "the start"} to ${r.to < 1e8 ? dateOf(r.to) : "today"}`;
      const csv = ["NGO,Period,Impact area,Verified hours,Records", ...r.byCategory.map((x) => [csvq(r.org.name), csvq(period), csvq(x.name), x.hours, x.records].join(",")), [csvq(r.org.name), csvq(period), csvq("Total"), r.totalHours, r.records].join(",")].join("\n");
      const a = download(`proofhours-ngo-${r.org.id}-report.csv`, csv, "text/csv");
      $("rpOut").hidden = false;
      $("rpOut").innerHTML = `<div class="panel-head"><h3>${esc(r.org.name)}</h3><span class="hint">service dates ${period}</span></div>
        <div class="rp-totals"><div><strong>${r.totalHours}</strong><span>verified hours</span></div><div><strong>${r.records}</strong><span>records</span></div><div><strong>${r.events}</strong><span>events</span></div><div><strong>${r.corrected} / ${r.revoked}</strong><span>corrected / revoked</span></div></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Impact area</th><th>Verified hours</th><th>Records</th></tr></thead><tbody>${r.byCategory.map((x) => `<tr><td>${x.name}</td><td>${x.hours}h</td><td>${x.records}</td></tr>`).join("")}</tbody></table></div>
        <p class="small muted">Read from the indexer, which mirrors the ledger. Hours only: no volunteer is identified. Records imported from V1 aren't attributed to an NGO here.</p>
        <a class="btn btn-ghost sm" id="rpCsv" href="${a.href}" download="${a.download}">Download CSV</a>`;
      msg.className = "msg ok";
      msg.innerHTML = `${ICON.check}<span>Report built.</span>`;
    } catch (err) { msg.className = "msg err"; msg.textContent = err.message; }
  };

  // ----- auditor console -----
  const RULE_NAMES = { "large-single": "Large single issuance", spike: "Issuance spike", "correction-rate": "High correction rate", backdated: "Back-dated issuance" };
  const OUTCOME_NAMES = { dismissed: "dismissed, no issue found", "referred-to-governance": "referred to governance for revocation", "org-suspended": "NGO suspended" };
  let auditCases = [];
  async function loadAudit() {
    const c = await available("auNotice", "auBody");
    if (!c) return;
    if (!API || !IDX) {
      $("auNotice").innerHTML = `${ICON.info}<div><strong>The auditor console isn't available for ${esc(C.netName)} yet.</strong> It needs the indexer and the ProofHours service, which run locally for now.</div>`;
      $("auNotice").hidden = false;
      $("auBody").hidden = true;
      return;
    }
    const me = await currentAccount(), isAud = me ? await c.ledger.hasRole(ethers.id("AUDITOR_ROLE"), me) : false;
    $("auContext").className = "banner " + (isAud ? "ok" : "warn");
    $("auContext").innerHTML = !me ? `${ICON.alert}<div><strong>No wallet connected.</strong> Connect the wallet that holds the auditor role.</div>`
      : !isAud ? `${ICON.alert}<div><strong>${short(me)} doesn't hold the auditor role.</strong> Alerts, samples and cases are refused for it.</div>`
      : `${ICON.shield}<div>Auditor wallet <strong>${short(me)}</strong>. You can suspend an NGO; only governance can reinstate it or revoke records.</div>`;
    if (await signedIn()) await refreshAudit().catch((e) => toast(declined(e), "err"));
  }
  async function refreshAudit() {
    const [alerts, cases] = await Promise.all([idxFetch("/audit/alerts", true), api("/cases")]);
    auditCases = cases;
    $("auLoad").textContent = "Refresh";
    $("auAlerts").innerHTML = alerts.length ? alerts.map((a) => `<li class="shift"><div><strong>${esc(RULE_NAMES[a.rule] ?? a.rule)} · ${esc(a.org)}</strong><br><span>${esc(a.detail)}</span><br><span class="badge warn">Allegation · needs human review</span></div>
        <div class="shift-actions"><button type="button" class="btn btn-ghost sm" data-case-subject="${esc(`alert ${a.id}: ${RULE_NAMES[a.rule] ?? a.rule}`)}" data-case-org="${a.orgId ?? ""}" data-case-note="${esc(a.detail)}">Open case</button></div></li>`).join("")
      : `<li class="muted small">No alerts: the rules found nothing to review.</li>`;
    renderCases();
  }
  function renderCases() {
    $("auCases").innerHTML = auditCases.length ? auditCases.map((c) => `<li class="case" data-case="${c.id}">
      <div class="case-head"><strong>Case #${c.id} · ${esc(c.subject)}</strong><span class="badge ${c.status === "open" ? "warn" : "neutral"}">${c.status === "open" ? "Open" : "Closed: " + esc(OUTCOME_NAMES[c.outcome] ?? c.outcome)}</span></div>
      <ol class="case-notes">${c.notes.map((n) => `<li><span class="mono">${fmt(n.at)} · ${short(n.by)}</span> ${esc(n.text)}${n.txHash ? ` · ${txLinks(n.txHash)}` : ""}</li>`).join("")}</ol>
      <div class="case-actions">${c.status === "open" ? `<input data-note placeholder="What did you check, or why you decided" maxlength="2000" aria-label="Note for case ${c.id}">
        <button type="button" class="btn btn-ghost sm" data-act="note">Add note</button>
        <select data-outcome aria-label="Outcome for case ${c.id}"><option value="dismissed">Dismiss: no issue found</option><option value="referred-to-governance">Refer to governance for revocation</option><option value="org-suspended">NGO suspended</option></select>
        <button type="button" class="btn btn-ghost sm" data-act="close">Close case</button>
        ${c.orgId ? `<button type="button" class="btn btn-danger sm" data-act="suspend">Suspend NGO #${c.orgId} on-chain</button>` : ""}` : ""}
        <button type="button" class="btn btn-ghost sm" data-act="export">Export evidence</button></div></li>`).join("")
      : `<li class="muted small">No cases yet. Open one from an alert or a sampled record.</li>`;
  }
  const caseMsg = (ok, html) => { const m = $("caseForm").querySelector(".msg"); m.className = "msg " + (ok ? "ok" : "err"); m.innerHTML = ok ? `${ICON.check}<span>${html}</span>` : esc(html); };
  async function openCase(b) {
    try {
      const c = await api("/cases", { method: "POST", body: { subject: b.dataset.caseSubject, orgId: b.dataset.caseOrg ? Number(b.dataset.caseOrg) : null, note: b.dataset.caseNote } });
      auditCases = [c, ...auditCases];
      renderCases();
      caseMsg(true, `<strong>Case #${c.id} opened.</strong> Record what you check before deciding.`);
    } catch (e) { caseMsg(false, declined(e)); }
  }
  $("auLoad").onclick = async () => { $("auLoad").disabled = true; try { await ensureSession(); await refreshAudit(); } catch (e) { toast(declined(e), "err"); } finally { $("auLoad").disabled = false; } };
  $("auAlerts").onclick = (e) => { const b = e.target.closest("[data-case-subject]"); if (b) openCase(b); };
  $("smList").onclick = (e) => { const b = e.target.closest("[data-case-subject]"); if (b) openCase(b); };
  $("sampleForm").onsubmit = (e) => {
    e.preventDefault();
    act(e.target, async () => {
      const seed = $("smSeed").value.trim(), s = await idxFetch(`/audit/sample?rate=${$("smRate").value}${seed ? `&seed=${seed}` : ""}`, true);
      const c = await contracts(), recs = await Promise.all(s.records.map((id) => c.ledger.getRecord(id)));
      $("smList").innerHTML = recs.map((r) => `<li class="shift"><div><strong>Record #${r.id}</strong><br><span>${r.hoursLogged}h ${CATS[Number(r.category)]} · NGO #${r.orgId} · service ${r.serviceDay ? dateOf(r.serviceDay) : "V1 import"}</span></div>
        <div class="shift-actions"><button type="button" class="btn btn-ghost sm" data-case-subject="sample record #${r.id}" data-case-org="${r.orgId}" data-case-note="Spot audit (seed ${s.seed.slice(0, 10)}…, rate ${s.rate * 100}%): check the evidence for record #${r.id}.">Open case</button></div></li>`).join("") || `<li class="muted small">No records fell in this sample.</li>`;
      return s;
    }, (s) => `Sample: <strong>${s.records.length}</strong> of ${s.population} records at ${s.rate * 100}%. Seed <code title="${s.seed}">${short(s.seed)}</code>: the same seed always draws the same sample.`);
  };
  $("auCases").onclick = async (e) => {
    const b = e.target.closest("[data-act]"), li = e.target.closest("[data-case]");
    if (!b || !li) return;
    const id = Number(li.dataset.case), c = auditCases.find((x) => x.id === id), note = li.querySelector("[data-note]")?.value.trim();
    const update = (u) => { auditCases = auditCases.map((x) => (x.id === u.id ? u : x)); renderCases(); };
    try {
      if (b.dataset.act === "note") { if (!note) throw new Error("Write the note first."); update(await api(`/cases/${id}/note`, { method: "POST", body: { text: note } })); caseMsg(true, "Note added."); }
      if (b.dataset.act === "close") {
        if (!note) throw new Error("Write the reason for your decision in the note box first.");
        update(await api(`/cases/${id}/close`, { method: "POST", body: { outcome: li.querySelector("[data-outcome]").value, note } }));
        caseMsg(true, `<strong>Case #${id} closed.</strong>`);
      }
      if (b.dataset.act === "export") {
        const bundle = await api(`/cases/${id}/export`);
        download(`proofhours-case-${id}.json`, JSON.stringify(bundle, null, 2), "application/json").click();
        caseMsg(true, `Evidence for case #${id} exported (SHA-256 <code>${bundle.sha256.slice(0, 16)}…</code>).`);
      }
      if (b.dataset.act === "suspend") {
        confirmCard($("caseForm"), `<p><strong>Suspend NGO #${c.orgId}?</strong> Your auditor wallet sends <code>suspendOrg</code>. The NGO can't issue, correct or approve until governance reinstates it.</p>`, "Suspend NGO", async () => {
          const receipt = await send($("caseForm"), "suspendOrg", () => [c.orgId], ledgerTarget);
          if (!receipt) return;
          update(await api(`/cases/${id}/note`, { method: "POST", body: { text: `Suspended NGO #${c.orgId} on-chain.`, txHash: receipt.hash } }));
        });
      }
    } catch (err) { caseMsg(false, declined(err)); }
  };
  Object.assign(TX_LABEL, { suspendOrg: "Suspend NGO" });

  // ----- Role pill (app.js): V2 roles next to V1 roles -----
  window.v2Role = async (account) => {
    if (!V2) return null;
    try {
      const c = await contracts();
      if ((await c.ledger.runner.getCode(V2.ledger)) === "0x") return null;
      const [org, opted, auditor] = await Promise.all([c.ledger.coordinatorOrg(account), c.ledger.optedIn(account), c.ledger.hasRole(ethers.id("AUDITOR_ROLE"), account)]);
      return { org: org ? (await c.ledger.getOrg(org)).name : null, opted, auditor };
    } catch (e) { console.warn("V2 role lookup failed", e); return null; }
  };

  PAGE_LOAD.reports = () => { loadReports().catch((e) => toast(declined(e), "err")); };
  PAGE_LOAD.audit = () => { loadAudit().catch((e) => toast(declined(e), "err")); };
  PAGE_LOAD.attend = () => { loadAttendance().catch((e) => toast(declined(e), "err")); };
  PAGE_LOAD.checkin = () => { loadCheckin().catch((e) => toast(declined(e), "err")); };
  PAGE_LOAD.opps = () => { loadOpps().catch((e) => { logError("opportunities", e); $("opList").innerHTML = `<li class="msg err">${esc(declined(e))}</li>`; }); };
  window.addEventListener("hashchange", v2FromHash);
  // the sidebar's "My passport" always means your own wallet
  document.querySelector('.nav-item[data-page="passport"]').addEventListener("click", () => { if (viewAddr) { viewAddr = viewKey = null; history.replaceState(null, "", location.pathname + location.search); loadPassport(); } });
  if (!$("shStart").value) { const d = new Date(); d.setMinutes(0, 0, 0); $("shStart").value = localInput(d); d.setHours(d.getHours() + 3); $("shEnd").value = localInput(d); }

  PAGE_LOAD.passport = loadPassport;
  PAGE_LOAD.issue2 = loadIssuance;
  window.ethereum?.on?.("accountsChanged", () => {
    if (!$("passport").hidden) loadPassport();
    if (!$("issue2").hidden) loadIssuance();
    if (!$("attend").hidden) loadAttendance();
    if (!$("checkin").hidden) loadCheckin();
    if (!$("audit").hidden) loadAudit();
  });
  v2FromHash(); // last: every page loader above must be registered first (direct #passport= / #checkin= links)
})();
