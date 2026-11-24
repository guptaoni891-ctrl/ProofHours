// Reads go through a read-only RPC (never a wallet). Writes go through MetaMask.
const C = window.CONFIG;
const params = new URLSearchParams(location.search);
const LOCAL = params.has("local") || /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(params.get("rpc") || "");
if (LOCAL) Object.assign(C, C.local);
const $ = (id) => document.getElementById(id);
const iface = new ethers.Interface(C.abi);
const ENTRY = ["ORIGINAL", "CORRECTION", "REVOCATION"];
const ENTRY_NICE = ["Original", "Correction", "Revocation"];
const RECORD_TOPICS = ["HoursRecorded", "CorrectionAppended", "RevocationAppended"].map((n) => iface.getEvent(n).topicHash);
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

const short = (a) => String(a).slice(0, 6) + "…" + String(a).slice(-4);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); // org labels and event codes are user-written
const fingerprint = (salt, id) => ethers.solidityPackedKeccak256(["bytes32", "string"], [salt, id]);
const reasonText = (b) => { try { return ethers.decodeBytes32String(b); } catch { return b; } };
const links = (path) => C.explorers.map((e) => `<a href="${e.url}/${path}" target="_blank" rel="noopener">${e.name}</a>`).join(" · ");
const txLinks = (h) => `tx <code>${short(h)}</code>${C.explorers.length ? ` (${links("tx/" + h)})` : ""}`;
const addrHtml = (a) => `<code title="${a}">${short(a)}</code> <span class="small">${links("address/" + a)}</span>`;
const when = (ts) => new Date(Number(ts) * 1000).toLocaleString();
const demoFp = (id) => { const v = DEMO_VOLUNTEERS.find((d) => d.id === id); return fingerprint(v.salt, v.id); };
const badSalt = (s) => !ethers.isHexString(s, 32);
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const SALT_HELP = "The salt must be 0x followed by 64 hex characters.";

const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICON = {
  check: svg('<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  x: svg('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/>'),
  alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'),
  chain: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  cpu: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'),
  shield: svg('<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
};
const TYPE_ICON = [ICON.check, ICON.edit, ICON.x];

// ---------- Small UI helpers ----------
function toast(text, kind = "info") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.setAttribute("role", kind === "err" ? "alert" : "status");
  t.textContent = text;
  $("toasts").append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 260); }, 4500);
}

function countUp(el, to) {
  if (REDUCED_MOTION) return (el.textContent = to.toLocaleString());
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / 700);
    el.textContent = Math.round(to * (1 - (1 - p) ** 3)).toLocaleString();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- Read-only provider: try each RPC in order ----------
const rpcOverride = params.get("rpc");
const rpcList = rpcOverride ? [rpcOverride] : C.rpcs;
let readerPromise, activeRpc;
const reader = () => (readerPromise ??= connectReader());
// batchMaxCount 1: some free RPCs reject JSON-RPC batches
const makeProvider = (url) => new ethers.JsonRpcProvider(url, C.chainId, { staticNetwork: true, batchMaxCount: 1 });

let readCode = "0x"; // contract bytecode on the chain the page reads (shown on the Network page)
async function connectReader() {
  for (const url of rpcList) {
    let p, code, chain;
    try {
      p = makeProvider(url);
      [code, chain] = await Promise.all([p.getCode(C.address), p.send("eth_chainId", [])]);
    } catch (e) {
      console.warn("RPC failed, trying next:", url, e);
      continue;
    }
    activeRpc = url;
    readCode = code;
    if (Number(chain) !== C.chainId) {
      const t = `The RPC ${new URL(url).host} is chain ${Number(chain)}, but this page expects ${C.netName} (chain ${C.chainId}).${LOCAL ? ` Restart anvil with --chain-id ${C.chainId}.` : ""}`;
      $("netAlert").innerHTML = `${ICON.alert}<div><strong>Wrong chain.</strong> ${esc(t)}</div>`;
      $("netAlert").hidden = false;
      throw new Error(t);
    }
    $("rpcInfo").textContent = new URL(url).host;
    // Without this, every read fails as "could not decode" and writes become plain transfers to an empty address.
    if (code === "0x") {
      const t = `No VolunteerHours contract is deployed at ${C.address} on the network read via ${new URL(url).host}. Deploy it, then put its address in docs/config.js.`;
      $("netAlert").innerHTML = `${ICON.alert}<div><strong>Not connected to a contract.</strong> ${esc(t)}</div>`;
      $("netAlert").hidden = false;
      throw new Error(t);
    }
    return new ethers.Contract(C.address, C.abi, p);
  }
  readerPromise = null; // let the next click retry
  throw new Error(`Could not reach the ${C.netName} network. Check your internet connection${LOCAL ? " and that anvil is running on " + C.rpcs[0] : ""}, then try again.`);
}

// ---------- Friendly errors ----------
function explain(name, a) {
  switch (name) {
    case "UnauthorizedAdmin": return `${short(a[0])} is not the university admin, so it cannot add or remove coordinators.`;
    case "UnauthorizedCoordinator": return `${short(a[0])} is not an active NGO coordinator registered by the university.`;
    case "InvalidAddress": return "that is not a valid wallet address.";
    case "InvalidDuration": return `an event must last 1 to 24 hours (you entered ${a[0]}).`;
    case "EventNotFound": return `event #${a[0]} does not exist.`;
    case "NotEventOwner": return `event #${a[0]} belongs to another coordinator (${short(a[2])}). Only they can record hours for it.`;
    case "EmptyCommitment": return "the volunteer fingerprint is empty.";
    case "InvalidHours": return a[0] == 0n ? "hours must be at least 1." : `${a[0]} hours exceeds this event's ${a[1]}-hour limit.`;
    case "DuplicateVolunteerRecord": return `this volunteer already has a record for event #${a[0]}. Append a correction instead.`;
    case "RecordNotFound": return `record #${a[0]} does not exist.`;
    case "NotOriginalIssuer": return `only the NGO that issued record #${a[0]} (${short(a[2])}) can correct or revoke it.`;
    case "RecordAlreadySuperseded": return `record #${a[0]} was already replaced by record #${a[1]}. Correct or revoke the latest one instead.`;
    case "RecordIsRevoked": return `record #${a[0]} is a revocation and can no longer be changed.`;
  }
  return name;
}

