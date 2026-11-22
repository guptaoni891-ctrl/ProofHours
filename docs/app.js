// Reads go through a read-only RPC (never a wallet). Writes go through MetaMask.
const C = window.CONFIG;
const $ = (id) => document.getElementById(id);
const iface = new ethers.Interface(C.abi);
const ENTRY = ["ORIGINAL", "CORRECTION", "REVOCATION"];
const RECORD_TOPICS = ["HoursRecorded", "CorrectionAppended", "RevocationAppended"].map((n) => iface.getEvent(n).topicHash);

const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); // org labels and event codes are user-written
const fingerprint = (salt, id) => ethers.solidityPackedKeccak256(["bytes32", "string"], [salt, id]);
const reasonText = (b) => { try { return ethers.decodeBytes32String(b); } catch { return b; } };
const links = (path) => C.explorers.map((e) => `<a href="${e.url}/${path}" target="_blank" rel="noopener">${e.name}</a>`).join(" · ");
const txLinks = (h) => `tx <code>${short(h)}</code> (${links("tx/" + h)})`;
const demoFp = (id) => { const v = DEMO_VOLUNTEERS.find((d) => d.id === id); return fingerprint(v.salt, v.id); };
const badSalt = (s) => !ethers.isHexString(s, 32);
const SALT_HELP = "The salt must be 0x followed by 64 hex characters.";

// ---------- Read-only provider: try each RPC in order ----------
const rpcOverride = new URLSearchParams(location.search).get("rpc");
let readerPromise;
const reader = () => (readerPromise ??= connectReader());

async function connectReader() {
  for (const url of rpcOverride ? [rpcOverride] : C.rpcs) {
    try {
      // batchMaxCount 1: some free RPCs reject JSON-RPC batches
      const p = new ethers.JsonRpcProvider(url, C.chainId, { staticNetwork: true, batchMaxCount: 1 });
      await p.getBlockNumber();
      $("rpcInfo").textContent = "Reading from " + new URL(url).host;
      return new ethers.Contract(C.address, C.abi, p);
    } catch (e) {
      console.warn("RPC failed, trying next:", url, e);
    }
  }
  readerPromise = null; // let the next click retry
  throw new Error("Could not reach the Base Sepolia network. Check your internet connection and try again.");
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

function friendly(e) {
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || e?.info?.error?.code === 4001) return "You cancelled the request in your wallet. Nothing was sent.";
  if (e?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(e?.message)) return "This wallet has no Base Sepolia test ETH for the fee. Get some from a Base Sepolia faucet, then try again.";
  let err = e?.revert;
  for (const d of [e?.data, e?.info?.error?.data, e?.info?.error?.data?.data, e?.error?.data]) {
    if (err) break;
    if (typeof d === "string" && d.startsWith("0x")) try { err = iface.parseError(d); } catch {}
  }
  if (err) return "Refused by the contract: " + explain(err.name, err.args);
  if (e?.code === "CALL_EXCEPTION") return "Refused by the contract (no reason was returned). Check you are using the right wallet and record number.";
  if (e?.code === "BAD_DATA") return "No contract answered at the configured address on this network. Check the address in config.js.";
  if (e?.code === "NETWORK_ERROR") return 'Your wallet changed network. Click "Switch to Base Sepolia" and try again.';
  return e?.shortMessage || e?.message || String(e);
}

// ---------- Wallet ----------
async function walletContract() {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask to write records. (Verifying needs no wallet.)");
  const bp = new ethers.BrowserProvider(window.ethereum); // fresh each time so a network switch never breaks it
  const signer = await bp.getSigner();
  if ((await bp.getNetwork()).chainId !== BigInt(C.chainId)) throw new Error('Your wallet is on the wrong network. Click "Switch to Base Sepolia" and try again.');
  return new ethers.Contract(C.address, C.abi, signer);
}

function setPill(text, cls) {
  $("rolePill").textContent = text;
  $("rolePill").className = "pill " + cls;
}

async function refreshRole() {
  if (!window.ethereum) return setPill("NO WALLET", "none");
  try {
    const [acct] = await ethereum.request({ method: "eth_accounts" });
    if (!acct) return setPill("NO WALLET", "none");
    const wrongNet = (await ethereum.request({ method: "eth_chainId" })).toLowerCase() !== C.chainIdHex;
    const c = await reader();
    let role = "NOT AUTHORIZED", cls = "none";
    if (acct.toLowerCase() === (await c.admin()).toLowerCase()) [role, cls] = ["ADMIN", "admin"];
    else {
      const [active, label] = await c.coordinators(acct);
      if (active) [role, cls] = ["COORDINATOR: " + label, "coord"];
    }
    setPill(`${role} · ${short(acct)}${wrongNet ? " · WRONG NETWORK" : ""}`, wrongNet ? "none" : cls);
    loadMyEvents(acct);
  } catch (e) {
    console.warn(e);
    setPill(friendly(e), "none");
  }
}

