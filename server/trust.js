// Stage 5 routes mounted into the attendance service (they share its wallet sign-in and database):
//  - audit cases: auditors record reviews of alerts and samples; outcomes are human decisions, and "NGO suspended" is
//    only accepted once the chain shows the suspension (the auditor's own wallet sends suspendOrg).
//  - Open Badges 3.0 credentials: W3C Verifiable Credentials for soulbound badges, signed as JWTs (EdDSA, did:key
//    issuer), with a Bitstring Status List that marks a credential revoked once its badge is no longer held.
//  - profile vault: optional private profile fields, encrypted per volunteer (AES-256-GCM, per-user data key wrapped by
//    a master key and stored in a separate key database), per-field visibility, and erasure by destroying the key.
"use strict";
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { ethers } = require("ethers");

const OB3_CONTEXT = "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json";
const VC2_CONTEXT = "https://www.w3.org/ns/credentials/v2";
const CATS = ["Environmental", "Education", "Healthcare", "Emergency response", "Inclusion"];
const OUTCOMES = ["dismissed", "referred-to-governance", "org-suspended"];
const FIELDS = { displayName: 60, school: 80, bio: 280 };
const VISIBILITY = ["private", "link", "public"];
const STATUS_BITS = 131072; // 16 KB, the Bitstring Status List minimum
const STATUS_TTL = 60; // seconds the public status list may be stale

const b64u = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
const kdf = (secret, info) => Buffer.from(crypto.hkdfSync("sha256", secret, "proofhours", info, 32));