// Returns the decoded custom error ({ name, args }) or null.
function decodeRevert(e) {
  if (e?.revert) return e.revert;
  for (const d of [e?.data, e?.info?.error?.data, e?.info?.error?.data?.data, e?.error?.data]) {
    if (typeof d === "string" && d.startsWith("0x")) try { return iface.parseError(d); } catch {}
  }
  return null;
}

function friendly(e) {
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || e?.info?.error?.code === 4001) return "You cancelled the request in your wallet. Nothing was sent.";
  if (e?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(e?.message)) return `This wallet has no ${C.netName} ETH for the fee. ${LOCAL ? "Fund it from an anvil account" : "Get some from a Base Sepolia faucet"}, then try again.`;
  const err = decodeRevert(e);
  if (err) return "Refused by the contract: " + explain(err.name, err.args);
  if (e?.code === "CALL_EXCEPTION") return "Refused by the contract (no reason was returned). Check you are using the right wallet and record number.";
  if (e?.code === "BAD_DATA") return "No contract answered at the configured address on this network. Check the address in config.js.";
  if (e?.code === "NETWORK_ERROR") return `Your wallet changed network. Click "Switch to ${C.netName}" and try again.`;
  if (e?.code === "UNKNOWN_ERROR") {
    // ethers' "could not coalesce error": the wallet's own message is nested inside
    const inner = e.error?.data?.message || e.error?.message || "no details";
    if (/nonce too high/i.test(inner)) return "Your wallet's saved nonce is ahead of the chain (usually a restarted local Anvil). In MetaMask: Settings › Advanced › Clear activity tab data, then retry.";
    return `Your wallet returned an error during ${e.payload?.method || "the request"}: "${inner}". Nothing was recorded.`;
  }
  return e?.shortMessage || e?.message || String(e);
}

// Full error for the console (never contains keys: wallets don't put them in errors).
const logError = (where, e) => console.error(where, { code: e?.code, shortMessage: e?.shortMessage, reason: e?.reason, method: e?.payload?.method ?? e?.info?.payload?.method, data: e?.data, infoError: e?.info?.error, walletError: e?.error, e });

// ---------- Wallet + roles ----------
let account = null, role = "none", isCoord = false, orgLabel = "", wrongNet = false, myEventCount = 0;

async function walletContract() {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask to write records. (Verifying needs no wallet.)");
  const bp = new ethers.BrowserProvider(window.ethereum); // fresh each time so a network switch never breaks it
  const signer = await bp.getSigner();
  if ((await bp.getNetwork()).chainId !== BigInt(C.chainId)) throw new Error(`Your wallet is on the wrong network. Click "Switch to ${C.netName}" and try again.`);
  if (!(await sameChain(bp))) // also throws the clear "no contract" error first
    throw new Error(`Your wallet and this page are on different chains that both use chain id ${C.chainId} (for example the wallet on Base Sepolia while the page reads a local Anvil via ?rpc=, or the reverse). Point both at the same network. Nothing was sent.`);
  return new ethers.Contract(C.address, C.abi, signer);
}

async function refreshRole() {
  account = null; role = "none"; isCoord = false; orgLabel = ""; wrongNet = false;
  try {
    if (window.ethereum) {
      [account] = await ethereum.request({ method: "eth_accounts" });
      if (account) {
        wrongNet = (await ethereum.request({ method: "eth_chainId" })).toLowerCase() !== C.chainIdHex;
        const c = await reader();
        // one wallet can be both: the admin may register itself as a coordinator
        const [admin, [active, label]] = await Promise.all([c.admin(), c.coordinators(account)]);
        [isCoord, orgLabel] = [active, label];
        role = account.toLowerCase() === admin.toLowerCase() ? "admin" : active ? "coord" : "unauth";
      }
    }
  } catch (e) {
    console.warn(e);
    toast(friendly(e), "err");
  }
  renderWallet();
  if (account) loadMyEvents(account).catch((e) => {
    console.warn(e);
    $("rEvent").innerHTML = `<option value="">Could not load your events (see the warning at the top)</option>`;
  });
}

function renderWallet() {
  const pill = $("rolePill");
  const [text, cls] = {
    admin: [isCoord ? "ADMIN · COORDINATOR: " + orgLabel : "ADMIN", "admin"],
    coord: ["COORDINATOR: " + orgLabel, "coord"],
    unauth: ["NOT AUTHORIZED", "unauth"],
    none: ["NO WALLET", ""],
    unknown: ["ROLE UNKNOWN", "unauth"],
  }[account && role === "none" ? "unknown" : role];
  pill.textContent = text;
  pill.className = "pill " + cls;
  pill.title = text;
  $("addrChip").hidden = !account;
  $("addrChip").textContent = account ? short(account) : "";
  $("connectBtn").hidden = !!account;
  $("switchBtn").hidden = !wrongNet;
  $("netBadge").classList.toggle("wrong", wrongNet);
  $("netBadge").querySelector(".dot").className = "dot " + (wrongNet ? "warn" : "live");
  $("netBadge").querySelector(".net-text").textContent = wrongNet ? "Wallet on wrong network" : C.netName;

  // Portal banners and summary cards. Writes stay possible so the contract's own refusal can be shown, but never look like they'll succeed.
  const who = account ? `Your wallet ${short(account)}` : "No wallet is connected";
  const ok = (t) => `${ICON.shield}<div>${t}</div>`;
  const warn = (t) => `${ICON.alert}<div>${t}</div>`;
  $("coordBanner").className = "banner " + (isCoord ? "ok" : "warn");
  $("coordBanner").innerHTML = isCoord
    ? ok(`Connected as <strong>${esc(orgLabel)}</strong>. Records you write are signed by this wallet.`)
    : warn(`<strong>${who} is not an active coordinator.</strong> The contract will refuse writes from it. Connect a wallet the university registered.`);
  $("adminBanner").className = "banner " + (role === "admin" ? "ok" : "warn");
  $("adminBanner").innerHTML = role === "admin"
    ? ok("Connected as the <strong>university admin</strong>. You can register and revoke NGO coordinators.")
    : warn(`<strong>${who} is not the admin.</strong> The contract will refuse these actions from it.`);
  $("cOrg").textContent = isCoord ? orgLabel : "—";
  $("cWallet").textContent = account ? short(account) : "Not connected";
  $("aWallet").textContent = account ? short(account) : "Not connected";
  $("aRole").innerHTML = `<span class="badge ${{ admin: "warn", coord: "ok", unauth: "bad", none: "neutral" }[role]}">${text}</span>`;
}

