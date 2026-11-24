# ProofHours V2: implementation roadmap

Each stage ends in a working, tested, locally committed state. Requirement IDs refer to [V2_REQUIREMENTS_MATRIX.md](V2_REQUIREMENTS_MATRIX.md).

| Stage | Scope | Exit criteria | Status |
|---|---|---|---|
| **0. Baseline** | Commit the approved redesign and tested fixes; e2e suite; requirements, architecture, security, deployment and test docs | Clean tree; `main` and `v1.0.0` unchanged | **Done** (`8066689`, `58b3210`, this commit set) |
| **1. Core V2 identity and blockchain** | `ProofHoursLedger` + `ProofHoursBadges` (OpenZeppelin): wallet-linked opt-in, five impact areas, cumulative totals, caps, pause and suspension, org-scoped RBAC, batch issuance, append-only corrections and revocations, ERC-5192/5484 soulbound milestone badges with on-chain art, consent-based V1 migration and V1 sync; deploy script; passport and V2 issuance screens | Foundry unit + fuzz + invariant green; V2 e2e on fork green with real signatures; V1 regression green | **Done (local chain)**. Base Sepolia deployment needs approval |
| **2. Event operations and attendance** | Shifts (scheduled start/end, capacity); rotating HMAC-QR check-in/out with nonces and expiry; optional consented geofence boolean; pending queue; supervisor approve/reject; computed durations; overlap detection; batch issuance from approved attendance; evidence hashes from attendance logs; unified role pill (V1 + V2 roles) | Replay and expiry tests; QR or GPS alone never issues hours; overlaps rejected; e2e QR → approve → issue → badge | **Done (local)**. Runs on Node's built-in SQLite with no Docker; Postgres and Docker Compose move to Stage 3 with the indexer |
| **3. Backend, indexing and discovery** | Docker Compose: Postgres, Meilisearch, API, indexer; reorg-safe indexer; API; search sync; Cmd+K omni-search with facets; opportunity directory; paste-to-verify resolver; EAS decision; IPFS adapter | Reorg replay test; measured search latency (p50/p95); private profiles never indexed | **Done (local)**. SQLite FTS5 instead of Postgres + Meilisearch (no Docker needed); EAS decided against for now; IPFS deferred to Stage 5. Not typo-tolerant |
| **4. Full gamification** | Trophy Vault interactions (renounce/reclaim UI, unlock animation, reduced motion); skill trees; civic levels/XP; streaks and freezes; opt-in 30-person leagues with resets and near-me strip; guilds and co-op quests; Impact Companion; Unsung Hero; Polymath tier; Impact Twin (labelled estimates) | Progress derives only from verified data; opt-out respected | Next |
| **5. Institutional trust and interoperability** | Auditor console (anomaly rules, spot-audit sampling, evidence queue, disputes, suspension and revocation proposals); NGO verification workflow with registry adapters (Blocked for real vendors); Open Badges 3.0 / VC issuance and validation; transcripts (PDF + QR); NGO, ESG and CSR reports; consent and selective disclosure; encrypted profile vault and erasure | OB3 validator passes; alerts require human review; erasure test | Planned |
| **6. Advanced infrastructure and readiness** | Offline vouchers; embedded/passkey wallets and recovery; paymaster with selector allowlist and spend caps (Blocked: vendor); Safe multisig + timelock (Blocked: signers, approval); Arabic RTL; full accessibility audit; monitoring; load tests; security hardening, static analysers (Blocked: install approval) | WCAG audit; load-test report; runbooks | Planned |

## Dependencies outside engineering (Blocked until resolved)
- **Approvals:** for Base Sepolia deployment, pushes and merges.
- **Multisig:** signer set and a Safe deployment.
- **Vendor accounts:** paymaster, KYB/registry APIs (CharityAPI, Candid, Sumsub, Dubai CDA/IACAD), optional managed IPFS and search.
- **Legal:** GDPR / UAE PDPL review and DPIA; fundraising-law check for corporate grant features.
- **Partners:** export formats for Volunteers.ae and LMS systems.
- **Tooling:** approval to install static analysers and the MetaMask extension for automated wallet tests.