async function loadMyEvents(acct) {
  const c = await reader();
  const n = Number(await c.eventCount());
  // shortcut: reads every event one by one; fine for tens of events, add a per-coordinator index in the contract if it grows
  const evs = await Promise.all(Array.from({ length: n }, (_, i) => c.events(i + 1)));
  const mine = evs.map((e, i) => [i + 1, e]).filter(([, e]) => e.coordinator.toLowerCase() === acct.toLowerCase());
  $("rEvent").innerHTML = mine.length
    ? mine.map(([id, e]) => `<option value="${id}">#${id} ${esc(e.eventCode)} (max ${e.maxDurationHours}h)</option>`).join("")
    : `<option value="">You have no events yet. Create one above.</option>`;
}

// Sends a write, keeps the button disabled until 1 confirmation, shows the tx hash. Returns the receipt or undefined.
async function send(form, fn, argsFn) {
  const btn = form.querySelector("button[type=submit]"), msg = form.querySelector(".msg");
  btn.disabled = true;
  msg.className = "msg";
  msg.textContent = "Confirm in your wallet…";
  try {
    const args = argsFn();
    const c = await walletContract();
    const tx = await c[fn](...args);
    msg.innerHTML = `Sent, waiting for confirmation… ${txLinks(tx.hash)}`;
    const receipt = await tx.wait(1);
    msg.className = "msg ok";
    msg.innerHTML = `Confirmed. ${txLinks(tx.hash)}`;
    refreshRole();
    return receipt;
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = friendly(e);
  } finally {
    btn.disabled = false;
  }
}

const needAddress = (a) => { if (!ethers.isAddress(a)) throw new Error("That is not a valid wallet address (0x followed by 40 hex characters)."); return a; };
const needSalt = (s) => { if (badSalt(s)) throw new Error(SALT_HELP); return s; };
const bytes32 = (s) => { if (new TextEncoder().encode(s).length > 31) throw new Error("Reason codes can be at most 31 characters."); return ethers.encodeBytes32String(s); };

// ---------- Verify ----------
const verdictOf = (h) => (h.entryType === 2n ? "REVOKED" : h.replacesRecordId !== 0n ? "CORRECTED" : "VALID");
const effectiveHours = (h) => (h.entryType === 2n ? 0 : Number(h.hoursLogged));

async function verify() {
  const id = $("vId").value.trim(), salt = $("vSalt").value.trim(), claimed = $("vClaimed").value.trim();
  const msg = $("verifyMsg"), out = $("verifyOut"), btn = $("verifyBtn");
  out.innerHTML = "";
  if (!id) return (msg.textContent = "Enter the student's fake ID.");
  if (badSalt(salt)) return (msg.textContent = SALT_HELP);
  btn.disabled = true;
  msg.textContent = "Checking the blockchain…";
  try {
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
    msg.textContent = "";
    out.innerHTML = renderVerify(id, fp, results, claimed);
    fillTxLinks(out);
  } catch (e) {
    msg.textContent = friendly(e);
  } finally {
    btn.disabled = false;
  }
}