async function loadMyEvents(acct) {
  const c = await reader();
  const n = Number(await c.eventCount());
  // shortcut: reads every event one by one; fine for tens of events, add a per-coordinator index in the contract if it grows
  const evs = await Promise.all(range(1, n).map((i) => c.events(i)));
  const mine = evs.map((e, i) => [i + 1, e]).filter(([, e]) => e.coordinator.toLowerCase() === acct.toLowerCase());
  myEventCount = mine.length;
  $("cEvents").textContent = isCoord || mine.length ? mine.length : "—";
  $("rEvent").innerHTML = mine.length
    ? mine.map(([id, e]) => `<option value="${id}">#${id} ${esc(e.eventCode)} (max ${e.maxDurationHours}h)</option>`).join("")
    : `<option value="">You have no events yet. Create one first.</option>`;
  $("myEvents").innerHTML = mine.length
    ? mine.map(([id, e]) => `<tr><td>#${id}</td><td>${esc(e.eventCode)}</td><td>${e.maxDurationHours}h</td>
        <td><button type="button" class="btn btn-ghost sm" data-use-event="${id}">Record hours</button></td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">${isCoord ? "No events yet. Create your first one above." : "Connect a coordinator wallet to see your events."}</td></tr>`;
}

// ---------- Session transaction log (only what this page sent) ----------
const sessionTx = [];
const TX_LABEL = {
  createEvent: "Create event", recordVolunteerHours: "Record hours", appendCorrection: "Append correction",
  appendRevocation: "Append revocation", registerCoordinator: "Register coordinator", revokeCoordinator: "Revoke coordinator",
};

function renderTxLists() {
  const st = { pending: ["pending", "Pending"], ok: ["ok", "Confirmed"], bad: ["bad", "Failed"] };
  const html = sessionTx.map((t) => `<details class="txitem">
      <summary><span class="st ${st[t.status][0]}">${st[t.status][1]}</span><strong>${esc(t.label)}</strong><code>${short(t.hash)}</code></summary>
      <div class="tx-body">Hash <code>${t.hash}</code><br>Sent ${t.time.toLocaleTimeString()}${t.block ? ` · block ${t.block}` : ""} · ${links("tx/" + t.hash)}</div>
    </details>`).join("");
  document.querySelectorAll("[data-txlist]").forEach((el) => (el.innerHTML = html));
}

// Sends a write, keeps the button disabled until 1 confirmation, shows the tx hash. Returns the receipt or undefined.
async function send(form, fn, argsFn) {
  const btn = form.querySelector("button[type=submit]"), msg = form.querySelector(".msg");
  btn.disabled = true;
  btn.classList.add("busy");
  msg.className = "msg";
  msg.textContent = "Confirm in your wallet…";
  let entry;
  try {
    const args = argsFn();
    const c = await walletContract();
    const tx = await c[fn](...args);
    entry = { label: TX_LABEL[fn], hash: tx.hash, status: "pending", time: new Date() };
    sessionTx.unshift(entry);
    renderTxLists();
    msg.innerHTML = `Sent, waiting for confirmation… ${txLinks(tx.hash)}`;
    const receipt = await tx.wait(1);
    Object.assign(entry, { status: "ok", block: receipt.blockNumber });
    renderTxLists();
    msg.className = "msg ok";
    msg.innerHTML = `Confirmed in block ${receipt.blockNumber}. ${txLinks(tx.hash)}`;
    toast(`${TX_LABEL[fn]}: confirmed on-chain`, "ok");
    snapshotPromise = null; // chain changed: overview and admin re-read next time
    refreshRole();
    return receipt;
  } catch (e) {
    logError(`${fn} failed`, e);
    if (entry) { entry.status = "bad"; renderTxLists(); }
    msg.className = "msg err";
    msg.textContent = friendly(e);
    toast(friendly(e), "err");
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

const needAddress = (a) => { if (!ethers.isAddress(a)) throw new Error("That is not a valid wallet address (0x followed by 40 hex characters)."); return a; };
const needSalt = (s) => { if (badSalt(s)) throw new Error(SALT_HELP); return s; };
const bytes32 = (s) => { if (new TextEncoder().encode(s).length > 31) throw new Error("Reason codes can be at most 31 characters."); return ethers.encodeBytes32String(s); };

// ---------- Chain snapshot for Overview + Admin (view calls only, no log scans) ----------
const SNAPSHOT_MAX = 200;
let snapshotPromise;
const snapshot = () => (snapshotPromise ??= loadSnapshot().catch((e) => { snapshotPromise = null; throw e; }));

async function loadSnapshot() {
  const c = await reader();
  const [nRec, nEv] = (await Promise.all([c.recordCount(), c.eventCount()])).map(Number);
  // shortcut: reads the latest 200 entries and every event with view calls; add an indexer for real volume
  const recs = await Promise.all(range(Math.max(1, nRec - SNAPSHOT_MAX + 1), nRec).map((i) => c.getRecord(i)));
  const evs = await Promise.all(range(1, nEv).map((i) => c.events(i)));
  const owners = [...new Set(evs.map((e) => e.coordinator))];
  const orgs = await Promise.all(owners.map((a) => c.coordinators(a)));
  return { nRec, nEv, recs, evs, owners, orgs };
}

async function loadOverview(force) {
  if (force) snapshotPromise = null;
  $("ovContract").innerHTML = `${C.address}<br>${links("address/" + C.address)}`;
  try {
    const s = await snapshot();
    const heads = s.recs.filter((r) => r.supersededBy === 0n);
    const hours = heads.reduce((sum, r) => sum + (r.entryType === 2n ? 0 : Number(r.hoursLogged)), 0);
    const byType = [0, 0, 0];
    s.recs.forEach((r) => byType[Number(r.entryType)]++);
    countUp($("mHours"), hours);
    countUp($("mRecords"), byType[0]);
    countUp($("mEvents"), s.nEv);
    countUp($("mOrgs"), s.orgs.filter((o) => o.active).length);
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    $("mRecordsSub").textContent = `${plural(s.nRec, "entry", "entries")} incl. ${plural(byType[1], "correction", "corrections")}, ${plural(byType[2], "revocation", "revocations")}`;
    $("metricsNote").textContent = `Live from contract ${short(C.address)} via ${new URL(activeRpc).host}${s.nRec > SNAPSHOT_MAX ? `, hours based on the latest ${SNAPSHOT_MAX} entries` : ""}. Seeded demo data with fake IDs, not real students.`;
    const latest = s.recs.slice(-6).reverse();
    $("activity").innerHTML = latest.length ? latest.map((r) => {
      const t = Number(r.entryType), ev = s.evs[Number(r.eventId) - 1];
      const what = t === 2 ? "Revoked" : `${r.hoursLogged}h ${t === 1 ? "corrected" : "recorded"}`;
      return `<li><span class="act-ico t${t}">${TYPE_ICON[t]}</span>
        <div class="act-main"><strong>Record #${r.id} · ${ENTRY_NICE[t]}</strong><span>${what} · ${esc(ev?.eventCode ?? "event #" + r.eventId)}${r.replacesRecordId ? ` · replaces #${r.replacesRecordId}` : ""}</span></div>
        <div class="act-side">${when(r.recordedAt)}<span class="tx" data-tx="${r.id}" data-block="${r.recordedBlock}"></span></div></li>`;
    }).join("") : `<li class="empty-row">No records on-chain yet.</li>`;
    fillTxLinks($("activity"), true);
  } catch (e) {
    $("metricsNote").textContent = friendly(e);
    $("activity").innerHTML = `<li class="empty-row">${esc(friendly(e))}</li>`;
  }
}

async function loadAdmin() {
  try {
    const c = await reader();
    $("adminAddr").innerHTML = addrHtml(await c.admin());
    const s = await snapshot();
    $("knownCoords").innerHTML = s.owners.length ? s.owners.map((a, i) => {
      const o = s.orgs[i], n = s.evs.filter((e) => e.coordinator === a).length;
      return `<tr><td>${esc(o.orgLabel)}</td><td><code title="${a}">${short(a)}</code></td><td>${n}</td>
        <td><span class="badge ${o.active ? "ok" : "bad"}">${o.active ? "Authorized" : "Revoked"}</span></td></tr>`;
    }).join("") : `<tr><td colspan="4" class="muted">No coordinator has created an event yet.</td></tr>`;
  } catch (e) {
    $("knownCoords").innerHTML = `<tr><td colspan="4" class="muted">${esc(friendly(e))}</td></tr>`;
  }
}

async function loadNetwork() {
  $("contractLinks").innerHTML = addrHtml(C.address);
  $("explorerLinks").innerHTML = `Contract: ${links("address/" + C.address)}`;
  const ethOk = !!window.ethereum;
  $("walletInfo").innerHTML = `
    <dt>Wallet</dt><dd>${ethOk ? "Detected" : "None installed (not needed to verify)"}</dd>
    <dt>Account</dt><dd>${account ? `<code>${account}</code>` : "Not connected"}</dd>
    <dt>Network</dt><dd>${!account ? "—" : wrongNet ? '<span class="badge warn">Wrong network</span>' : `<span class="badge ok">${esc(C.netName)}</span>`}</dd>
    <dt>Role</dt><dd>${$("rolePill").textContent}</dd>
    <dt>Contract (page RPC)</dt><dd id="dReadCode">Checking…</dd>
    ${account ? '<dt>Wallet chain id</dt><dd id="dChain">…</dd><dt>Test ETH</dt><dd id="dBal">…</dd><dt>Contract (wallet RPC)</dt><dd id="dWalletCode">…</dd><dt>Same chain as page</dt><dd id="dSame">…</dd>' : ""}`;
  diagnose();
  $("rpcTable").innerHTML = rpcList.map((u) => `<tr><td><code>${esc(new URL(u).host)}</code></td><td><span class="spinner"></span></td><td>—</td><td>—</td></tr>`).join("");
  const rows = await Promise.all(rpcList.map(async (url) => {
    const t0 = performance.now(), p = makeProvider(url);
    try {
      const b = await p.getBlockNumber();
      return { url, ok: true, ms: Math.round(performance.now() - t0), b };
    } catch { return { url, ok: false }; } finally { p.destroy(); }
  }));
  $("rpcTable").innerHTML = rows.map((r) => `<tr><td><code>${esc(new URL(r.url).host)}</code>${r.url === activeRpc ? ' <span class="badge ok">in use</span>' : ""}</td>
    <td><span class="badge ${r.ok ? "ok" : "bad"}">${r.ok ? "Online" : "Unreachable"}</span></td><td>${r.ok ? r.ms + " ms" : "—"}</td><td class="mono">${r.ok ? r.b.toLocaleString() : "—"}</td></tr>`).join("");
  try { $("nBlock").textContent = (await (await reader()).runner.getBlockNumber()).toLocaleString(); } catch (e) { $("nBlock").textContent = "Unavailable"; }
}

// Same chain id is not enough (two local Anvils, or Anvil vs Base Sepolia): compare the hash of a settled recent block.
async function sameChain(bp) {
  const r = (await reader()).runner;
  const n = Math.max(0, (await r.getBlockNumber()) - 5);
  const [a, b] = await Promise.all([r.getBlock(n), bp.getBlock(n).catch(() => null)]);
  return !!b && a.hash === b.hash;
}

// Read-only checks for the Network page: compares what the page reads with what the wallet would write to.
async function diagnose() {
  const yes = (t) => `<span class="badge ok">${t}</span>`, no = (t) => `<span class="badge bad">${t}</span>`;
  const set = (id, html) => $(id) && ($(id).innerHTML = html);
  const codeBadge = (bytes) => (bytes ? yes(`Deployed · ${bytes} bytes`) : no("Not deployed"));
  try { await reader(); set("dReadCode", codeBadge((readCode.length - 2) / 2)); } catch (e) { set("dReadCode", /No VolunteerHours/.test(e.message) ? no("Not deployed") : no("RPC unreachable")); }
  if (!account) return;
  try {
    const bp = new ethers.BrowserProvider(window.ethereum);
    const [chain, bal, code, same] = await Promise.all([bp.send("eth_chainId", []), bp.getBalance(account), bp.getCode(C.address), sameChain(bp).catch(() => null)]);
    set("dChain", `${parseInt(chain, 16)} ${parseInt(chain, 16) === C.chainId ? yes("expected") : no(`expected ${C.chainId}`)}`);
    set("dBal", `${ethers.formatEther(bal)} ETH ${bal === 0n ? no("needs faucet") : ""}`);
    set("dWalletCode", codeBadge((code.length - 2) / 2));
    set("dSame", same === null ? "—" : same ? yes("Yes") : no("No: different chains"));
  } catch (e) {
    logError("wallet diagnostics", e);
    set("dChain", no(friendly(e)));
  }
}

// ---------- Verify ----------
const verdictOf = (h) => (h.entryType === 2n ? "REVOKED" : h.replacesRecordId !== 0n ? "CORRECTED" : "VALID");
const effectiveHours = (h) => (h.entryType === 2n ? 0 : Number(h.hoursLogged));
const VERDICT = {
  VALID: { cls: "valid", icon: ICON.check, text: "Recorded by an accredited NGO and never changed." },
  CORRECTED: { cls: "corrected", icon: ICON.edit, text: "The issuing NGO appended a correction. The latest entry counts; the original stays on-chain." },
  REVOKED: { cls: "revoked", icon: ICON.x, text: "The issuing NGO revoked this record. It counts for 0 hours." },
  "NOT FOUND": { cls: "notfound", icon: ICON.search, text: "The recomputed fingerprint does not match any on-chain record." },
};

const SKELETON = `<div class="skeleton" aria-label="Checking the blockchain">
  <div class="status-line"><span class="spinner"></span>Recomputing the fingerprint and reading the contract…</div>
  <div class="sk big"></div><div class="sk" style="width:70%"></div><div class="sk" style="width:45%"></div></div>`;

// Every record for one student: its current head, full trail, event and issuing NGO. View calls only.
async function lookupStudent(id, salt) {
  const c = await reader();
  const fp = fingerprint(salt, id);
  // shortcut: first 50 events per student; page with offset if a student ever has more
  const [ids] = await c.getRecordsByCommitment(fp, 0, 50);
  const results = await Promise.all(ids.map(async (rid) => {
    const [head, trailIds] = await c.getEffectiveRecord(rid);
    const [trail, ev, org] = await Promise.all([
      Promise.all(trailIds.map((t) => c.getRecord(t))),
      c.events(head.eventId),
      c.coordinators(head.issuer),
    ]);
    return { head, trail, ev, org };
  }));
  return { fp, results };
}

async function verify() {
  const id = $("vId").value.trim(), salt = $("vSalt").value.trim(), claimed = $("vClaimed").value.trim();
  const msg = $("verifyMsg"), out = $("verifyOut"), btn = $("verifyBtn");
  msg.textContent = "";
  if (!id) return (msg.textContent = "Enter the student's fake ID.");
  if (badSalt(salt)) return (msg.textContent = SALT_HELP);
  btn.disabled = true;
  btn.classList.add("busy");
  out.innerHTML = SKELETON;
  try {
    const { fp, results } = await lookupStudent(id, salt);
    out.innerHTML = renderVerify(id, fp, results, claimed);
    fillTxLinks(out);
  } catch (e) {
    out.innerHTML = "";
    msg.textContent = friendly(e);
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

const computedHead = `<h4>${ICON.cpu}Computed on this page</h4>`;
const chainHead = `<h4>${ICON.chain}On the blockchain</h4>`;

function renderVerify(id, fp, results, claimed) {
  const fpRow = `<p>Fingerprint = keccak256(salt + "${esc(id)}")<code class="fp">${fp}</code></p>`;
  if (!results.length) {
    const v = VERDICT["NOT FOUND"];
    return `<article class="result notfound">
      <div class="result-head"><div class="result-icon">${v.icon}</div>
        <div><div class="result-verdict">NOT FOUND</div><p>${v.text}</p></div>
        <div class="result-hours"><strong>0</strong><span>verified hours</span></div></div>
      <div class="cols">
        <div class="col">${chainHead}<p>No record carries this fingerprint.</p></div>
        <div class="col">${computedHead}${fpRow}<p class="nomatch">Recomputed fingerprint does not match any on-chain record.</p>
          <p class="muted small">A wrong ID or salt, or a student with no recorded hours, gives this result.</p></div>
      </div></article>`;
  }
  const total = results.reduce((s, r) => s + effectiveHours(r.head), 0);
  let claim = "";
  if (claimed !== "") {
    claim = Number(claimed) === total
      ? `<div class="claim ok">${ICON.check}<div>CLAIM MATCHES<small>Student claims ${esc(claimed)}h; on-chain total is ${total}h.</small></div></div>`
      : `<div class="claim bad">${ICON.alert}<div><span class="claim-title">CLAIM MISMATCH: claimed ${esc(claimed)}h, on-chain ${total}h</span><small>The hours on the student's claim differ from what accredited NGOs recorded.</small></div></div>`;
  }
  const cards = results.map(({ head: h, trail, ev, org }) => {
    const name = verdictOf(h), v = VERDICT[name];
    const timeline = trail.map((r) => {
      const t = Number(r.entryType), reason = r.reasonCode !== ethers.ZeroHash ? ` · ${esc(reasonText(r.reasonCode))}` : "";
      return `<li class="t${t}"><strong>#${r.id} ${ENTRY_NICE[t]} · ${t === 2 ? "revoked" : r.hoursLogged + "h"}</strong>
        <span class="tl-sub">${when(r.recordedAt)}${reason}</span>
        <span class="tx" data-tx="${r.id}" data-block="${r.recordedBlock}">looking up tx…</span></li>`;
    }).join("");
    return `<article class="result ${v.cls}">
      <div class="result-head"><div class="result-icon">${v.icon}</div>
        <div><div class="result-verdict">${name}</div><p>${v.text}</p></div>
        <div class="result-hours"><strong>${effectiveHours(h)}</strong><span>verified hours</span></div></div>
      <div class="result-meta">
        <div><span>Issuing NGO</span><strong>${esc(org.orgLabel)} <span class="badge ${org.active ? "ok" : "bad"}">${org.active ? "active" : "revoked since"}</span></strong></div>
        <div><span>Volunteer event</span><strong>${esc(ev.eventCode)}</strong></div>
        <div><span>Last updated</span><strong>${when(h.recordedAt)}</strong></div>
      </div>
      <div class="cols">
        <div class="col">${chainHead}<dl class="kv">
          <dt>Current record</dt><dd>#${h.id} (${ENTRY[h.entryType]})</dd>
          <dt>Event</dt><dd>#${h.eventId} ${esc(ev.eventCode)}, max ${ev.maxDurationHours}h</dd>
          <dt>Issuer</dt><dd>${esc(org.orgLabel)}<br>${addrHtml(h.issuer)}</dd>
          <dt>Hours</dt><dd>${h.hoursLogged}</dd>
          <dt>Replaces</dt><dd>${h.replacesRecordId ? "#" + h.replacesRecordId : "nothing (original)"}</dd>
          <dt>Superseded by</dt><dd>${h.supersededBy ? "#" + h.supersededBy : "nothing (latest)"}</dd>
          <dt>Block</dt><dd>${h.recordedBlock}</dd>
          <dt>Contract</dt><dd>${links("address/" + C.address)}</dd>
        </dl></div>
        <div class="col">${computedHead}${fpRow}
          <p class="match">${ICON.check}Matches on-chain record #${trail[0].id}</p>
          <p><strong>Verdict: ${name}</strong>, because the latest entry ${name === "REVOKED" ? "is a revocation" : name === "CORRECTED" ? "replaces an earlier record" : "is the original and was never replaced"}.</p>
          <h5>Verification history</h5><ol class="timeline">${timeline}</ol>
        </div>
      </div>
      <details class="more"><summary>Raw on-chain fields</summary><div class="more-body"><dl class="kv">
        <dt>Commitment</dt><dd><code>${h.volunteerCommitment}</code></dd>
        <dt>Issuer</dt><dd><code>${h.issuer}</code></dd>
        <dt>Entry type</dt><dd>${ENTRY[h.entryType]} (${h.entryType})</dd>
        <dt>Recorded at</dt><dd>${h.recordedAt} (unix) · block ${h.recordedBlock}</dd>
        <dt>Reason code</dt><dd><code>${h.reasonCode}</code></dd>
      </dl></div></details>
    </article>`;
  }).join("");
  return claim + cards;
}

// The app's only log query: a single block (the record's stored block) to turn a record id into its tx hash.
async function fillTxLinks(root, compact) {
  const provider = (await reader()).runner;
  for (const el of root.querySelectorAll("[data-tx]")) {
    const block = Number(el.dataset.block);
    try {
      const [log] = await provider.getLogs({ address: C.address, fromBlock: block, toBlock: block, topics: [RECORD_TOPICS, ethers.toBeHex(BigInt(el.dataset.tx), 32)] });
      el.innerHTML = !log ? "" : compact && C.explorers.length ? `<a href="${C.explorers[0].url}/tx/${log.transactionHash}" target="_blank" rel="noopener">${short(log.transactionHash)}</a>` : compact ? `<code>${short(log.transactionHash)}</code>` : txLinks(log.transactionHash);
    } catch {
      el.textContent = "(tx lookup unavailable)";
    }
  }
}

function loadFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get("id") || !p.get("salt")) return false;
  if (p.get("view") === "impact") {
    $("iId").value = p.get("id");
    $("iSalt").value = p.get("salt");
    showPage("impact");
    impact();
    return true;
  }
  $("vId").value = p.get("id");
  $("vSalt").value = p.get("salt");
  $("vClaimed").value = p.get("claimed") ?? "";
  showPage("verify");
  verify();
  return true;
}

// ---------- My Impact (volunteer dashboard) ----------
// Milestones are computed here from on-chain hours. No badge contract exists, so nothing is "minted".
const word = (n, one, many) => (n === 1 ? one : many);
const MILESTONES = [
  [5, "First Spark"], [10, "Committed"], [25, "Community Builder"], [50, "Impact Guardian"],
  [100, "Centurion"], [250, "Changemaker"], [500, "Luminary"],
];

function milestoneHtml(total) {
  const next = MILESTONES.find(([h]) => total < h);
  const prev = [...MILESTONES].reverse().find(([h]) => total >= h);
  if (!next) return `<div class="milestone done"><strong>All milestones reached: ${esc(prev[1])}</strong></div>`;
  const pct = Math.round((total / next[0]) * 100);
  return `<div class="milestone">
    <div class="ms-top"><span>Next milestone: <strong>${next[1]}</strong> at ${next[0]}h</span><span class="mono">${total} / ${next[0]}h</span></div>
    <div class="ms-bar" role="progressbar" aria-label="Progress to ${next[1]}" aria-valuemin="0" aria-valuemax="${next[0]}" aria-valuenow="${total}"><span style="--p:${pct}%"></span></div>
    <p class="ms-note">${next[0] - total}h to go${prev ? ` · reached so far: <strong>${esc(prev[1])}</strong>` : ""}. Milestones are calculated from your on-chain hours; badges are not minted on-chain yet.</p>
  </div>`;
}

async function impact() {
  const id = $("iId").value.trim(), salt = $("iSalt").value.trim();
  const msg = $("impactMsg"), out = $("impactOut"), btn = $("impactBtn");
  msg.textContent = "";
  if (!id) return (msg.textContent = "Enter your Student ID from your receipt.");
  if (badSalt(salt)) return (msg.textContent = SALT_HELP + " You'll find it on your receipt.");
  btn.disabled = true;
  btn.classList.add("busy");
  out.innerHTML = SKELETON;
  try {
    const { results } = await lookupStudent(id, salt);
    out.innerHTML = renderImpact(id, results);
    const n = out.querySelector("[data-count]");
    if (n) countUp(n, Number(n.dataset.count));
    fillTxLinks(out, true);
  } catch (e) {
    out.innerHTML = "";
    msg.textContent = friendly(e);
  } finally {
    btn.disabled = false;
    btn.classList.remove("busy");
  }
}

function renderImpact(id, results) {
  if (!results.length) return `<div class="empty"><h3>No verified hours found for ${esc(id)}</h3>
    <p>Check the Student ID and salt on your receipt. If they're right, no accredited NGO has recorded hours for you yet.</p></div>`;
  const total = results.reduce((s, r) => s + effectiveHours(r.head), 0);
  const ngos = new Set(results.map((r) => r.head.issuer.toLowerCase())).size;
  const events = new Set(results.map((r) => r.head.eventId)).size;
  const rows = results.map(({ head: h, ev, org }) => {
    const name = verdictOf(h);
    return `<li class="ir">
      <span class="vd ${VERDICT[name].cls}" aria-hidden="true"></span>
      <div class="ir-main"><strong>${esc(ev.eventCode)}</strong><span>${esc(org.orgLabel)} · ${when(h.recordedAt)}</span></div>
      <span class="badge ${name === "VALID" ? "ok" : name === "CORRECTED" ? "warn" : "bad"}">${name}</span>
      <strong class="ir-h">${effectiveHours(h)}h</strong>
      <span class="ir-proof">Proof: <span data-tx="${h.id}" data-block="${h.recordedBlock}">looking up…</span></span>
    </li>`;
  }).join("");
  return `<div class="impact-hero">
      <div class="ih-total"><span>Verified hours</span><strong data-count="${total}">${total}</strong><small>for ${esc(id)}, latest entries only; revoked hours count as 0</small></div>
      <div class="ih-stats">
        <div><strong>${results.length}</strong><span>${word(results.length, "record", "records")}</span></div>
        <div><strong>${ngos}</strong><span>${word(ngos, "NGO served", "NGOs served")}</span></div>
        <div><strong>${events}</strong><span>${word(events, "event", "events")}</span></div>
      </div>
      ${milestoneHtml(total)}
    </div>
    <div class="panel"><div class="panel-head"><h3>Your verified records</h3><button type="button" class="btn btn-ghost sm" data-verify-from-impact>Open full audit view</button></div>
      <ul class="impact-list">${rows}</ul>
      <p class="small muted">Every row is read live from contract ${short(C.address)}. Proof links open the exact transaction on the block explorer.</p></div>`;
}

// ---------- Security demo ----------
const demoCoordinator = async (c) => (await c.events(C.demoEventId)).coordinator;
const refusals = {
  wrongWallet: async () => ({ fn: "recordVolunteerHours", args: [C.demoEventId, demoFp("S-004"), 4], from: ethers.Wallet.createRandom().address }),
  duplicate: async (c) => ({ fn: "recordVolunteerHours", args: [C.demoEventId, demoFp("S-001"), 4], from: await demoCoordinator(c) }),
  overHours: async (c) => ({ fn: "recordVolunteerHours", args: [C.demoEventId, demoFp("S-004"), 10], from: await demoCoordinator(c) }),
  nonIssuer: async () => ({ fn: "appendCorrection", args: [1, 5, bytes32("TYPO_FIX")], from: C.secondCoordinator }),
};
const fmtArg = (a) => (typeof a === "string" && a.startsWith("0x") ? short(a) : String(a));

async function runRefusal(btn) {
  const card = btn.closest(".scenario"), out = card.querySelector(".sc-result"), name = btn.dataset.refusal;
  const btns = document.querySelectorAll("[data-refusal]");
  const add = (html) => out.insertAdjacentHTML("beforeend", html);
  btns.forEach((b) => (b.disabled = true));
  btn.classList.add("busy");
  card.classList.remove("refused");
  out.innerHTML = `<div class="status-line"><span class="spinner"></span>Asking the contract…</div>`;
  try {
    const c = await reader();
    const s = await refusals[name](c);
    try {
      await c[s.fn].staticCall(...s.args, { from: s.from });
      out.innerHTML = `<div class="verdict-line unexpected">${ICON.alert}Unexpected: the contract accepted this call.</div>`;
    } catch (e) {
      const err = decodeRevert(e);
      const matches = err?.name === card.dataset.expect;
      card.classList.add("refused");
      out.innerHTML = `<div class="verdict-line">${ICON.x}Actual: refused${matches ? " · matches expected" : ""}</div>
        <div class="reason">${esc(friendly(e))}</div>
        <div class="evidence"><b>Evidence:</b> read-only <code>eth_call</code> of <code>${s.fn}</code> as ${short(s.from)} on contract ${short(C.address)}.
        ${err ? `Decoded revert: <code>${err.name}(${[...err.args].map(fmtArg).join(", ")})</code>.` : ""} Nothing was sent.</div>`;
      toast(`${card.querySelector("h3").textContent}: refused by the contract`, "ok");
    }
    if (!$("broadcast").checked) return;
    const w = await walletContract();
    const me = await w.runner.getAddress();
    try {
      await w[s.fn].staticCall(...s.args);
      return add(`<div class="evidence"><b>Not broadcast:</b> your connected wallet ${short(me)} is allowed to do this, so it would really write a record. Switch MetaMask to a wallet that is not a coordinator.</div>`);
    } catch {}
    const tx = await w[s.fn](...s.args, { gasLimit: 200000n }); // fixed gas skips estimation, so the reverting tx still gets mined
    add(`<div class="evidence" data-bcast><b>Broadcast</b> from ${short(me)}: ${txLinks(tx.hash)}. Waiting…</div>`);
    try {
      await tx.wait(1);
      add(`<div class="verdict-line unexpected">${ICON.alert}Unexpected: the transaction succeeded.</div>`);
    } catch {
      out.querySelector("[data-bcast]").innerHTML = `<b>On-chain proof:</b> the transaction was mined and reverted, as expected. ${txLinks(tx.hash)}`;
    }
  } catch (e) {
    add(`<div class="reason">${esc(friendly(e))}</div>`);
  } finally {
    btns.forEach((b) => (b.disabled = false));
    btn.classList.remove("busy");
  }
}

// ---------- Navigation ----------
const navItems = [...document.querySelectorAll(".nav-item")];
const PAGE_LOAD = { overview: () => loadOverview(), admin: loadAdmin, network: loadNetwork };

function showPage(name) {
  document.querySelectorAll(".page").forEach((s) => (s.hidden = s.id !== name));
  navItems.forEach((b) => (b.dataset.page === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $("pageTitle").textContent = $(name).dataset.title;
  document.title = `${$(name).dataset.title} · ProofHours`;
  setNav(false);
  window.scrollTo({ top: 0 });
  PAGE_LOAD[name]?.();
}

function setNav(open) {
  document.body.classList.toggle("nav-open", open);
  $("menuBtn").setAttribute("aria-expanded", open);
}

navItems.forEach((b) => (b.onclick = () => { showPage(b.dataset.page); $("main").focus({ preventScroll: true }); }));
document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => showPage(b.dataset.goto)));
$("menuBtn").onclick = () => setNav(!document.body.classList.contains("nav-open"));
$("scrim").onclick = () => setNav(false);
document.addEventListener("keydown", (e) => e.key === "Escape" && setNav(false));

// ---------- Wiring ----------
$("verifyForm").onsubmit = (e) => { e.preventDefault(); verify(); };
document.querySelectorAll("[data-impact-demo]").forEach((b) => (b.onclick = () => {
  const v = DEMO_VOLUNTEERS.find((d) => d.id === b.dataset.impactDemo);
  $("iId").value = v.id;
  $("iSalt").value = v.salt;
  impact();
}));
$("impactForm").onsubmit = (e) => { e.preventDefault(); impact(); };
$("impactOut").onclick = (e) => {
  if (!e.target.closest("[data-verify-from-impact]")) return;
  $("vId").value = $("iId").value;
  $("vSalt").value = $("iSalt").value;
  $("vClaimed").value = "";
  showPage("verify");
  verify();
};

document.querySelectorAll("[data-demo]").forEach((b) => (b.onclick = () => {
  const v = DEMO_VOLUNTEERS.find((d) => d.id === b.dataset.demo);
  $("vId").value = v.id;
  $("vSalt").value = v.salt;
  verify();
}));

$("connectBtn").onclick = async () => {
  if (!window.ethereum) return toast("No wallet found. Install MetaMask to write records. Verifying works without one.", "err");
  try { await ethereum.request({ method: "eth_requestAccounts" }); } catch (e) { return toast(friendly(e), "err"); }
  await refreshRole();
  if (account) toast(`Wallet connected: ${$("rolePill").textContent}`, "ok");
};

document.querySelectorAll("[data-switch]").forEach((b) => (b.onclick = async () => {
  if (!window.ethereum) return toast("No wallet found. Install MetaMask first.", "err");
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: C.chainIdHex }] });
  } catch (e) {
    if (e.code === 4001) return;
    try {
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: C.chainIdHex, chainName: C.netName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [C.rpcs[0]], ...(C.explorers.length && { blockExplorerUrls: [C.explorers[0].url] }) }],
      });
    } catch (e2) { return toast(friendly(e2), "err"); }
  }
  await refreshRole();
  if (!$("network").hidden) loadNetwork();
}));

