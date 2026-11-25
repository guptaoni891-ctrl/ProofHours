# ProofHours V2: security model

The automated tests below are **not** a substitute for an independent audit. No V2 contract has been audited, and none is deployed to a public network.

## 1. Roles and permissions (enforced in `ProofHoursLedger` / `ProofHoursBadges`)

| Role | Holder | Can | Cannot |
|---|---|---|---|
| Governance (`DEFAULT_ADMIN_ROLE`) | Intended: Safe multisig (3-of-5) with timelock. Local: fixed deployer | Register NGOs and set their admins; set NGO daily caps; reinstate suspended NGOs; unpause; revoke any record after a dispute; grant or revoke auditor and pauser | Issue hours (it holds no coordinator mapping by default); edit records in place (append-only) |
| Auditor (`AUDITOR_ROLE`) | Independent auditor wallet | Suspend an NGO (fast containment) | Reinstate, unpause, issue, revoke records, grant roles |
| Pauser (`PAUSER_ROLE`) | Governance, optionally auditors | Pause issuance, correction and V1 approval | Unpause |
| NGO admin | Per NGO, set by governance | Add or remove coordinators **for its own NGO** | Take over another NGO's coordinator; register NGOs; grant AccessControl roles |
| Coordinator | Wallet mapped to one NGO | Create its NGO's events; issue (single or batch), correct and revoke its NGO's records; approve V1 links for V1 records **it** issued | Act for another NGO; act while its NGO is suspended or the ledger paused; edit imported V1 records; grant itself any role (coordinators hold no AccessControl role) |
| Volunteer | Any wallet | Opt in or out; request a V1 link; renounce or reclaim own badges | Give itself hours; receive hours without opting in |
| Badge minter (`MINTER_ROLE` on badges) | The ledger contract only | Mint and burn milestone badges | Anything else (no transfer path exists) |

Tests: `test/v2/ProofHoursV2.t.sol` (permission, cap, pause, suspension and migration tests); see the test matrix.

## 2. Threats and mitigations

| Threat | Mitigation | Evidence |
|---|---|---|
| Unauthorized issuance | Org-scoped coordinator check on every write; suspended NGO blocked; pause | `test_cannotIssueForAnotherNgosEvent`, `test_removedCoordinatorCannotIssue`, `test_auditorSuspends…`, `test_pauseStops…` |
| Privilege escalation by a coordinator | Coordinators are a mapping, not an AccessControl role; NGO admins can't move another NGO's coordinator | `test_coordinatorCannotGrantItselfAnyRole`, `test_orgAdminCannotTakeOver…` |
| Duplicate issuance | One record per (event, volunteer); V1 record importable once | `test_noDuplicatePerEventAndVolunteer`, `test_v1RecordCannotBeClaimedTwice` |
| Hour farming | 12h per service day (24 for Emergency); hours ≤ event max ≤ 24; no future service days; per-NGO daily cap | `test_dailyCap…`, `test_emergency…`, `test_cannotIssueForFutureService`, `test_orgDailyIssuanceCap` |
| Self-reported or fabricated progress | No write path except NGO issuance or NGO-approved V1 import with hours read from V1 | invariant suite; `test_v1MigrationNeeds…` |
| Stale badges after a correction or revocation | Badges reconciled on every total change; burned below threshold | `test_correctionBelowMilestoneBurns…`, `invariant_badgesMatchEligibility` |
| Badge transfer or sale | `_update` blocks every non-mint, non-burn path; `approve` and `setApprovalForAll` revert | `test_allTransferPathsRevert` |
| Reentrancy | Badges use `_mint` (no receiver callback); the only external calls are to our badge contract and **view** calls to V1 | design + lint triage |
| Overflow / underflow | Solidity 0.8 checked arithmetic; totals adjusted by exact old/new values | invariant suite |
| Signature replay | On-chain consent is a direct transaction. Attendance sign-in uses a one-time server nonce; QR codes are HMAC-bound to shift, kind and a 30 s window and expire within 60 s; each wallet checks in and out of a shift once | S-ATT sign-in and QR tests; E2E-ATT |
| Wrong network / RPC lag in the UI | Three-state chain check, failover, fail-safe (no send if unverified) | e2e live/fork suites |
| Compromised NGO keys | Auditor suspension, governance pause, per-NGO daily cap limits the damage | tests above |
| Mock data shown as real | V2 screens show "not deployed" on networks without V2 | `E2E-V2 not deployed on Base Sepolia` |