// Issuer key derived from the service secret. shortcut: derived locally; in production the key lives in a KMS/HSM.
function issuerKey(secret) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), kdf(secret, "credential-issuer-ed25519")]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  const did = "did:key:z" + ethers.encodeBase58(Buffer.concat([Buffer.from([0xed, 0x01]), pub]));
  return { privateKey, did, kid: `${did}#${did.slice(8)}` };
}
// Public key from a did:key (Ed25519 only).
function didKeyPublic(did) {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(did ?? "");
  if (!m) return null;
  const bytes = ethers.getBytes(ethers.toBeHex(ethers.decodeBase58(m[1])));
  if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
  return crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bytes.slice(2)).toString("base64url") }, format: "jwk" });
}
function signJwt(key, payload) {
  const head = b64u({ alg: "EdDSA", typ: "JWT", kid: key.kid }), body = b64u(payload);
  return `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
}
function readJwt(jwt) {
  const parts = String(jwt ?? "").trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url")), payload = JSON.parse(Buffer.from(parts[1], "base64url"));
    const pub = didKeyPublic(String(header.kid ?? "").split("#")[0]);
    const signatureOk = !!pub && crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], "base64url"));
    return { header, payload, signatureOk };
  } catch { return null; }
}

// The Open Badges 3.0 fields a credential must carry (checked locally; the 1EdTech validator is an external service).
function ob3Problems(vc) {
  const p = [], has = (arr, v) => Array.isArray(arr) && arr.includes(v);
  if (!has(vc?.["@context"], VC2_CONTEXT) || !has(vc?.["@context"], OB3_CONTEXT)) p.push("@context must include the VC 2.0 and OB 3.0 contexts");
  if (!has(vc?.type, "VerifiableCredential") || !has(vc?.type, "OpenBadgeCredential")) p.push("type must include VerifiableCredential and OpenBadgeCredential");
  if (!/^urn:uuid:/.test(vc?.id ?? "")) p.push("id must be a urn:uuid");
  if (!vc?.issuer?.id || !has(vc.issuer.type, "Profile")) p.push("issuer must be a Profile with an id");
  if (!vc?.validFrom || Number.isNaN(Date.parse(vc.validFrom))) p.push("validFrom must be a date-time");
  if (!vc?.name) p.push("name is required");
  const s = vc?.credentialSubject, a = s?.achievement;
  if (!has(s?.type, "AchievementSubject")) p.push("credentialSubject.type must include AchievementSubject");
  if (!a?.id || !has(a.type, "Achievement") || !a.name || !a.description || !a.criteria?.narrative) p.push("achievement needs id, type Achievement, name, description and criteria");
  if (vc?.credentialStatus?.type !== "BitstringStatusListEntry") p.push("credentialStatus must be a BitstringStatusListEntry");
  return p;
}

function trustRoutes({ db, keysDb, chain, secret, chainId, publicUrl, t, session, fail, q }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, org_id INTEGER, status TEXT NOT NULL, outcome TEXT, notes TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE IF NOT EXISTS credentials (id INTEGER PRIMARY KEY, token_id TEXT NOT NULL, wallet TEXT NOT NULL, jti TEXT NOT NULL, issued_at INTEGER NOT NULL, UNIQUE (token_id, wallet));
    CREATE TABLE IF NOT EXISTS profiles (wallet TEXT PRIMARY KEY, iv BLOB NOT NULL, tag BLOB NOT NULL, data BLOB NOT NULL, visibility TEXT NOT NULL, link_key TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  keysDb.exec("CREATE TABLE IF NOT EXISTS keys (wallet TEXT PRIMARY KEY, iv BLOB NOT NULL, tag BLOB NOT NULL, wrapped BLOB NOT NULL)");
  const key = issuerKey(secret), master = kdf(secret, "vault-master"); // shortcut: master key from the secret; use a KMS in production

  // ---------- audit cases ----------
  async function auditor(req) {
    const me = session(req);
    if (!(await chain.isAuditor(me))) fail(403, "This wallet doesn't hold the auditor role on the ledger.");
    return me;
  }
  const caseView = (c) => ({ id: c.id, subject: c.subject, orgId: c.org_id, status: c.status, outcome: c.outcome, notes: JSON.parse(c.notes), createdBy: c.created_by, createdAt: c.created_at, closedAt: c.closed_at });
  const caseById = (id) => q("SELECT * FROM cases WHERE id = ?").get(id) ?? fail(404, `Case #${id} was not found.`);
  const text = (v, max, what) => { const s = String(v ?? "").trim(); if (!s) fail(400, `${what} is required.`); return s.slice(0, max); };
  const note = (c, by, body) => q("UPDATE cases SET notes = ? WHERE id = ?").run(JSON.stringify([...JSON.parse(c.notes), { by, at: t(), ...body }]), c.id);

  // ---------- credentials ----------
  const statusUrl = `${publicUrl}/credentials/status`;
  // The list is public, so it's cached: one chain scan per STATUS_TTL however many requests arrive.
  // shortcut: still one chain read per issued credential per scan; index badge burns past a few thousand credentials
  let statusCache = null;
  async function revokedBits() {
    if (statusCache && t() - statusCache.at < STATUS_TTL) return statusCache.bits;
    const bits = Buffer.alloc(STATUS_BITS / 8);
    for (const c of q("SELECT * FROM credentials").all()) {
      const b = await chain.badge(c.token_id);
      if (!b || b.owner !== c.wallet) bits[c.id >> 3] |= 0x80 >> (c.id & 7);
    }
    statusCache = { at: t(), bits };
    return bits;
  }

  // ---------- profile vault ----------
  const gcm = (k, iv, aad) => { const c = crypto.createCipheriv("aes-256-gcm", k, iv); c.setAAD(Buffer.from(aad)); return c; };
  function dataKey(wallet, create) {
    const row = keysDb.prepare("SELECT * FROM keys WHERE wallet = ?").get(wallet);
    if (row) { const d = crypto.createDecipheriv("aes-256-gcm", master, row.iv); d.setAAD(Buffer.from(wallet)); d.setAuthTag(row.tag); return Buffer.concat([d.update(row.wrapped), d.final()]); }
    if (!create) return null;
    const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = gcm(master, iv, wallet), wrapped = Buffer.concat([c.update(k), c.final()]);
    keysDb.prepare("INSERT INTO keys (wallet, iv, tag, wrapped) VALUES (?, ?, ?, ?)").run(wallet, iv, c.getAuthTag(), wrapped);
    return k;
  }
  function readProfile(wallet) {
    const row = q("SELECT * FROM profiles WHERE wallet = ?").get(wallet), k = row && dataKey(wallet, false);
    if (!row || !k) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", k, row.iv);
    d.setAAD(Buffer.from(wallet));
    d.setAuthTag(row.tag);
    return { fields: JSON.parse(Buffer.concat([d.update(row.data), d.final()]).toString()), visibility: JSON.parse(row.visibility), linkKey: row.link_key, updatedAt: row.updated_at };
  }

  return {
    "GET /cases": async ({ req }) => { await auditor(req); return q("SELECT * FROM cases ORDER BY status DESC, id DESC").all().map(caseView); },
    "POST /cases": async ({ req, body }) => {
      const me = await auditor(req), orgId = body.orgId == null ? null : Number(body.orgId);
      const { lastInsertRowid } = q("INSERT INTO cases (subject, org_id, status, notes, created_by, created_at) VALUES (?, ?, 'open', ?, ?, ?)")
        .run(text(body.subject, 200, "A subject"), Number.isInteger(orgId) ? orgId : null, JSON.stringify(body.note ? [{ by: me, at: t(), text: String(body.note).slice(0, 2000) }] : []), me, t());
      return caseView(caseById(Number(lastInsertRowid)));
    },
    "POST /cases/:id/note": async ({ req, id, body }) => {
      const me = await auditor(req), c = caseById(id);
      if (c.status !== "open") fail(409, "This case is closed.");
      note(c, me, { text: text(body.text, 2000, "A note"), ...(ethers.isHexString(body.txHash, 32) ? { txHash: body.txHash } : {}) });
      return caseView(caseById(id));
    },
    "POST /cases/:id/close": async ({ req, id, body }) => {
      const me = await auditor(req), c = caseById(id);
      if (c.status !== "open") fail(409, "This case is already closed.");
      if (!OUTCOMES.includes(body.outcome)) fail(400, `Outcome must be one of: ${OUTCOMES.join(", ")}.`);
      if (body.outcome === "org-suspended" && !(c.org_id && (await chain.orgSuspended(c.org_id)))) fail(409, "The chain doesn't show this NGO as suspended. Suspend it from your wallet first.");
      note(caseById(id), me, { text: text(body.note, 2000, "A reason") });
      q("UPDATE cases SET status = 'closed', outcome = ?, closed_at = ? WHERE id = ?").run(body.outcome, t(), id);
      return caseView(caseById(id));
    },
    // Evidence bundle with a SHA-256 over its contents, so a copy can be checked later.
    "GET /cases/:id/export": async ({ req, id }) => {
      await auditor(req);
      const bundle = { case: caseView(caseById(id)), exportedAt: new Date(t() * 1000).toISOString(), chainId };
      return { ...bundle, sha256: crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex") };
    },

    "POST /credentials": async ({ req, body }) => {
      const me = session(req), tokenId = String(body.tokenId ?? "");
      if (!/^\d+$/.test(tokenId)) fail(400, "Give the badge's token number.");
      const b = await chain.badge(tokenId);
      if (!b || b.owner !== me) fail(403, "This wallet doesn't hold that badge.");
      q("INSERT OR IGNORE INTO credentials (token_id, wallet, jti, issued_at) VALUES (?, ?, ?, ?)").run(tokenId, me, `urn:uuid:${crypto.randomUUID()}`, t());
      const row = q("SELECT * FROM credentials WHERE token_id = ? AND wallet = ?").get(tokenId, me);
      if (row.id >= STATUS_BITS) fail(503, "The credential status list is full; a new list is needed before more credentials can be issued.");
      const what = `${b.threshold}h ${b.kind === 0 ? "total" : CATS[b.kind - 1]}`;
      const vc = {
        "@context": [VC2_CONTEXT, OB3_CONTEXT], id: row.jti, type: ["VerifiableCredential", "OpenBadgeCredential"],
        issuer: { id: key.did, type: ["Profile"], name: "ProofHours (local demo issuer)" },
        validFrom: new Date(row.issued_at * 1000).toISOString(), name: `ProofHours milestone: ${what}`,
        credentialSubject: {
          id: `did:pkh:eip155:${chainId}:${me}`, type: ["AchievementSubject"],
          achievement: { id: `urn:proofhours:achievement:${b.kind}:${b.threshold}`, type: ["Achievement"], achievementType: "Badge", name: what,
            description: `${b.threshold} verified volunteer hours${b.kind === 0 ? " across all impact areas" : ` in ${CATS[b.kind - 1]}`}, issued by accredited NGOs on the ProofHours ledger.`,
            criteria: { narrative: `Hold at least ${b.threshold} verified hours${b.kind === 0 ? "" : ` in ${CATS[b.kind - 1]}`} on ProofHoursLedger. Hours come only from NGO issuance or NGO-approved V1 imports; corrections and revocations lower them.` } },
        },
        evidence: [{ id: `urn:proofhours:badge:${chainId}:${chain.badgesAddress}:${tokenId}`, type: ["Evidence"], name: `Soulbound badge #${tokenId}`, narrative: `ERC-5192 token #${tokenId} of ${chain.badgesAddress} on chain ${chainId}.` }],
        credentialStatus: { id: `${statusUrl}#${row.id}`, type: "BitstringStatusListEntry", statusPurpose: "revocation", statusListIndex: String(row.id), statusListCredential: statusUrl },
      };
      return { jwt: signJwt(key, { iss: key.did, sub: vc.credentialSubject.id, nbf: row.issued_at, jti: row.jti, vc }), credential: vc };
    },
    "GET /credentials/status": async () => {
      const list = {
        "@context": [VC2_CONTEXT], id: statusUrl, type: ["VerifiableCredential", "BitstringStatusListCredential"], issuer: key.did, validFrom: new Date(t() * 1000).toISOString(),
        credentialSubject: { id: `${statusUrl}#list`, type: "BitstringStatusList", statusPurpose: "revocation", encodedList: "u" + zlib.gzipSync(await revokedBits()).toString("base64url") },
      };
      return { jwt: signJwt(key, { iss: key.did, nbf: t(), jti: statusUrl, vc: list }), credential: list };
    },
    "POST /credentials/verify": async ({ body }) => {
      const r = readJwt(body.jwt);
      if (!r) return { valid: false, checks: [{ ok: false, what: "Readable VC-JWT" }] };
      const vc = r.payload.vc ?? {}, problems = ob3Problems(vc), checks = [];
      checks.push({ ok: r.signatureOk, what: "Signature matches the issuer key (EdDSA, did:key)" });
      checks.push({ ok: r.payload.iss === key.did && vc.issuer?.id === key.did, what: "Issued by this ProofHours deployment" });
      checks.push({ ok: problems.length === 0, what: problems.length ? `Open Badges 3.0 structure: ${problems.join("; ")}` : "Open Badges 3.0 structure (local check)" });
      const idx = Number(vc.credentialStatus?.statusListIndex), row = q("SELECT * FROM credentials WHERE id = ?").get(idx);
      const live = row && (await chain.badge(row.token_id));
      const notRevoked = !!live && live.owner === row.wallet; // this credential's badge only, read live (not the cached list)
      checks.push({ ok: notRevoked, what: notRevoked ? "Not revoked: the badge is still held on-chain" : "Revoked: the badge is no longer held by this wallet (burned, renounced or below its milestone)" });
      return { valid: checks.every((c) => c.ok), checks, subject: vc.credentialSubject?.id, achievement: vc.credentialSubject?.achievement?.name, token: row?.token_id ?? null, holder: live?.owner ?? null };
    },

    "GET /profile": ({ req }) => readProfile(session(req)) ?? { fields: {}, visibility: {}, linkKey: null },
    "PUT /profile": ({ req, body }) => {
      const me = session(req), fields = {}, visibility = {};
      for (const [f, max] of Object.entries(FIELDS)) {
        const v = String(body.fields?.[f] ?? "").trim();
        if (v.length > max) fail(400, `${f} can be at most ${max} characters.`);
        if (v) fields[f] = v;
        visibility[f] = VISIBILITY.includes(body.visibility?.[f]) ? body.visibility[f] : "private";
      }
      const k = dataKey(me, true), iv = crypto.randomBytes(12), c = gcm(k, iv, me), data = Buffer.concat([c.update(JSON.stringify(fields)), c.final()]);
      const link = q("SELECT link_key FROM profiles WHERE wallet = ?").get(me)?.link_key ?? crypto.randomBytes(12).toString("base64url");
      q("INSERT OR REPLACE INTO profiles (wallet, iv, tag, data, visibility, link_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(me, iv, c.getAuthTag(), data, JSON.stringify(visibility), link, t());
      return readProfile(me);
    },
    // What a visitor may see: public fields, plus link-only fields when the share link's key is given.
    "GET /profile/public/:addr": ({ param, url }) => {
      const p = readProfile(ethers.getAddress(param));
      if (!p) return { fields: {} };
      const k = url.searchParams.get("k") ?? "", withLink = k.length > 0 && k.length === p.linkKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(p.linkKey));
      return { fields: Object.fromEntries(Object.entries(p.fields).filter(([f]) => p.visibility[f] === "public" || (withLink && p.visibility[f] === "link"))) };
    },
    // Erasure: destroying the data key makes every copy of the ciphertext unreadable, including backups.
    "DELETE /profile": ({ req }) => {
      const me = session(req);
      keysDb.prepare("DELETE FROM keys WHERE wallet = ?").run(me);
      q("DELETE FROM profiles WHERE wallet = ?").run(me);
      return { erased: true };
    },
  };
}

module.exports = { trustRoutes, issuerKey, didKeyPublic, readJwt, ob3Problems, OB3_CONTEXT, VC2_CONTEXT };