$("eventForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "createEvent", () => [$("eCode").value.trim(), $("eMax").value]); };

$("rPick").innerHTML += DEMO_VOLUNTEERS.slice(0, 5).map((v) => `<option value="${v.id}">Demo volunteer ${v.id}</option>`).join("");
$("rPick").onchange = () => {
  const pick = $("rPick").value;
  if (pick === "new") {
    $("rId").value = "";
    $("rSalt").value = ethers.hexlify(crypto.getRandomValues(new Uint8Array(32)));
    $("rId").focus();
  } else if (pick) {
    const v = DEMO_VOLUNTEERS.find((d) => d.id === pick);
    $("rId").value = v.id;
    $("rSalt").value = v.salt;
  }
};
$("myEvents").onclick = (e) => {
  const id = e.target.closest("[data-use-event]")?.dataset.useEvent;
  if (!id) return;
  $("rEvent").value = id;
  $("recordForm").scrollIntoView({ behavior: REDUCED_MOTION ? "auto" : "smooth", block: "center" });
  $("rPick").focus({ preventScroll: true });
};

$("recordForm").onsubmit = async (e) => {
  e.preventDefault();
  const id = $("rId").value.trim(), salt = $("rSalt").value.trim(), hours = $("rHours").value;
  $("receipt").innerHTML = "";
  const r = await send(e.target, "recordVolunteerHours", () => [$("rEvent").value, fingerprint(needSalt(salt), id), hours]);
  if (!r) return;
  const log = r.logs.map((l) => iface.parseLog(l)).find((l) => l?.name === "HoursRecorded");
  const link = location.href.split("#")[0] + `#id=${encodeURIComponent(id)}&salt=${salt}`;
  $("receipt").innerHTML = `<div class="receipt">
    <h4>${ICON.check}Receipt: record #${log.args.recordId} · ${esc(id)} · ${hours}h</h4>
    <label class="field"><span>Verify link</span><div class="copy-row"><input id="receiptLink" readonly value="${esc(link)}"><button type="button" id="copyBtn" class="btn btn-ghost">Copy link</button></div></label>
    <p class="warn-note">${ICON.alert}<span>This link contains the volunteer's secret salt. Give it only to the student and the auditor: anyone holding the salt can look up this student's records.</span></p>
  </div>`;
  $("copyBtn").onclick = async () => {
    $("receiptLink").select();
    try { await navigator.clipboard.writeText(link); $("copyBtn").textContent = "Copied ✓"; toast("Verify link copied", "ok"); } catch { $("copyBtn").textContent = "Press Ctrl+C to copy"; }
  };
};

$("correctForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "appendCorrection", () => [$("cId").value, $("cHours").value, bytes32($("cReason").value.trim())]); };
$("revokeForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "appendRevocation", () => [$("xId").value, bytes32($("xReason").value.trim())]); };
$("regForm").onsubmit = async (e) => { e.preventDefault(); if (await send(e.target, "registerCoordinator", () => [needAddress($("aAddr").value.trim()), $("aLabel").value.trim()])) loadAdmin(); };
$("revForm").onsubmit = async (e) => { e.preventDefault(); if (await send(e.target, "revokeCoordinator", () => [needAddress($("aRevAddr").value.trim())])) loadAdmin(); };
$("lookupForm").onsubmit = async (e) => {
  e.preventDefault();
  const out = $("lookupOut"), a = $("lookupAddr").value.trim();
  if (!ethers.isAddress(a)) { out.className = "msg err"; return (out.textContent = "That is not a valid wallet address (0x followed by 40 hex characters)."); }
  try {
    const c = await reader();
    const [[active, label], admin] = await Promise.all([c.coordinators(a), c.admin()]);
    const [cls, status] = a.toLowerCase() === admin.toLowerCase() ? ["warn", "University admin"]
      : active ? ["ok", "Authorized coordinator"] : label ? ["bad", "Revoked coordinator"] : ["neutral", "Never registered"];
    out.className = "msg";
    out.innerHTML = `<span class="badge ${cls}">${status}</span> ${label ? esc(label) + " · " : ""}<code>${short(a)}</code>`;
  } catch (err) { out.className = "msg err"; out.textContent = friendly(err); }
};
document.querySelectorAll("[data-refusal]").forEach((b) => (b.onclick = () => runRefusal(b)));
$("ovRefresh").onclick = () => loadOverview(true);
$("netRefresh").onclick = loadNetwork;

if (window.ethereum) {
  ethereum.on?.("accountsChanged", refreshRole);
  ethereum.on?.("chainChanged", refreshRole);
}
window.addEventListener("hashchange", loadFromHash);
if (LOCAL) {
  document.querySelectorAll("[data-net]").forEach((e) => (e.textContent = C.netName));
  document.querySelectorAll("[data-chain]").forEach((e) => (e.textContent = C.chainId));
}
renderWallet();
refreshRole();
if (!loadFromHash()) showPage("overview");