## 3. Attendance service (Stage 2)

| Threat | Mitigation | Evidence |
|---|---|---|
| Hours from a scan alone | The service cannot issue hours. Hours need a coordinator's approval **and** an `issueBatch` signed by that coordinator's wallet | S-ATT "QR and location alone issue nothing"; E2E-ATT chain checks |
| Forged or edited QR code | HMAC-SHA256 with a QR-only subkey of `ATTENDANCE_SECRET` (HKDF); editing the window or kind breaks the MAC; constant-time compare | S-ATT |
| Photo of the QR sent to someone absent | Code valid ≤ 60 s; one check-in per wallet; the **service** checks a location reading against the site area (a client's own yes/no is ignored); shifts with `requireSite` refuse check-in/out without an on-site reading; supervisor review. **Limit:** a spoofed GPS reading still passes, so supervisors should know their volunteers | S-ATT "requireSite" |
| Session theft or forgery | Ed25519-signed bearer token bound to the wallet and expiry; 2 h lifetime. Only the attendance service holds the signing key; the indexer verifies with the public key, so it can't mint sessions | S-ATT sign-in tests, S-IDX Stage 5 |
| Phishing relay of the sign-in signature | Sign-In with Ethereum (EIP-4361) message naming the front end's domain (wallets warn on a mismatch); only `APP_ORIGINS` can request one; the nonce is bound to one wallet and the exact message | S-ATT "Sign-In with Ethereum" |
| Wrong NGO approving | Coordinator's NGO read from the ledger on every shift, QR, review and approval call; suspended NGOs refused | S-ATT |
| Service marking hours issued that weren't | Marked only when the receipt has a matching `HoursIssued` (event, wallet, evidence hash) | S-ATT `issued` test; E2E-ATT |
| Guessing attendance times from the public evidence hash | Evidence JSON includes a random 128-bit salt | design |
| Location privacy | With the volunteer's consent, one reading is sent over TLS, compared with the site area and discarded; only the yes/no result is stored. Access logs never include bodies | S-ATT "requireSite" (database has no coordinates) |
| Abuse / flooding | Per-client rate limits; behind a proxy set `TRUST_PROXY=1` so the client is the proxy's last `X-Forwarded-For` hop, not one shared bucket | S-ATT rate-limit tests |
| Secret handling | `ATTENDANCE_SECRET` required (no random fallback). Every use has its own HKDF subkey: sessions, QR, vouchers, credential issuer, vault master | design |
| One volunteer blocking a shift's batch | `/issuable` checks each line against the chain (opt-in, existing record, daily cap, NGO cap) and holds back the ones that would revert, with a reason; approved rows can still be rejected | S-ATT "issuable: lines the ledger would refuse" |
| Double-counted time (voucher + QR) | Open check-ins count as running until closed; QR check-in refuses times already covered by a voucher | S-ATT "no double counting" |
| Clock skew | QR rotation is timed by the service's clock (it returns `now`), not the device's | E2E-ATT (service clock jumped 10 h) |
| Receipt finality | `CONFIRMATIONS` (default 3 on public chains, 1 locally) before attendance is marked issued; the app retries until then | S-ATT "issued: waits for confirmations" |

**Data held:** wallet addresses, check-in/out times, site yes/no flags, decisions, reasons typed by coordinators, evidence JSON, record ids and tx hashes. No names, emails or coordinates. A retention policy and erasure path belong to Stage 5 (consent vault) and need legal review.

### Indexer and search (Stage 3)
| Threat | Mitigation | Evidence |
|---|---|---|
| Searching for volunteers | Volunteer-related logs are never fetched; a partial wallet finds nothing | S-IDX "volunteer wallets are never indexed"; E2E-DISC |
| Search query injection | Input reduced to letters and digits, then quoted prefix terms; SQL uses bound parameters | S-IDX `ftsQuery` test |
| Stale or orphaned data after a reorg | Block-hash checks, rollback and replay; confirmation depth | S-IDX reorg test |
| Suspended NGO still advertised | Directory re-reads NGO status from the chain on every load and hides suspended NGOs | E2E-DISC |
| Trusting the index for verification | Verification (paste resolver, passports) reads the chain directly, never the index | design |
| Abuse | Read-only API on 127.0.0.1; **no rate limiting yet** | open |

### Progress and leagues (Stage 4)
| Threat | Mitigation | Evidence |
|---|---|---|
| Inflating progress | Every figure is computed from ledger data; no input path exists | S-PROG; E2E-GAME revocation lowers level, streak and Polymath |
| Being ranked without consent | Only wallets in the league table are ranked; joining needs a signed session and an on-chain opt-in; leaving deletes the row | S-ATT league test |
| Identifying league members | Generated aliases (no free text); wallets never in responses; only 3 above and 3 below returned | S-ATT; E2E-GAME |
| Showing renounced badges publicly | Renounced badges are shown to the holder only | design; E2E-GAME public passport has no vault controls |
| Estimates read as money | Impact Twin always labelled an estimate and "not money earned, paid or owed", with its source | E2E-GAME |

### Trust features (Stage 5)
| Threat | Mitigation | Evidence |
|---|---|---|
| Allegations treated as findings or acted on automatically | Alerts only list; cases need a person; suspension needs the auditor's own transaction; "NGO suspended" outcome checked against the chain | E2E-TRUST |
| Allegations leaking | Alert and sample views need an auditor wallet sign-in and `AUDITOR_ROLE` | S-IDX |
| Forged or altered credentials | EdDSA signature checked against **this deployment's** issuer key only (a key named in the token's header proves nothing); the status entry must be the credential's own (jti, holder, badge) | S-TRUST tamper and forgery tests; E2E-TRUST |
| A credential outliving its badge | Status list and verifier check that the badge is still held | S-TRUST, E2E-TRUST (correction revokes) |
| Profile data exposure | Encrypted at rest; private fields never served; link fields only with the share key (constant-time compare) | S-TRUST, E2E-TRUST |
| Data that should be gone surviving in backups | Crypto-shredding with keys in a separate database; `secure_delete` overwrites the destroyed key on disk. **Limit:** filesystem copies of SQLite's rollback journal and old backups of the key database need full-disk encryption / backup expiry | S-TRUST erasure tests |
| CSV formula injection in reports | Cells quoted; leading `= + - @` neutralised | code |
| Key management | **Shortcut:** issuer and vault master keys derived from `ATTENDANCE_SECRET`. Production needs a KMS/HSM (Blocked) | open |

