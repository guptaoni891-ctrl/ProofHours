# ProofHours V2: operations runbooks

Local and testnet only. Any public deployment, public hosting or real-data use needs the owner's approval first (see [V2_DEPLOYMENT_PLAN.md](V2_DEPLOYMENT_PLAN.md)).

## 1. What runs where
| Component | Process | Port (local) | Holds | Health | Metrics |
|---|---|---|---|---|---|
| Static site | any static host (`docs/`) | 8765 | nothing | page loads | none |
| Attendance service | `node server/attendance.js` | 8790 | shifts, attendance, vouchers, leagues, cases, credentials, encrypted profiles (`server/data/attendance.sqlite`); vault keys (`server/data/vault-keys.sqlite`) | `GET /health` | `GET /metrics` |
| Indexer + search | `node server/indexer.js` | 8792 | derived cache only (`server/data/indexer.sqlite`) | `GET /health` (`behind`, `reorgs`) | `GET /metrics` |
| Contracts | V1 (live, untouched), V2 (local fork only) | chain | records, totals, badges | n/a | n/a |

**Secrets:** only the attendance service reads `ATTENDANCE_SECRET`. Each use has its own HKDF subkey: the Ed25519 session key, QR and voucher MACs, the credential issuer key and the vault master key (a KMS in production; see §5e). The indexer gets `SESSION_PUBLIC_KEY` (printed by the attendance service at start-up and served at `GET /auth/public-key`), which can verify sessions but not create them.

## 2. Start and stop
```bash
export ATTENDANCE_SECRET=<32+ random bytes, from a secret store>   # attendance service only
node server/attendance.js     # refuses to start without ATTENDANCE_SECRET (and, on a public chain, without APP_ORIGINS); prints SESSION_PUBLIC_KEY
SESSION_PUBLIC_KEY=<from the line above> node server/indexer.js   # START_BLOCK required on public chains; found automatically on a local fork
# behind a reverse proxy: TRUST_PROXY=1 on both (per-client rate limits); METRICS_TOKEN=<random> to read /metrics through it
```
- **Env file:** `node --env-file=.env attendance.js` (template: `server/.env.example`).
- **Stop:** send Ctrl+C / SIGTERM. SQLite commits each request, so no write is half-done.
- **Access logs:** JSON lines on stdout `{t, service, method, path, status, ms}`. They carry the path only: no query strings, headers, tokens or wallets.

## 3. Monitoring (what to watch)
| Signal | Where | Suggested alert |
|---|---|---|
| Service up | `GET /health` every 30 s | 2 failures in a row |
| Server errors | `/metrics` → `byStatus["500"]`, `["502"]` | any 500; 502s for > 5 min (the RPC is down) |
| Rate limiting | `/metrics` → `rateLimited` | sudden growth (abuse, or a limit set too low) |
| Latency | `/metrics` → `latencyMs.p95` | search p95 > 50 ms for 10 min; attendance p95 > 300 ms |
| Indexer lag | indexer `/health` → `behind` | > 20 blocks for 10 min |
| Reorgs | indexer `/health` → `reorgs` | any increase (expected to be rare on Base) |

## 4. Backups and restore
- **Attendance database:** back up with `sqlite3 server/data/attendance.sqlite ".backup backup.sqlite"` (safe while running).
- **Vault keys database:** back it up **separately**, with shorter retention and stricter access.
  - **Why separate:** if the keys and the data sit in the same backup, erasure (crypto-shredding) no longer protects that backup.
  - **Restoring:** restoring an old keys backup would undo erasures made since. Re-apply the erasure log before going live (§5f).
- **Indexer:** no backup needed. Delete `server/data/indexer.sqlite` and restart; it rebuilds from the chain.
- **Restore test:** monthly. Restore to a scratch folder, start the service against it, check `/health` and one `GET /opportunities`.

## 5. Incidents

### a. A coordinator wallet is compromised or issues bad hours
1. **Contain:** an auditor opens a case from the alert (or a sampled record) and suspends the NGO from the Auditor console. That's an on-chain `suspendOrg`, effective immediately; the NGO can't issue, correct or approve V1 links.
2. **Fix permissions:** governance (the multisig) removes the coordinator, or the NGO admin replaces it.
3. **Fix records:** the NGO or governance revokes or corrects bad records. Totals and badges update automatically, and credentials for burned badges show as revoked.
4. **Restore:** governance reinstates the NGO, and the auditor closes the case with the transaction hashes noted.

### b. A bug or mass bad issuance across NGOs
- **Pause:** a pauser pauses the ledger (issuance, corrections and V1 approvals stop; reads keep working). Only governance can unpause.
- **Ship the fix:** contracts aren't upgradeable. A fixed version is deployed alongside, and the front end switches by config (deployment plan, "Versioning").

### c. The RPC is down or slow
- **Front end:** reads fail over across the configured RPCs automatically, and sends are refused when the chain can't be confirmed (fail-safe).
- **Services:** they return `502` "could not reach the chain". Point `RPC_URL` at another endpoint and restart.

### d. The indexer is behind or reorging
- **Check:** look at `/health` (`behind`, `reorgs`) and confirm the RPC answers `eth_getLogs`.
- **Restart:** restarting is safe; it resumes from its last block hash.
- **Corruption:** if you suspect the cache is corrupted, stop the indexer, delete its database and start it again.

### e. `ATTENDANCE_SECRET` leaked
1. **Rotate:** generate a new secret, restart the attendance service with it, and give the indexer the new `SESSION_PUBLIC_KEY`. (A leaked indexer host exposes only the public key: nothing to rotate.)
2. **Expected effects:**
   - all sign-in sessions, live QR codes and unredeemed vouchers stop working (people sign in again; coordinators reprint vouchers);
   - **the credential issuer key changes, so previously issued credentials no longer verify against the new issuer**, and holders must re-issue them;
   - **the vault master key changes, so stored profiles can't be decrypted.**
3. **Production:** for this reason the issuer and vault keys must live in a KMS, independent of the session secret (Blocked: KMS).

### f. A volunteer asks for erasure
- **Self-service:** they use **Delete profile** on their passport. That destroys the data key and the row.
- **Operator:** if they can't sign in, verify control of the wallet out of band, then delete the wallet's row from `keys` (vault keys database) and `profiles`. Record the wallet and date in the erasure log, but never the data.
- **On-chain:** records (wallet address, hours, hashes) can't be erased. They're pseudonymous, and the UI says so; a volunteer who needs separation should use a new wallet.

### g. Abuse or a request flood
- **Rate limits:** rate limiting answers `429` with `Retry-After`. Tune `RATE_LIMIT`, and block at the proxy for distributed abuse.
- **Sign-in floods:** these are the costliest. Signature checks run at about 590/s per process (see the load test report).

## 6. Releases
1. **Test:** `forge test`, `node --test server/` and `cd e2e && node run.js` must all pass, and the load test should show no regressions.
2. **Review:** an independent review of the diff.
3. **Approvals:**
   - **Public chain:** contract deployments follow the deployment plan, with owner approval and keystore signing.
   - **Front end:** merging to `main` republishes GitHub Pages; roll back by reverting the merge commit.
