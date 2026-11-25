# ProofHours V2: deployment plan

**Approval gates.** Each of these needs the project owner's explicit approval first:
- public-chain transactions or contract deployment;
- paid services;
- pushing to GitHub or merging into `main`;
- publishing the website.

## Environments

| Environment | Chain | V1 | V2 | Who uses it |
|---|---|---|---|---|
| Live V1 | Base Sepolia (84532) | `0xFbDC…9F9b` (unchanged) | not deployed | Public site from `main` (tag `v1.0.0`) |
| Local fork | Anvil fork of Base Sepolia, chain 31337, `127.0.0.1:8546` | copy of the live V1 | `ProofHoursLedger 0xd714…44bA`, `ProofHoursBadges 0x64d4…35F4` | Development, demos, e2e |
| V2 staging | Base Sepolia | live V1 (read-only) | **not deployed (needs approval)** | After approval |
| Attendance service | Off-chain | — | local only (`127.0.0.1:8790`) | Public hosting needs approval, rate limiting and a legal review of the data it holds |

## Local (reproducible, no keys)
```bash
anvil --fork-url https://base-sepolia-rpc.publicnode.com --chain-id 31337 --port 8546
cast rpc anvil_impersonateAccount 0x0000000000000000000000000000000050000001 --rpc-url http://127.0.0.1:8546
cast rpc anvil_setBalance 0x0000000000000000000000000000000050000001 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8546
SEED_DEMO=true forge script script/DeployV2.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
  --unlocked --sender 0x0000000000000000000000000000000050000001
(cd server && npm ci)                                          # exact versions from server/package-lock.json
export ATTENDANCE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")   # same value for both
node server/attendance.js   # attendance service on 127.0.0.1:8790 (Node 22.13+); refuses to start without the secret
node server/indexer.js      # indexer + search on 127.0.0.1:8792
python -m http.server 8765 --directory docs    # open http://localhost:8765/?local
```
- **Env file:** copy `server/.env.example` to `server/.env` (gitignored) and run `node --env-file=.env attendance.js` from `server/`; no extra package needed.
- **Attendance service:** needs `ethers` (`cd server && npm ci`). Settings: `PORT` (8790), `RPC_URL` (`http://127.0.0.1:8546`), `LEDGER` (local ledger address), `CHAIN_ID` (31337), `ATTENDANCE_DB` (`server/data/attendance.sqlite`). The page finds it through `config.js` → `local.attendance`, or `?api=` for another address.
- **Stage 5 settings (attendance service):** `VAULT_KEYS_DB` (`server/data/vault-keys.sqlite`, keep it apart from the main database and its backups), `PUBLIC_URL` (used in credential status links), `BADGES` (badge contract). The indexer needs the **same** `ATTENDANCE_SECRET` for auditor views.
- **Indexer:** settings `PORT` (8792), `RPC_URL`, `LEDGER`, `CHAIN_ID`, `CONFIRMATIONS` (2), `START_BLOCK` (found automatically), `POLL_MS` (2000), `INDEXER_DB` (`server/data/indexer.sqlite`). The page finds it through `config.js` → `local.indexer`, or `?search=`. To rebuild from scratch, stop it and delete the database file.
- **Search benchmark:** `node server/bench-search.js 100000 1000`.
- **Load test:** `node server/loadgen.js 50` (results in [V2_LOAD_TEST_REPORT.md](V2_LOAD_TEST_REPORT.md)).
- **Operations:** `RATE_LIMIT` (300 attendance / 600 indexer per minute per client), `LOG_REQUESTS=0` to silence access logs. Runbooks: [V2_RUNBOOKS.md](V2_RUNBOOKS.md).
- **Fixed addresses:** the deployer `0x…50000001` has nonce 0 on Base Sepolia, so on every fresh fork the V2 contracts get the same addresses, which match `docs/config.js` → `local.v2`.
- **Demo seed:** "Green Shores NGO (demo)" (coordinator = the V1 issuer wallet, so V1 records can be linked) and "Desert Bloom NGO (demo)".

