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
    return null;
  });

  const ledgerTarget = () => walletContract(V2.ledger, ABI.ledger);
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
  async function loadPassport() {
    const c = await available("ppNotice", "ppBody");
    if (!c) return;
    const me = await currentAccount();
    const consent = $("ppConsent"), optForm = $("ppOptForm");
    if (!me) {
      consent.innerHTML = `${ICON.info}<span><strong>Connect your wallet</strong> to see its passport. Your passport is tied to the wallet you volunteer with.</span>`;
      optForm.querySelector("button").hidden = true;
      $("ppSummary").innerHTML = "";
      $("ppVault").innerHTML = `<p class="muted small">Connect a wallet to see its badges.</p>`;
      $("ppRecords").innerHTML = `<li class="muted small">No wallet connected.</li>`;
      return;
    }
    const [opted, total, cats] = await Promise.all([c.ledger.optedIn(me), c.ledger.totalHours(me), c.ledger.categoryHours(me)]);
    optForm.querySelector("button").hidden = opted;
    consent.innerHTML = opted
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

    await renderVault(c, me, t, catH);
    await renderRecords(c, me);
  }

  async function renderVault(c, me, total, catH) {
    const slots = [...TOTAL_T.map((th) => [0, th]), ...CAT_T.flatMap((th) => [1, 2, 3, 4, 5].map((k) => [k, th]))];
    const ids = await Promise.all(slots.map(([k, th]) => c.badges.tokenOfKey(keyOf(me, k, th))));
    const earned = slots.map((s, i) => [...s, ids[i]]).filter(([, , id]) => id !== 0n);
    const art = await Promise.all(earned.map(async ([k, th, id]) => {
      const json = JSON.parse(atob((await c.badges.tokenURI(id)).split(",")[1]));
      return `<figure class="trophy"><img src="${json.image}" alt="${esc(json.name)}" width="120" height="120"><figcaption><strong>${th}h ${esc(k === 0 ? "total" : CATS[k - 1])}</strong><span>Token #${id} · soulbound</span></figcaption></figure>`;
    }));
    // next goals: the next total milestone and the next one in every area already started (outlines, not art)
    const goals = [];
    const nt = nextOf(total, TOTAL_T);
    if (nt) goals.push([`${nt}h total`, nt - total]);
    catH.forEach((h, i) => { const n = nextOf(h, CAT_T); if (h > 0 && n) goals.push([`${n}h ${CATS[i]}`, n - h]); });
    $("ppVault").innerHTML = (art.length ? art.join("") : `<p class="muted small vault-empty">No badges yet. The first one is minted on-chain at 10 verified hours.</p>`) +
      goals.map(([label, left]) => `<figure class="trophy goal" aria-label="Not earned yet"><div class="goal-ring" aria-hidden="true"></div><figcaption><strong>${label}</strong><span>Not earned yet · ${left}h to go</span></figcaption></figure>`).join("");
  }

  async function renderRecords(c, me) {
    const [ids] = await c.ledger.originalsOf(me, 0, 100);
    if (!ids.length) return ($("ppRecords").innerHTML = `<li class="muted small">No records yet. Hours appear here once an NGO issues them to this wallet.</li>`);
    const rows = await Promise.all(ids.map(async (id) => {
      const h = await c.ledger.headOf(id);
      const [ev, org] = await Promise.all([h.eventId ? c.ledger.getFunction("getEvent")(h.eventId) : null, c.ledger.getOrg(h.orgId)]);
      const t = Number(h.entryType);
      const status = t === 2 ? ["bad", "Revoked"] : t === 1 ? ["warn", "Corrected"] : t === 3 ? ["neutral", "From V1"] : ["ok", "Valid"];
      const what = ev ? esc(ev.code) : `V1 record #${h.v1RecordId}`;
      return `<li class="ir"><span class="vd ${status[0] === "ok" ? "valid" : status[0] === "warn" ? "corrected" : status[0] === "bad" ? "revoked" : "notfound"}" aria-hidden="true"></span>
        <div class="ir-main"><strong>${what}</strong><span>${esc(org.name)} · ${CATS[Number(h.category)]} · record #${id}${h.id !== id ? ` → #${h.id}` : ""}</span></div>
        <span class="badge ${status[0]}">${status[1]}</span><strong class="ir-h">${t === 2 ? 0 : h.hoursLogged}h</strong>
        <span class="ir-proof">${ENTRY2[t]}${h.reason !== ethers.ZeroHash ? " · " + esc(ethers.decodeBytes32String(h.reason)) : ""}</span></li>`;
    }));
    $("ppRecords").innerHTML = rows.join("");
  }

  // ---------- Issuance ----------
  let myOrg = 0n;
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
    const n = Number(await c.ledger.eventCount());
    // shortcut: reads every event; Stage 3's indexer replaces this with a per-NGO query
    const evs = (await Promise.all(Array.from({ length: n }, (_, i) => c.ledger.getFunction("getEvent")(i + 1)))).map((e, i) => [i + 1, e]).filter(([, e]) => myOrg !== 0n && e.orgId === myOrg);
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
      // shortcut: evidence is a hash of this roster line until Stage 2 attaches attendance records
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

  PAGE_LOAD.passport = loadPassport;
  PAGE_LOAD.issue2 = loadIssuance;
  window.ethereum?.on?.("accountsChanged", () => {
    if (!$("passport").hidden) loadPassport();
    if (!$("issue2").hidden) loadIssuance();
  });
})();
