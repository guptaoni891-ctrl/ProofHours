// Wallet sign-in sessions shared by the attendance service (which issues them) and the indexer (which checks them for
// auditor-only views). A session is "address.expiry.hmac", signed with ATTENDANCE_SECRET.
"use strict";
const crypto = require("node:crypto");

const mac = (secret, s) => crypto.createHmac("sha256", secret).update(s).digest("base64url").slice(0, 22);
const safeEq = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const issue = (secret, address, exp) => `${address}.${exp}.${mac(secret, `session.${address}.${exp}`)}`;

// Returns { address } or { error } for an Authorization header value.
function verify(secret, header, nowSec) {
  const m = /^Bearer (\S+)$/.exec(header || "");
  if (!m) return { error: "Sign in with your wallet first." };
  const [a, exp, sig] = m[1].split(".");
  if (!sig || !safeEq(sig, mac(secret, `session.${a}.${exp}`))) return { error: "Your sign-in is not valid. Sign in again." };
  if (Number(exp) < nowSec) return { error: "Your sign-in expired. Sign in again." };
  return { address: a };
}

module.exports = { mac, safeEq, issue, verify };
