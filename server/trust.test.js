// Stage 5 service tests: audit cases, Open Badges 3.0 credentials, profile vault and erasure.
// node --test server/  (real HTTP, real wallet signatures with throwaway keys, fake chain)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { ethers } = require("ethers");
const { createApp, openDb } = require("./attendance");
const { issuerKey, readJwt, ob3Problems } = require("./trust");

async function setup() {
  const [auditor, coord, vol, other] = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());
  const chain = {
    badgesAddress: "0x64d4972B737C1ECfab6FEdE9AD201D28660a35F4",
    held: { 1: { owner: vol.address, kind: 0, threshold: 10 }, 2: { owner: vol.address, kind: 1, threshold: 10 } },
    suspended: {},
    isAuditor: async (a) => a === auditor.address,
    badge: async (id) => chain.held[id] ?? null,
    orgSuspended: async (id) => !!chain.suspended[id],
    optedIn: async () => true,
    coordinatorOrg: async () => 0,
  };
  const db = openDb(":memory:"), keysDb = new DatabaseSync(":memory:");
  const server = http.createServer(createApp({ db, keysDb, chain, secret: "trust-secret", chainId: 31337, publicUrl: "http://issuer.test" }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const signIn = async (w) => { const { body: n } = await call("POST", "/auth/nonce", null, { address: w.address }); return (await call("POST", "/auth", null, { address: w.address, nonce: n.nonce, signature: await w.signMessage(n.message) })).body.token; };
  const tok = { auditor: await signIn(auditor), coord: await signIn(coord), vol: await signIn(vol), other: await signIn(other) };
  return { chain, db, keysDb, call, tok, vol, close: () => server.close() };
}

test("audit cases: auditors only; outcomes are human decisions; 'NGO suspended' needs the chain to show it; exports hash-verify", async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await s.call("GET", "/cases", s.tok.coord)).status, 403);
  assert.equal((await s.call("POST", "/cases", s.tok.vol, { subject: "x" })).status, 403);
  const c = (await s.call("POST", "/cases", s.tok.auditor, { subject: "alert:spike NGO #2", orgId: 2, note: "Spike on one day; checking attendance logs." })).body;
  assert.deepEqual([c.status, c.orgId, c.notes.length], ["open", 2, 1]);
  assert.equal((await s.call("POST", `/cases/${c.id}/note`, s.tok.auditor, { text: "Asked the NGO for rosters.", txHash: ethers.id("x") })).body.notes[1].txHash, ethers.id("x"));
  assert.match((await s.call("POST", `/cases/${c.id}/close`, s.tok.auditor, { outcome: "org-suspended", note: "Suspended." })).body.error, /doesn't show this NGO as suspended/);
  assert.equal((await s.call("POST", `/cases/${c.id}/close`, s.tok.auditor, { outcome: "banned" })).status, 400);
  s.chain.suspended[2] = true;
  const closed = (await s.call("POST", `/cases/${c.id}/close`, s.tok.auditor, { outcome: "org-suspended", note: "Suspended from the auditor wallet." })).body;
  assert.deepEqual([closed.status, closed.outcome], ["closed", "org-suspended"]);
  assert.match((await s.call("POST", `/cases/${c.id}/note`, s.tok.auditor, { text: "late" })).body.error, /closed/);
  const ex = (await s.call("GET", `/cases/${c.id}/export`, s.tok.auditor)).body;
  const { sha256, signature, ...bundle } = ex;
  assert.equal(sha256, crypto.createHash("sha256").update(JSON.stringify(bundle)).digest("hex"), "the bundle hash verifies");
  const key = issuerKey("trust-secret"), sig = readJwt(signature, key);
  assert.ok(sig.signatureOk && sig.payload.sha256 === sha256, "the issuer's signature covers the hash, so an edited copy can't be re-hashed into a valid one");
});

