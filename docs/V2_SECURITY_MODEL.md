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
| Signature replay | No signatures are used in Stage 1 (all consent is a direct transaction). Stage 2 QR tokens: HMAC + single-use nonce + expiry, validated server-side | Stage 2 tests |
| Wrong network / RPC lag in the UI | Three-state chain check, failover, fail-safe (no send if unverified) | e2e live/fork suites |
| Compromised NGO keys | Auditor suspension, governance pause, per-NGO daily cap limits the damage | tests above |
| Mock data shown as real | V2 screens show "not deployed" on networks without V2 | `E2E-V2 not deployed on Base Sepolia` |

## 3. Static analysis
- **Forge lint:** run. Findings triaged:
  - `unsafe-typecast`: `uint64(block.timestamp)` and `uint32(block.timestamp / 1 days)` can't truncate for millions of years.
  - `calls-loop`: only to our badge contract, ≤ 5 iterations.
  - `unsafe-oz-erc721-mint`: deliberate, to avoid receiver callbacks.
  - `reentrancy-events`: the only preceding external calls are V1 view calls.
  - `require-revert-in-loop`: deliberate, so batches are all-or-nothing.
  - `unused-return`: the trail is intentionally ignored.
  - `missing-events-access-control`: false positive; events are emitted.
- **Slither / Aderyn:** **Blocked.** They aren't installed in this environment, and installing them needs approval.

## 4. Privacy
- **On-chain:** wallet addresses, hours, category enums, event codes chosen by NGOs, NGO names, and evidence **hashes**.
  - Event codes and NGO names are public by design; NGOs must not put personal data in them, and the UI says so.
  - Pseudonymous addresses can still be linked to people by outside data. Volunteers who need separation should use a dedicated wallet.
- **Never on-chain:** names, emails, real student IDs, salts, raw GPS, sensitive affiliations.
- **No compliance claim.** GDPR and UAE PDPL compliance needs legal review and a DPIA (**Blocked: legal**).

## 5. Known limitations (Stage 1)
- **Wallet recovery:** not built yet (designed in the architecture doc, §3).
- **Multisig and timelock:** not set up. The deploy script supports handing admin to a multisig, but none exists yet.
- **NGO verification (KYB):** governance registers NGOs manually; KYB is Blocked on vendors.
- **Evidence hashes:** they hash the roster line until attendance capture (Stage 2) provides real evidence.
