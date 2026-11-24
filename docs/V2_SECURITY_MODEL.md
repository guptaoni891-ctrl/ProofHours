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
| Forged or edited QR code | HMAC-SHA256 with `ATTENDANCE_SECRET`; editing the window or kind breaks the MAC; constant-time compare | S-ATT |
| Photo of the QR sent to someone absent | Code valid ≤ 60 s; one check-in per wallet; optional site yes/no; supervisor review. **Limit:** someone nearby within 60 s can still check in a wallet they control, so supervisors should know their volunteers | design |
| Session theft or forgery | HMAC bearer token bound to the wallet and expiry; 2 h lifetime; nonce consumed on use | S-ATT sign-in tests |
| Wrong NGO approving | Coordinator's NGO read from the ledger on every shift, QR, review and approval call; suspended NGOs refused | S-ATT |
| Service marking hours issued that weren't | Marked only when the receipt has a matching `HoursIssued` (event, wallet, evidence hash) | S-ATT `issued` test; E2E-ATT |
| Guessing attendance times from the public evidence hash | Evidence JSON includes a random 128-bit salt | design |
| Location privacy | Only yes/no leaves the device; coordinates are never accepted or stored | S-ATT; E2E-ATT checks the database |
| Abuse / flooding | **Not mitigated yet:** no rate limiting. The service binds to 127.0.0.1. Add rate limits before any public hosting | open |
| Secret handling | `ATTENDANCE_SECRET` from the environment; if missing, a random per-process secret (sessions and codes end on restart) with a warning | design |
| Clock skew | QR rotation is timed by the service's clock (it returns `now`), not the device's | E2E-ATT (service clock jumped 10 h) |
| Receipt finality | **Shortcut:** one confirmation. On a public chain, wait for N confirmations (Stage 3 indexer) | open |

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

## 4. Static analysis
- **Forge lint:** run. Findings triaged:
  - `unsafe-typecast`: `uint64(block.timestamp)` and `uint32(block.timestamp / 1 days)` can't truncate for millions of years.
  - `calls-loop`: only to our badge contract, ≤ 5 iterations.
  - `unsafe-oz-erc721-mint`: deliberate, to avoid receiver callbacks.
  - `reentrancy-events`: the only preceding external calls are V1 view calls.
  - `require-revert-in-loop`: deliberate, so batches are all-or-nothing.
  - `unused-return`: the trail is intentionally ignored.
  - `missing-events-access-control`: false positive; events are emitted.
- **Slither / Aderyn:** **Blocked.** They aren't installed in this environment, and installing them needs approval.

## 5. Privacy
- **On-chain:** wallet addresses, hours, category enums, event codes chosen by NGOs, NGO names, and evidence **hashes**.
  - Event codes and NGO names are public by design; NGOs must not put personal data in them, and the UI says so.
  - Pseudonymous addresses can still be linked to people by outside data. Volunteers who need separation should use a dedicated wallet.
- **Never on-chain:** names, emails, real student IDs, salts, raw GPS, sensitive affiliations.
- **No compliance claim.** GDPR and UAE PDPL compliance needs legal review and a DPIA (**Blocked: legal**).

## 6. Known limitations (after Stage 2)
- **Wallet recovery:** not built yet (designed in the architecture doc, §3).
- **Multisig and timelock:** not set up. The deploy script supports handing admin to a multisig, but none exists yet.
- **NGO verification (KYB):** governance registers NGOs manually; KYB is Blocked on vendors.
- **Evidence hashes:** attendance-based issuance uses real attendance evidence; the manual roster on the V2 issuance page still hashes the roster line.
- **Attendance service:** local only; no rate limiting; no forgotten-check-out flow (the coordinator can only reject); rows are updated in place rather than kept as an append-only log.
