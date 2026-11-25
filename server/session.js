// Wallet sign-in sessions shared by the attendance service (which issues them) and the indexer (which checks them for
// auditor-only views). A session is "address.expiry.signature", signed with Ed25519. Only the attendance service holds
// the private key; the indexer gets the public key (SESSION_PUBLIC_KEY), so a compromised indexer can't mint sessions.
// Every other secret the attendance service uses is its own HKDF subkey of ATTENDANCE_SECRET (key separation).
"use strict";
const crypto = require("node:crypto");

const derive = (secret, info) => Buffer.from(crypto.hkdfSync("sha256", secret, "proofhours", info, 32));
const mac = (key, s) => crypto.createHmac("sha256", key).update(s).digest("base64url").slice(0, 22);
const safeEq = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const ed25519 = (seed) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });

// Session signing key pair, derived from the service secret. publicKey is the raw 32 bytes, base64url (SESSION_PUBLIC_KEY).
function sessionKeys(secret) {
  const privateKey = ed25519(derive(secret, "session-ed25519"));
  return { privateKey, publicKey: crypto.createPublicKey(privateKey).export({ format: "jwk" }).x };
}
const publicKeyFrom = (x) => crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: String(x) }, format: "jwk" });

const payload = (address, exp) => Buffer.from(`proofhours-session.${address}.${exp}`);
const issue = (privateKey, address, exp) => `${address}.${exp}.${crypto.sign(null, payload(address, exp), privateKey).toString("base64url")}`;

// Returns { address } or { error } for an Authorization header value. `key` is a public KeyObject (or the private key).
function verify(key, header, nowSec) {
  const m = /^Bearer (0x[0-9a-fA-F]{40})\.(\d{1,12})\.([A-Za-z0-9_-]{86})$/.exec(header || "");
  if (!m) return { error: header ? "Your sign-in is not valid. Sign in again." : "Sign in with your wallet first." };
  const [, a, exp, sig] = m;
  let ok = false;
  try { ok = crypto.verify(null, payload(a, exp), key, Buffer.from(sig, "base64url")); } catch { ok = false; }
  if (!ok) return { error: "Your sign-in is not valid. Sign in again." };
  if (Number(exp) < nowSec) return { error: "Your sign-in expired. Sign in again." };
  return { address: a };
}

module.exports = { derive, mac, safeEq, ed25519, sessionKeys, publicKeyFrom, issue, verify };