### Readiness (Stage 6)
| Threat | Mitigation | Evidence |
|---|---|---|
| Request floods | Per-client fixed-window rate limits on both services (`429`, `Retry-After`) | S-ATT operations test |
| Script injection on the site | CSP: `script-src 'self'`, no inline scripts, `object-src 'none'`, `base-uri 'self'`; user-written text is escaped | E2E suites run with the CSP active |
| Secrets in logs | Access logs record method, path, status and time only | code review |
| Forged or reused offline vouchers | HMAC-tagged codes, single use (atomic update), 7-day window; redemption still needs approval | S-ATT voucher test |
| Leaked service secret | Rotation runbook (§5e); its knock-on effect on derived keys is why a KMS is required in production | runbooks |

## 4. Static analysis
- **Forge lint:** run. Findings triaged:
  - `unsafe-typecast`: `uint64(block.timestamp)` and `uint32(block.timestamp / 1 days)` can't truncate for millions of years.
  - `calls-loop`: only to our badge contract, ≤ 5 iterations.
  - `unsafe-oz-erc721-mint`: deliberate, to avoid receiver callbacks.
  - `reentrancy-events`: the only preceding external calls are V1 view calls.
  - `require-revert-in-loop`: deliberate, so batches are all-or-nothing.
  - `unused-return`: the trail is intentionally ignored (but see the Slither fix below).
  - `missing-events-access-control`: false positive; events are emitted.
- **Slither 0.11.6:** run on `src/v2/` (102 detectors; V1, libraries and tests excluded). 10 results, triaged:
  - **Fixed, real (`unused-return`):** importing or syncing a V1 record read `getEffectiveRecord`, which walks at most 25 entries (`MAX_TRAIL`). For a V1 record corrected 25+ times, V2 would have used a stale entry's hours. `_v1EffectiveHours` now continues from where V1 stopped. Regression test `test_v1ImportFollowsTrailsLongerThanV1PageSize` (31 entries) fails without the fix.
  - **Accepted (`calls-loop`, 3):** the calls go to our own immutable badge contract, set at deployment. A revert there should revert the whole batch. Batch gas is paid by the coordinator who sends it, so a big batch can't block anyone else.
  - **Accepted (`unused-return`, 2):** the ignored second value is the trail id list; only the head is needed.
  - **Accepted (`timestamp`):** compares calendar days (`block.timestamp / 1 days`); a few seconds of validator drift can't matter except within seconds of midnight UTC, where the result is still a valid day.
  - **Accepted (`costly-loop`, 3):** storage writes for new records and badges are the purpose of those loops.
  - **Nothing High.**