test("Open Badges 3.0 credential: issued only to the holder, signed (did:key), OB3 structure, revoked once the badge is gone", async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await s.call("POST", "/credentials", s.tok.other, { tokenId: "1" })).status, 403, "not the holder");
  const { jwt, credential } = (await s.call("POST", "/credentials", s.tok.vol, { tokenId: "1" })).body;
  assert.deepEqual(ob3Problems(credential), []);
  assert.equal(credential.credentialSubject.id, `did:pkh:eip155:31337:${s.vol.address}`);
  assert.equal(credential.credentialSubject.achievement.name, "10h total");
  assert.equal(credential.issuer.id, issuerKey("trust-secret").did, "issuer key is stable for the same secret");
  const r = readJwt(jwt);
  assert.ok(r.signatureOk && r.header.alg === "EdDSA" && r.payload.sub === credential.credentialSubject.id);
  let v = (await s.call("POST", "/credentials/verify", null, { jwt })).body;
  assert.equal(v.valid, true, JSON.stringify(v.checks));
  // tampering breaks the signature
  const [h, p, sig] = jwt.split(".");
  const forged = JSON.parse(Buffer.from(p, "base64url"));
  forged.vc.credentialSubject.achievement.name = "500h total";
  v = (await s.call("POST", "/credentials/verify", null, { jwt: `${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}` })).body;
  assert.equal(v.valid, false);
  assert.equal(v.checks[0].ok, false);
  // the badge is burned (correction below its milestone): the status list and the verifier both say revoked
  delete s.chain.held[1];
  v = (await s.call("POST", "/credentials/verify", null, { jwt })).body;
  assert.equal(v.valid, false);
  assert.match(v.checks.at(-1).what, /^Revoked/);
  const list = (await s.call("GET", "/credentials/status")).body;
  assert.ok(readJwt(list.jwt).signatureOk);
  const bits = zlib.gunzipSync(Buffer.from(list.credential.credentialSubject.encodedList.slice(1), "base64url"));
  const idx = Number(credential.credentialStatus.statusListIndex);
  assert.equal(bits.length, 16384);
  assert.ok(bits[idx >> 3] & (0x80 >> (idx & 7)), "revocation bit set");
  // the public list is cached: repeated requests don't each scan the chain (amplification guard)
  let reads = 0;
  const badge = s.chain.badge;
  s.chain.badge = async (id) => { reads++; return badge(id); };
  for (let i = 0; i < 5; i++) await s.call("GET", "/credentials/status");
  assert.equal(reads, 0, "served from the cache");
  await s.call("POST", "/credentials/verify", null, { jwt });
  assert.equal(reads, 1, "verify reads only this credential's badge");
});

test("profile vault: encrypted at rest, per-field visibility, erasure makes every copy unreadable", async (t) => {
  const s = await setup();
  t.after(s.close);
  const put = await s.call("PUT", "/profile", s.tok.vol, { fields: { displayName: "Aisha (demo)", school: "Demo University", bio: "Weekend beach cleanups." }, visibility: { displayName: "public", school: "link", bio: "private" } });
  assert.equal(put.body.fields.displayName, "Aisha (demo)");
  const row = s.db.prepare("SELECT * FROM profiles").get();
  assert.ok(!Buffer.from(row.data).toString("latin1").includes("Aisha") && !Buffer.from(row.data).toString("latin1").includes("Demo University"), "nothing readable at rest");
  assert.deepEqual((await s.call("GET", `/profile/public/${s.vol.address}`)).body.fields, { displayName: "Aisha (demo)" }, "public only");
  assert.deepEqual((await s.call("GET", `/profile/public/${s.vol.address}?k=${put.body.linkKey}`)).body.fields, { displayName: "Aisha (demo)", school: "Demo University" }, "link key adds link-only fields; private never");
  assert.deepEqual((await s.call("GET", `/profile/public/${s.vol.address}?k=wrong-key-wrong`)).body.fields, { displayName: "Aisha (demo)" });
  assert.equal((await s.call("PUT", "/profile", s.tok.vol, { fields: { bio: "x".repeat(281) } })).status, 400);

  const backup = { ...s.db.prepare("SELECT * FROM profiles").get() }; // a copy taken before erasure
  assert.deepEqual((await s.call("DELETE", "/profile", s.tok.vol)).body, { erased: true });
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM profiles").get().n, 0);
  assert.equal(s.keysDb.prepare("SELECT COUNT(*) AS n FROM keys").get().n, 0, "data key destroyed");
  assert.deepEqual((await s.call("GET", "/profile", s.tok.vol)).body.fields, {});
  assert.deepEqual((await s.call("GET", `/profile/public/${s.vol.address}`)).body.fields, {});
  // the backup copy can't be decrypted: its key is gone, and guessing keys fails authentication
  assert.equal(s.keysDb.prepare("SELECT * FROM keys WHERE wallet = ?").get(s.vol.address), undefined);
  assert.throws(() => { const d = crypto.createDecipheriv("aes-256-gcm", crypto.randomBytes(32), backup.iv); d.setAAD(Buffer.from(s.vol.address)); d.setAuthTag(backup.tag); Buffer.concat([d.update(backup.data), d.final()]); });
});