## Release checks (run before any staging deployment)
```bash
forge build --force && forge test                 # contracts: 60 tests incl. fuzz, invariant, resource limits
(cd server && npm ci && node --test)              # services: 25 tests
(cd e2e && npm ci && node run.js)                 # browser: 9 suites (needs Chrome/Edge, anvil, internet for the fork)
```
- **No CI is configured yet.** These are the commands a CI job should run; the browser suites need a Chromium browser and Foundry.
- **Reproducible build:** solc 0.8.28 pinned in `foundry.toml`, OpenZeppelin v5.7.0 pinned (submodule + `foundry.lock`), forge-std vendored; remapping auto-detection is off (`auto_detect_remappings = false`), because otherwise whichever nested OpenZeppelin submodules happen to be checked out end up in the metadata hash. A fresh clone and the working checkout now build byte-identical V2 contracts, which source verification needs. Node dependencies are pinned by `server/package-lock.json` and `e2e/package-lock.json`.
- **Deploy rehearsal (local only, nothing sent to a public chain):** on a throwaway fork, `GOVERNANCE=<test address> forge script script/DeployV2.s.sol --rpc-url http://127.0.0.1:<port> --broadcast --unlocked --sender 0x…50000001`, then check with `cast call` that governance holds admin and pauser on both contracts, the deployer holds none, and the ledger holds the badge minter role. Rehearsed for the release candidate: all as expected.
- **Database schema:** both services create their tables on start (`CREATE TABLE IF NOT EXISTS`); the attendance service adds one later column in place, and the indexer versions its cache (`PRAGMA user_version`, rebuilt from the chain). There is no migration framework: staging starts from empty databases, and any future schema change needs an explicit migration and a backup first.
- **Batch size:** issuance sends at most 25 volunteers per transaction (about 12.4M gas with two badge mints each, under the 16.7M per-transaction cap); the attendance service hands out 25 at a time and reports the rest.

## Base Sepolia staging (after approval)
1. **Pre-flight:**
   - release checks above green;
   - independent review of the diff;
   - multisig created (Safe, 3-of-5 suggested), with signer list confirmed by the owner;
   - deployer wallet funded with test ETH by the owner (never a key shared in chat).
2. **Deploy with a keystore:**
   ```bash
   GOVERNANCE=<safe address> forge script script/DeployV2.s.sol --rpc-url https://sepolia.base.org --broadcast --account <keystore>
   ```
   The script grants admin and pauser to the multisig and renounces the deployer's roles. `SEED_DEMO` is never set on public chains.
3. **Verify source** on Sourcify, Blockscout and BaseScan.
4. **Record** the transaction hashes from real receipts, then put the addresses in `config.js` → `v2`.
5. **Smoke test:** run the e2e V2 suite read-only against staging, then a single real write approved by the owner.
6. **Governance actions** through the multisig: register NGOs, assign NGO admins, grant the auditor role.
7. **Services (hosting needs approval; it may be a paid service):**
   - one host for the attendance service and one for the indexer, behind HTTPS (the site's CSP allows `https:` connections);
   - environment from `server/.env.example`: `RPC_URL` = a Base Sepolia RPC, `CHAIN_ID=84532`, `LEDGER`/`BADGES` = the deployed addresses, `ATTENDANCE_SECRET` from a secret store (same for both), `PUBLIC_URL` = the attendance service's public HTTPS URL (it is written into credentials, so keep it stable), `CONFIRMATIONS=2` or more, `START_BLOCK` = the ledger's deploy block;
   - `VAULT_KEYS_DB` on a separate volume with its own backups (runbooks §4); `/metrics` restricted to operators at the proxy;
   - health checks: `GET /health` on both (the indexer's `behind` should stay near 0).
8. **Front end:** set `config.js` → `v2` (addresses), `attendance` and `indexer` (HTTPS URLs) on a staging branch or a separate Pages site, never on `main` until approved.

## Versioning and upgrades
- **Immutable contracts:** a fix ships as a **new version deployed alongside**, and the old one is never overwritten (as with V1 → V2).
- **Version changes:** the front end switches by config. Records on an old version stay verifiable there.
- **Migrations:** any migration follows the V1 pattern of consent, issuer approval, reading truth from the old contract, and recording provenance.

## Rollback
- **Front end:** revert the merge commit on `main`; GitHub Pages republishes V1 (`v1.0.0`). For staging, set `config.js` → `v2`/`attendance`/`indexer` back to `null` (the V2 screens then say "not deployed").
- **Contracts:** pause through governance. Contracts aren't upgradeable, so rollback means pausing and pointing the UI back to V1. V2 never writes to V1, so V1 records and verification links keep working throughout.
- **Services:** stop the process, restore the attendance and vault-keys databases from their backups (re-apply the erasure log, runbooks §5f), start the previous release. The indexer needs no restore: delete its database and it rebuilds from the chain.