function renderVerify(id, fp, results, claimed) {
  const fpRow = `<p><strong>Fingerprint</strong> = keccak256(salt + "${esc(id)}")<br><code class="wrap">${fp}</code></p>`;
  if (!results.length) {
    return `<div class="verdict notfound"><strong>NOT FOUND</strong><span>The recomputed fingerprint does not match any on-chain record.</span></div>
      <div class="cols">
        <div class="col"><h3>On the blockchain</h3><p>No record carries this fingerprint.</p></div>
        <div class="col"><h3>Computed on this page</h3>${fpRow}<p>A wrong ID or salt, or a student with no recorded hours, gives this result.</p></div>
      </div>`;
  }
  const total = results.reduce((s, r) => s + effectiveHours(r.head), 0);
  let claim = "";
  if (claimed !== "") {
    claim = Number(claimed) === total
      ? `<div class="claim ok">CLAIM MATCHES: claimed ${esc(claimed)}h, on-chain ${total}h</div>`
      : `<div class="claim bad">CLAIM MISMATCH: claimed ${esc(claimed)}h, on-chain ${total}h</div>`;
  }
  const cards = results.map(({ head: h, trail, ev, org }) => {
    const v = verdictOf(h);
    const trailHtml = trail.map((r) => `<li>#${r.id} · ${r.entryType === 2n ? "revoked" : r.hoursLogged + "h"} · ${ENTRY[r.entryType]}${r.reasonCode !== ethers.ZeroHash ? " (" + esc(reasonText(r.reasonCode)) + ")" : ""}
        <span class="tx" data-tx="${r.id}" data-block="${r.recordedBlock}">looking up tx…</span></li>`).join("");
    return `<article class="record">
      <div class="verdict ${v.toLowerCase()}"><strong>${v}${v === "REVOKED" ? "" : ` (${h.hoursLogged}h)`}</strong>
        <span>${esc(ev.eventCode)} · signed by ${esc(org.orgLabel)}</span></div>
      <div class="cols">
        <div class="col"><h3>On the blockchain</h3><dl>
          <dt>Current record</dt><dd>#${h.id} (${ENTRY[h.entryType]})</dd>
          <dt>Event</dt><dd>#${h.eventId} ${esc(ev.eventCode)}, max ${ev.maxDurationHours}h</dd>
          <dt>Issuer</dt><dd>${esc(org.orgLabel)} · <code>${short(h.issuer)}</code> (${links("address/" + h.issuer)}) · ${org.active ? "active" : "coordinator since revoked"}</dd>
          <dt>Fingerprint</dt><dd><code class="wrap">${h.volunteerCommitment}</code></dd>
          <dt>Hours</dt><dd>${h.hoursLogged}</dd>
          <dt>Replaces</dt><dd>${h.replacesRecordId ? "#" + h.replacesRecordId : "nothing (original)"}</dd>
          <dt>Superseded by</dt><dd>${h.supersededBy ? "#" + h.supersededBy : "nothing (latest)"}</dd>
          <dt>Recorded</dt><dd>${new Date(Number(h.recordedAt) * 1000).toLocaleString()} · block ${h.recordedBlock}</dd>
          <dt>Contract</dt><dd>${links("address/" + C.address)}</dd>
        </dl></div>
        <div class="col"><h3>Computed on this page</h3>
          ${fpRow}
          <p>✓ Matches on-chain record #${trail[0].id}.</p>
          <p><strong>Verdict: ${v}</strong>, because the latest entry ${v === "REVOKED" ? "is a revocation" : v === "CORRECTED" ? "replaces an earlier record" : "is the original and was never replaced"}.</p>
          <p><strong>Trail</strong> (oldest first):</p><ol class="trail">${trailHtml}</ol>
        </div>
      </div></article>`;
  }).join("");
  return claim + cards;
}

// The app's only log query: a single block (the record's stored block) to turn a record id into its tx hash.
async function fillTxLinks(root) {
  const provider = (await reader()).runner;
  for (const el of root.querySelectorAll("[data-tx]")) {
    const block = Number(el.dataset.block);
    try {
      const [log] = await provider.getLogs({ address: C.address, fromBlock: block, toBlock: block, topics: [RECORD_TOPICS, ethers.toBeHex(BigInt(el.dataset.tx), 32)] });
      el.innerHTML = log ? txLinks(log.transactionHash) : "";
    } catch {
      el.textContent = "(tx lookup unavailable)";
    }
  }
}

function loadFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.get("id") || !p.get("salt")) return;
  $("vId").value = p.get("id");
  $("vSalt").value = p.get("salt");
  $("vClaimed").value = p.get("claimed") ?? "";
  showTab($("tab-verify"));
  verify();
}

// ---------- Demo console ----------
const demoCoordinator = async (c) => (await c.events(C.demoEventId)).coordinator;
const refusals = {
  wrongWallet: async () => ({ fn: "recordVolunteerHours", args: [C.demoEventId, demoFp("S-004"), 4], from: ethers.Wallet.createRandom().address }),
  duplicate: async (c) => ({ fn: "recordVolunteerHours", args: [C.demoEventId, demoFp("S-001"), 4], from: await demoCoordinator(c) }),
  overHours: async (c) => ({ fn: "recordVolunteerHours", args: [C.demoEventId, demoFp("S-004"), 10], from: await demoCoordinator(c) }),
  nonIssuer: async () => ({ fn: "appendCorrection", args: [1, 5, bytes32("TYPO_FIX")], from: C.secondCoordinator }),
};