// ---------- security regressions (backend review) ----------

test("verifier: a credential signed with the forger's own key is rejected, even if it names this issuer and a real status entry", async (t) => {
  const s = await setup();
  t.after(s.close);
  const { credential } = (await s.call("POST", "/credentials", s.tok.vol, { tokenId: "1" })).body;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const forgerDid = "did:key:z" + ethers.encodeBase58(Buffer.concat([Buffer.from([0xed, 0x01]), x]));
  const vc = structuredClone(credential);
  vc.credentialSubject.id = "did:pkh:eip155:31337:0x000000000000000000000000000000000000dEaD";
  vc.credentialSubject.achievement.name = "500h Healthcare";
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "EdDSA", typ: "JWT", kid: `${forgerDid}#x` }), body = b64({ iss: credential.issuer.id, sub: vc.credentialSubject.id, jti: vc.id, vc });
  const jwt = `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  const v = (await s.call("POST", "/credentials/verify", null, { jwt })).body;
  assert.equal(v.valid, false);
  assert.equal(v.checks[0].ok, false, "the signature check uses this deployment's key, not the one the token names");
  assert.equal(v.holder, null, "a forged token triggers no chain read");
});

test("verifier: a genuine credential can't borrow another credential's status entry", async (t) => {
  const s = await setup();
  t.after(s.close);
  const a = (await s.call("POST", "/credentials", s.tok.vol, { tokenId: "1" })).body, b = (await s.call("POST", "/credentials", s.tok.vol, { tokenId: "2" })).body;
  const key = issuerKey("trust-secret"), p = readJwt(a.jwt, key).payload;
  p.vc.credentialStatus.statusListIndex = b.credential.credentialStatus.statusListIndex; // re-signed by the real key, but pointing at b's row
  const head = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: key.kid })).toString("base64url"), body = Buffer.from(JSON.stringify(p)).toString("base64url");
  const jwt = `${head}.${body}.${crypto.sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
  const v = (await s.call("POST", "/credentials/verify", null, { jwt })).body;
  assert.equal(v.valid, false);
  assert.match(v.checks.find((c) => !c.ok).what, /Doesn't match any credential/);
});

test("public profile: any address letter case and any link key bytes are handled (400/200, never 500)", async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.call("PUT", "/profile", s.tok.vol, { fields: { bio: "hi" }, visibility: { bio: "link" } });
  const mixed = "0x" + [...s.vol.address.slice(2)].map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join("");
  assert.equal((await s.call("GET", `/profile/public/${mixed}`)).status, 200);
  const r = await s.call("GET", `/profile/public/${s.vol.address}?k=${encodeURIComponent("é".repeat(16))}`);
  assert.deepEqual([r.status, r.body.fields], [200, {}]);
});

test("erasure: the destroyed data key is overwritten on disk, not left in SQLite's free pages", async (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ph-vault-")), "keys.sqlite");
  const keysDb = new DatabaseSync(file), vol = ethers.Wallet.createRandom();
  const chain = { optedIn: async () => true, coordinatorOrg: async () => 0 };
  const server = http.createServer(createApp({ db: openDb(":memory:"), keysDb, chain, secret: "vault-secret", chainId: 31337 }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, token, body) => (await fetch(base + p, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) })).json();
  const n = await call("POST", "/auth/nonce", null, { address: vol.address });
  const { token } = await call("POST", "/auth", null, { address: vol.address, nonce: n.nonce, signature: await vol.signMessage(n.message) });
  await call("PUT", "/profile", token, { fields: { bio: "secret bio" } });
  const wrapped = Buffer.from(keysDb.prepare("SELECT wrapped FROM keys").get().wrapped);
  await call("DELETE", "/profile", token);
  keysDb.close();
  assert.ok(!fs.readFileSync(file).includes(wrapped), "wrapped key bytes are gone from the file");
});
