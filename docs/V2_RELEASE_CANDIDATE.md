# ProofHours V2: release-candidate validation (v2.0.0-rc.1)

**Date:** 2026-11-25 · **Branch:** `feature/gamified-v2` · **Scope:** everything in V2, validated locally. Nothing has been deployed or broadcast to a public chain, and nothing has been pushed. V1 (`VolunteerHours` at `0xFbDC…9F9b` on Base Sepolia), `main` and `v1.0.0` are unchanged.

> **This is not an audit.** The results below come from automated tests, Slither and an internal review. An independent security audit has not been done.

## 1. Test results (all suites, run on the final code)

| Layer | Suites | Passed | Failed |
|---|---|---|---|
| Solidity (Foundry) | V1 rules, V2 unit + fuzz (512 runs), invariants (3 × 128 runs × 64 depth = 8,192 calls), resource limits | **60** | 0 |
| Node services | attendance 12, indexer 5, progress 5, trust 3 | **25** | 0 |
| Browser end to end | live (read-only, Base Sepolia) 91 · fork 32 · v2 33 · attend 41 · discover 27 · gamify 31 · trust 32 · a11y 19 · **journey 44** | **350** | 0 |
| **Total** | | **435** | **0** |

Also run: Slither (10 findings, 1 real bug fixed earlier; triage in the security model §4); reproducible-build check (a fresh clone with `npm ci` from the new lockfiles passes the Solidity and Node suites and builds byte-identical contracts, after turning off Forge's remapping auto-detection, which had made the metadata depend on which nested submodules were checked out); deploy rehearsal on a throwaway fork; env-file startup smoke test.

**Journey suite (new, `e2e/journey.test.js`):** one isolated fork, the indexer as a real `node server/indexer.js` process, and the attendance service in-process (so the clock can jump ten hours) and then restarted as a real process on the same database files. It runs all 12 journeys plus correction, revocation, both services restarting, persistence (attendance, encrypted profile, credential issuer key), an RPC outage on both services, and unauthorized attempts at every step.
- **Journey 2 ("registers"):** there is no shift sign-up in the product. A volunteer finds the shift, consents on-chain (opt-in) and their attendance starts at check-in.

## 2. Discovery-plan coverage

Source: *Gamified Volunteer SBT Discovery Plan* §5–§12, 88 requirements (M1–M12 plus cross-cutting X items), tracked row by row in [V2_REQUIREMENTS_MATRIX.md](V2_REQUIREMENTS_MATRIX.md).

| Status | All (88) | P1 (69) | P2 (19) |
|---|---|---|---|
| Implemented and tested (automated) | 38 (43%) | 31 (45%) | 7 |
| Implemented, no dedicated test (design properties, e.g. "no personal data on-chain") | 7 (8%) | 7 | 0 |
| Partially implemented | 25 (28%) | 21 | 4 |
| Blocked by external dependencies | 6 (7%) | 3 | 3 |
| Deferred or decided not to build (reason recorded) | 6 (7%) | 5 | 1 |
| Not implemented | 6 (7%) | 2 | 4 |

- **Headline figure:** 51% of all requirements (55% of P1) are fully implemented. Counting partial work it's 80% (86% of P1).
- **Deployment:** everything implemented is **local only**. **0%** of V2 is deployed, so **no real V2 badge exists on any public chain.**

| Area | Status | Evidence |
|---|---|---|
| Real SBT minting and verification | Local only: auto-mint, burn on correction, renounce/reclaim, ERC-5192/5484, no transfer path. **Not deployed** | F-V2, F-INV, E2E-V2, journey 5–7 |
| Cumulative volunteer hours | Tested (local): totals and per-area totals; only NGO issuance or approved V1 imports | F-V2, F-INV, journey 6 |
| QR attendance | Tested (local): rotating HMAC codes, ≤ 60 s, single check-in per wallet; QR or GPS alone issues nothing | S-ATT, E2E-ATT, journey 3 |
| NGO approval workflows | Tested (local): coordinator-only approval, evidence hash, receipt-verified "issued", batches ≤ 25 | S-ATT, E2E-ATT, journey 4–5 |
| Search and discovery | Partial: FTS search, area facets, paste-to-verify, directory tested. SDG/hours/city/accessibility/language facets need data; semantic matching not built | S-IDX, E2E-DISC, BENCH |
| Gamification, skill trees, leagues, guilds | Skill trees, levels, streaks, leagues tested. **Guilds not implemented** (deferred); Unsung Hero deferred | S-PROG, E2E-GAME |
| Auditor console | Tested (local): alerts as allegations, reproducible samples, cases, chain-confirmed suspension, evidence export. Multisig approval of dispute outcomes **blocked** | S-IDX, S-TRUST, E2E-TRUST, journey 11 |
| Open Badges 3.0 | Partial: VC-JWT + status list generated and verified locally. 1EdTech validator **blocked**; issuer key derived locally (KMS **blocked**); LinkedIn not built | S-TRUST, E2E-TRUST, journey 10 |
| Privacy and consent | Partial: opt-in, encrypted vault, crypto-shredding, per-field visibility tested. KMS and legal review (GDPR / UAE PDPL, DPIA) **blocked**. **No compliance claim** | S-TRUST, E2E-TRUST |
| University transcripts | Partial: printable transcript with QR to the live passport. CLR 2.0 format not built | E2E-TRUST, journey 12 |
| Indexing and synchronization | Tested (local): confirmation depth, reorg rollback and replay, restart catch-up | S-IDX, journey 8 + restart |
| Governance and multisig | Roles, pause, suspension tested; deploy script hands admin to a governance address (rehearsed). Safe multisig and timelock **blocked** (signers, approval) | F-V2, deploy rehearsal |

## 3. Incomplete features
- **Not implemented:** endorsements / skill graph (M3.4), PDF and JSON-LD exports (M3.6), semantic talent search (M5.4), grant / Form 990 pack (M6.6), dashboard presets (X6.3), high-contrast mode (X9.5).
- **Deferred (reason recorded):** guild quests (M4.4), Unsung Hero drops (M4.7), break-glass log (M7.5, auditors can't see private data), IPFS pinning (M8.5, M11.5: badge art is on-chain), EAS (M11.4, decided not now).
- **Blocked (external):** paymaster (M6.5, M12.5), Dollars-for-Doers (M6.7), multisig dispute approval (M7.3), NGO KYB (M9.1), Safe multisig + timelock (M12.2).
- **Partial, main gaps:**
  - **Identity and recovery:** embedded wallets and wallet recovery (M1.5).
  - **Badges:** mint-transaction links in the badge vault (M1.4).
  - **Records:** per-record proof drawer with transaction links (M3.3); full correction-trail view (M3.5); append-only attendance history (M2.6).
  - **Discovery:** distance and skills matching (M1.3); extra search facets (M5.2).
  - **Credentials and transcripts:** OB3 external validation and LinkedIn (M8.6); CLR 2.0 (M10.1).
  - **Privacy:** retention policy (M9.4, legal).
  - **Platform:** Postgres at scale (M11.2); "from cache" labels (M11.6); V2 org admin screens (M12.1); alert paging (M12.6); 6 of 8 dashboard tiles (X6.1).
  - **Language and mobile:** full Arabic and native review (X9.3); installable PWA (X9.4).

## 4. Remaining security findings (after this review)
Fixed in this review (each with a regression test):
1. **Batch issuance could exceed the per-transaction gas cap.** About 495k gas per volunteer when two badges mint, so a 100-person batch needs 49M gas, over the 16.7M EIP-7825 cap. Batches are now capped at 25 (12.4M).
2. **Starting without `ATTENDANCE_SECRET` used a random secret,** which would make stored profiles unreadable and credentials unverifiable after a restart. The service now refuses to start.
3. **The public credential status list did one chain read per issued credential per request** (cost amplification). It is now cached for 60 s, and verify reads only its own badge. Issuance also stops when the 131,072-entry list is full.
4. **League ranking did two chain reads per member per request,** and wallets can join for free. Member reads are now cached for 60 s.
5. *(earlier, Slither)* **V1 trails longer than 25 entries imported stale hours.**

Remaining (accepted or blocked, documented in [V2_SECURITY_MODEL.md](V2_SECURITY_MODEL.md)):
- **Low: oversized V1 trail.** A V1 issuer who corrects one record ~3,000 times can stop that record's V2 sync. Governance can revoke the V2 record in constant gas.
- **Low: `headOf` view.** It walks a record's V2 chain; breaking it for one record would take tens of thousands of corrections by that NGO.
- **Low: forwarded QR code.** A forwarded code works for 60 s; supervisor approval is the control.
- **Low: public `/metrics`.** Restrict it at the proxy.
- **Low: one-confirmation receipts.** "Issued" marking trusts a receipt after one confirmation.
- **Medium (production):**
  - Keys derive from one shared secret: KMS **blocked**.
  - SQLite with file permissions only.
  - No multisig or timelock yet: governance is a single key until one exists.
  - No CI.
  - No alert paging.
- **Not done:** independent audit, 1EdTech validation, manual screen-reader audit, legal review.

## 5. Local demo
```bash
anvil --fork-url https://base-sepolia-rpc.publicnode.com --chain-id 31337 --port 8546
cast rpc anvil_impersonateAccount 0x0000000000000000000000000000000050000001 --rpc-url http://127.0.0.1:8546
cast rpc anvil_setBalance 0x0000000000000000000000000000000050000001 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8546
SEED_DEMO=true forge script script/DeployV2.s.sol --rpc-url http://127.0.0.1:8546 --broadcast --unlocked --sender 0x0000000000000000000000000000000050000001
(cd server && npm ci)
export ATTENDANCE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
node server/attendance.js &      # 127.0.0.1:8790
node server/indexer.js &         # 127.0.0.1:8792
python -m http.server 8765 --directory docs   # open http://localhost:8765/?local
```
- **Signing transactions:** connect a wallet on chain 31337 using a throwaway local account (Anvil prints funded test accounts when started without `--silent`).
- **Fastest full walk-through:** `cd e2e && npm ci && node run.js journey` runs the whole journey with a visible log.

## 6. Environment and external services
- **Services:** variables listed in [`server/.env.example`](../server/.env.example).
  - **Required:** `ATTENDANCE_SECRET`.
  - **Chain:** `RPC_URL`, `CHAIN_ID`, `LEDGER`, `BADGES`.
  - **Attendance service:** `PORT`, `ATTENDANCE_DB`, `VAULT_KEYS_DB`, `PUBLIC_URL`.
  - **Indexer:** `INDEXER_DB`, `CONFIRMATIONS`, `START_BLOCK`, `POLL_MS`.
  - **Operations:** `RATE_LIMIT`, `LOG_REQUESTS`.
- **Deploy:** `GOVERNANCE`, `V1_ADDRESS` (defaults to live V1), and an encrypted Foundry keystore (`--account`). Never `SEED_DEMO` on public chains.
- **External services for staging:**
  - a Base Sepolia RPC;
  - a funded deployer keystore;
  - a governance address (a Safe multisig recommended);
  - HTTPS hosting for the two services;
  - a static host for the staging site;
  - source verification (Sourcify, Blockscout, BaseScan).
- **External services for production:**
  - **Key management:** a KMS.
  - **Governance:** a Safe multisig with timelock.
  - **NGO verification:** KYB / charity registry vendors.
  - **Optional vendors:** a paymaster and embedded wallets.
  - **Credentials:** the 1EdTech validator.
  - **Operations:** monitoring and paging.
  - **Assurance:** legal counsel (GDPR / UAE PDPL, DPIA) and an independent auditor.

## 7–8. Decisions

| Target | Decision | Why |
|---|---|---|
| **Local V2 demo** | **GO** | All 435 automated checks pass; the full journey runs with real services, restarts and failure cases |
| **Base Sepolia staging** | **CONDITIONAL GO** | Technically ready: tests green, build reproducible, deploy script rehearsed, env and rollback documented. It needs the approvals below, with **fictional data only** |
| **Production** | **NO-GO** | No independent audit; no multisig/timelock; keys not in a KMS; no KYB; no legal review or DPIA; no CI or paging; OB3 not externally validated; manual accessibility audit and Arabic review outstanding |

## 9. Approvals still required
1. **Deploy V2 to Base Sepolia:** broadcast public-chain transactions from a funded keystore, with the governance address you choose.
2. **Host the services:** run the attendance service and indexer on a public host, which may cost money.
3. **Publish the staging site:** a separate site or branch, not `main`.
4. **Push** `feature/gamified-v2` and the `v2.0.0-rc.1` tag to GitHub.
5. **Use external validators:** the 1EdTech OB3 validator and source verification services.

## 10. Next deployment steps (after approval)
1. Push the branch and tag. Have someone other than the author review the diff.
2. Create the governance Safe on Base Sepolia, confirm the signers, and fund the deployer keystore. You fund it; no key is ever shared.
3. `GOVERNANCE=<safe> forge script script/DeployV2.s.sol --rpc-url https://sepolia.base.org --broadcast --account <keystore>`. Record the transaction hashes from the receipts and verify the source.
4. From the Safe: register the fictional demo NGOs, assign their admins, grant the auditor role.
5. Host both services:
   - **Environment:** per [V2_DEPLOYMENT_PLAN.md](V2_DEPLOYMENT_PLAN.md) §staging: `CHAIN_ID=84532`, deployed addresses, `START_BLOCK` = deploy block, secret from a secret store.
   - **Checks:** confirm `/health` on both.
6. Point a staging copy of `config.js` at the addresses and service URLs.
7. Smoke test, then one owner-approved real write:
   - **Read-only run:** run the e2e V2 suite read-only against staging.
   - **First write:** one issuance to a disposable wallet.
   - **Confirm:** check the badge on BaseScan.
8. **Rollback** at any point:
   - **Front end:** set `config.js` back to `null`.
   - **Contracts:** pause through the Safe.
   - **V1:** keeps working throughout.