async function runRefusal(name) {
  const out = $("demoOut"), btns = document.querySelectorAll("[data-refusal]");
  const add = (html) => (out.innerHTML += `<p>${html}</p>`);
  btns.forEach((b) => (b.disabled = true));
  out.className = "msg";
  out.innerHTML = "";
  try {
    const c = await reader();
    const s = await refusals[name](c);
    try {
      await c[s.fn].staticCall(...s.args, { from: s.from });
      add("Unexpected: the contract accepted this call.");
    } catch (e) {
      out.className = "msg err";
      add(`<strong>${esc(friendly(e))}</strong><br><small>Tried as ${short(s.from)} with a read-only call. Nothing was sent.</small>`);
    }
    if (!$("broadcast").checked) return;
    const w = await walletContract();
    const me = await w.runner.getAddress();
    try {
      await w[s.fn].staticCall(...s.args);
      return add(`Not broadcast: your connected wallet ${short(me)} is allowed to do this, so it would really write a record. Switch MetaMask to a wallet that is not a coordinator.`);
    } catch {}
    const tx = await w[s.fn](...s.args, { gasLimit: 200000n }); // fixed gas skips estimation, so the reverting tx still gets mined
    add(`Broadcast from ${short(me)}: ${txLinks(tx.hash)}. Waiting…`);
    try {
      await tx.wait(1);
      add("Unexpected: the transaction succeeded.");
    } catch {
      add(`Reverted on-chain as expected. Open it on the explorer: ${txLinks(tx.hash)}`);
    }
  } catch (e) {
    add(esc(friendly(e)));
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

// ---------- Wiring ----------
const tabs = [...document.querySelectorAll("[role=tab]")];
function showTab(tab) {
  for (const t of tabs) {
    t.setAttribute("aria-selected", t === tab);
    $(t.getAttribute("aria-controls")).hidden = t !== tab;
  }
}
tabs.forEach((t) => (t.onclick = () => showTab(t)));

$("verifyForm").onsubmit = (e) => { e.preventDefault(); verify(); };
document.querySelectorAll("[data-demo]").forEach((b) => (b.onclick = () => {
  const v = DEMO_VOLUNTEERS.find((d) => d.id === b.dataset.demo);
  $("vId").value = v.id;
  $("vSalt").value = v.salt;
  verify();
}));

$("connectBtn").onclick = async () => {
  if (!window.ethereum) return setPill("NO WALLET: install MetaMask to write (verify works without one)", "none");
  try { await ethereum.request({ method: "eth_requestAccounts" }); } catch (e) { return setPill(friendly(e), "none"); }
  refreshRole();
};

$("switchBtn").onclick = async () => {
  if (!window.ethereum) return setPill("NO WALLET: install MetaMask first", "none");
  try {
    await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: C.chainIdHex }] });
  } catch (e) {
    if (e.code === 4001) return;
    try {
      await ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: C.chainIdHex, chainName: "Base Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [C.rpcs[0]], blockExplorerUrls: [C.explorers[0].url] }],
      });
    } catch (e2) { return setPill(friendly(e2), "none"); }
  }
  refreshRole();
};

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

$("recordForm").onsubmit = async (e) => {
  e.preventDefault();
  const id = $("rId").value.trim(), salt = $("rSalt").value.trim(), hours = $("rHours").value;
  $("receipt").innerHTML = "";
  const r = await send(e.target, "recordVolunteerHours", () => [$("rEvent").value, fingerprint(needSalt(salt), id), hours]);
  if (!r) return;
  const log = r.logs.map((l) => iface.parseLog(l)).find((l) => l?.name === "HoursRecorded");
  const link = location.href.split("#")[0] + `#id=${encodeURIComponent(id)}&salt=${salt}`;
  $("receipt").innerHTML = `<div class="receipt">
    <h4>Receipt: record #${log.args.recordId} · ${esc(id)} · ${hours}h</h4>
    <label>Verify link <input id="receiptLink" readonly value="${esc(link)}"></label>
    <button type="button" id="copyBtn">Copy link</button>
    <p class="warn">⚠ This link contains the volunteer's secret salt. Give it only to the student and the auditor: anyone holding the salt can look up this student's records.</p>
  </div>`;
  $("copyBtn").onclick = async () => {
    $("receiptLink").select();
    try { await navigator.clipboard.writeText(link); $("copyBtn").textContent = "Copied ✓"; } catch { $("copyBtn").textContent = "Press Ctrl+C to copy"; }
  };
};

$("correctForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "appendCorrection", () => [$("cId").value, $("cHours").value, bytes32($("cReason").value.trim())]); };
$("revokeForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "appendRevocation", () => [$("xId").value, bytes32($("xReason").value.trim())]); };
$("regForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "registerCoordinator", () => [needAddress($("aAddr").value.trim()), $("aLabel").value.trim()]); };
$("revForm").onsubmit = (e) => { e.preventDefault(); send(e.target, "revokeCoordinator", () => [needAddress($("aRevAddr").value.trim())]); };
document.querySelectorAll("[data-refusal]").forEach((b) => (b.onclick = () => runRefusal(b.dataset.refusal)));

$("contractLinks").innerHTML = `Contract <code>${short(C.address)}</code> (${links("address/" + C.address)})`;
if (window.ethereum) {
  ethereum.on?.("accountsChanged", refreshRole);
  ethereum.on?.("chainChanged", refreshRole);
}
window.addEventListener("hashchange", loadFromHash);
refreshRole();
loadFromHash();