- **Aderyn:** **not run.** Cyfrin retired it, and its downloads were withdrawn (the official installer only prints a retirement notice). It is unmaintained, so it wasn't built from source.
- **Not a substitute for an audit:** static analysis catches known patterns only. An independent audit is still required before mainnet.

### Release-candidate review (resource limits and amplification)
Measured in `test/v2/ProofHoursV2.limits.t.sol` (gas) and the service tests:

| Loop or path | Who controls its size | Measured | Verdict |
|---|---|---|---|
| `issueBatch` over volunteers | The coordinator who sends (and pays for) it | ~495k gas per volunteer with two badge mints; 100 volunteers = 49M gas, over the 16.7M per-transaction cap (EIP-7825) | **Fixed:** batches capped at 25 (12.4M gas) in the attendance service (`MAX_BATCH`, the rest reported as `remaining`) and the manual roster. Tests: S-ATT "issuable: at most 25", F-V2 limits |
| `badges.sync`, `resyncBadges` | Fixed: 6 + 5 thresholds, 5 categories | constant | Bounded |
| V2 correction chain (`_head`) | The record's own NGO coordinators | `correct`/`revoke` take the head id and never walk the chain: 323k gas at entry 2 and at entry 303 | Bounded for writes. Only the `headOf` view walks (one storage read per entry): breaking it for one record would take tens of thousands of corrections by that NGO, and governance can still revoke. Test: F-V2 limits |
| V1 trail import (`_v1EffectiveHours`) | The V1 issuer of that record (V1 is immutable) | ~5.3k gas per V1 entry, so ~3,000 entries fill a transaction | **Residual (low):** a V1 issuer who corrects one record ~3,000 times can stop `syncV1`/`approveV1Link` for it, freezing that record's V2 hours. Governance can revoke the V2 record in constant gas. Test: F-V2 limits |
| Public credential status list | Anyone (public endpoint); size = issued credentials | was one chain read per credential per request | **Fixed:** list cached 60 s (may be up to 60 s stale; the verifier checks the single credential live). Issuance refuses once the 131,072-entry list is full, so no credential can sit outside it. Test: S-TRUST |
| League ranking | Members need at least one NGO-verified hour to join; at most 5,000 | was two chain reads per member per request | **Fixed:** one shared league snapshot per 60 s (concurrent requests share it, 8 reads at a time). Test: S-ATT leagues |
| Request bodies / search | Clients | 16 KB body limit; search ≤ 8 terms, ≤ 50 results, parameterised SQL | Bounded |

Other release-candidate findings:
- **Fixed (data loss):** without `ATTENDANCE_SECRET` the service used to start with a random secret. The vault master key and the credential issuer key derive from it, so a restart would have made stored profiles unreadable and earlier credentials unverifiable. It now refuses to start.
- **Fixed:** `/metrics` needs `METRICS_TOKEN` (bearer) or a direct loopback connection; proxied requests without `TRUST_PROXY` are refused.
- **Accepted (documented, §3):** a QR code forwarded to someone nearby works for up to 60 s; supervisor approval is the control.
- **Fixed:** the `issued` endpoint waits for `CONFIRMATIONS` before trusting a receipt.

## 5. Privacy
- **On-chain:** wallet addresses, hours, category enums, event codes chosen by NGOs, NGO names, and evidence **hashes**.
  - Event codes and NGO names are public by design; NGOs must not put personal data in them, and the UI says so.
  - Pseudonymous addresses can still be linked to people by outside data. Volunteers who need separation should use a dedicated wallet.
- **Never on-chain:** names, emails, real student IDs, salts, raw GPS, sensitive affiliations.
- **No compliance claim.** GDPR and UAE PDPL compliance needs legal review and a DPIA (**Blocked: legal**).

## 6. Known limitations
- **Wallet recovery:** not built yet (designed in the architecture doc, §3).
- **Multisig and timelock:** not set up. The deploy script supports handing admin to a multisig, but none exists yet.
- **NGO verification (KYB):** governance registers NGOs manually; KYB is Blocked on vendors.
- **Evidence hashes:** attendance-based issuance uses real attendance evidence; the manual roster on the V2 issuance page still hashes the roster line.
- **Attendance service:** local only; no forgotten-check-out flow (the coordinator can only reject); rows are updated in place rather than kept as an append-only log.
- **Static analysis:** Slither run and triaged (§4); Aderyn retired upstream. **No independent audit.**
- **Database access:** SQLite files protected only by the operating system's file permissions; no database users or roles. Restrict the data folders to the service account in staging.

## 7. Backend security review fixes (November 2026)
An adversarial review of the services and contracts found the issues below. Each fix has a regression test that fails without it.

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Credential verifier trusted the key named in the JWT header, so self-signed forgeries verified | Verify only with this deployment's issuer key; bind the status entry to the credential's jti, holder and badge | S-TRUST "verifier: …forger's own key", "…borrow another credential's status entry" |
| 2 | Anyone could overwrite a V1 link request and front-run the NGO's approval to steal migrated hours | Requests are per (record, wallet); `approveV1Link(v1Id, volunteer, category)` names the wallet the NGO checked | F-V2 `test_v1LinkCannotBeHijackedByFrontRunning`, `test_v1ApproveNeedsTheNamedWalletsOwnRequest` |
| 3 | One secret signed sessions and keyed everything, and the public indexer held it | Ed25519 sessions (indexer gets `SESSION_PUBLIC_KEY` only); HKDF subkey per purpose | S-ATT SIWE test, S-IDX Stage 5 |
| 4 | One opted-out/capped volunteer made every `issueBatch` for a shift revert, and approved rows couldn't be rejected | Chain pre-check in `/issuable` with `blocked` reasons; approved rows rejectable | S-ATT "issuable: lines the ledger would refuse" |
| 5 | Site check was a client-supplied yes/no | Server-side check of a location reading; optional `requireSite` | S-ATT "requireSite" |
| 6 | Rate limit keyed on the socket, so behind a proxy all users shared one bucket | `TRUST_PROXY=1` uses the proxy's last `X-Forwarded-For` hop; client map bounded | S-ATT "rate limit behind a trusted proxy" |
| 7 | Voucher + open QR check-in counted the same time twice | Open check-ins run until closed; QR check-in checks closed attendance too | S-ATT "no double counting" |
| 8 | Events could be dated any day in the past (even day 0), bypassing the 12 h/day cap | `serviceDay` must be within 90 days back / 366 ahead, never 0 | F-V2 `test_eventsCannotBeDatedOutsideTheWindow` |
| 9 | `syncV1` raised V2 hours while paused or suspended, outside caps; V1 coordinators could mint new V1 records and import them | Increases obey pause, suspension, opt-in and the NGO cap (imports too); only V1 records from before V2's deployment can be imported | F-V2 `test_v1SyncIncreaseObeysPause…`, `test_v1RecordsCreatedAfterV2DeployCannotBeImported` |
| 10 | Erased vault keys stayed in SQLite free pages | `PRAGMA secure_delete = ON` | S-TRUST "erasure: …overwritten on disk" |
| 11 | Sign-in message had no domain (phishable) | EIP-4361 with an origin allowlist (`APP_ORIGINS`) | S-ATT SIWE test |
| 12 | Cheap requests fanned out into unbounded RPC calls | League snapshot + entry ticket; status list scan shared and bounded; auth before chain reads; cached `/health` head | S-ATT leagues, S-TRUST status cache |
| 13 | Indexer rebuilt every table on every change, blocking its API | Incremental updates (full rebuild only after a reorg); reports are one indexed SQL query | S-IDX "incremental indexing gives exactly what a full rebuild gives" |
| 14 | Deploy-block search treated RPC errors as "no code", silently skipping history | Errors are fatal unless on a local fork; `START_BLOCK` required on public chains | S-IDX "findDeployBlock" |
| 15 | `issued` trusted one confirmation | `CONFIRMATIONS` before marking | S-ATT "issued: waits for confirmations" |
| 16–23 | `getEvent` "not found" never fired; `null`/non-object bodies, bad-checksum addresses and non-ASCII link keys gave 500s; case-close race; unsigned case export; opt-out ignored by V1 approval and upward corrections; auditor pause not wired in deploys; status-list off-by-one; public `/metrics`; voucher wording | Fixed individually (unknown events → 404; 400s; re-check after await; issuer-signed export; consent checks; `AUDITOR` env in `DeployV2`; capacity checked before insert; `METRICS_TOKEN`; wording) | S-ATT, S-TRUST, F-V2 regression tests |

**Still open (needs infrastructure or an audit, not code):** KMS/HSM for the issuer and vault keys; GPS spoofing (supervisor review remains the control); an independent audit before mainnet.
