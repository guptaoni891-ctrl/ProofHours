# ProofHours V2: requirements traceability matrix

Source: *Gamified Volunteer SBT Discovery Plan* ("CivicQuest", 85 pages). Product requirements come from §5 (feature catalogue M1–M12), §6 (dashboard and verifier), §7 (gamification), §8 (blockchain, SBT, privacy), §9 (search, UX, accessibility), §11 (architecture) and §12 (security and governance).

**Statuses:**
- **Not Started**
- **In Progress:** part of the requirement is built.
- **Implemented:** code exists.
- **Tested:** automated tests pass.
- **Blocked:** needs something outside engineering, such as approval, an account, a partner or legal review.

**"Local chain":** verified on an isolated Anvil fork of Base Sepolia. Nothing in V2 is deployed to a public network yet.

**Stage numbers** refer to [V2_IMPLEMENTATION_ROADMAP.md](V2_IMPLEMENTATION_ROADMAP.md). **Test IDs** refer to [V2_TEST_MATRIX.md](V2_TEST_MATRIX.md).

**Reuse key:**
- **V1** = `VolunteerHours` + current site.
- **L** = `ProofHoursLedger`.
- **B** = `ProofHoursBadges`.
- **FE** = `docs/` front end.

## Not product requirements (tracked, not built)

| Plan section | Content | Treatment |
|---|---|---|
| §1–2 | Problem research, statistics, root-cause analysis, hypotheses H1–H5 | Context only. H1–H5 need field pilots, not code. |
| §3 | 25-question discovery interview map | Research instrument; no software. |
| §4 | Stakeholder and empathy maps | Informs roles in §12; no software. |
| §10 | Cost-to-solve and unit economics | Estimates; never shown as product data. |
| §13 | Self-review, pitch and hackathon plan | Strategy; its build order informs the roadmap. |
| Part I | Master prompt for another AI | Not applicable. |

## M1: Gamified volunteer command hub

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M1.1 | Impact XP and hero strip: verified lifetime hours, civic level, streak with freeze shields, badge count | P1 | V1 My Impact; L totals | Passport progress strip: civic level with progress bar, weekly streak, freeze shields, Polymath, Impact Twin ✓ | None needed: computed in the page from the ledger's latest entries (`docs/progress.js`) | L `totalHours`, `categoryHours`, `headOf` ✓ | none | none | Level curve and streak rules unit-tested ✓ (S-PROG); E2E-GAME level 4 / streak 4 wk / shield, and all drop after a revocation ✓ | Tested (local) |
| M1.2 | Next-milestone quest bar, exact hours to the next automated mint | P1 | V1 My Impact bar | Passport total milestone bar and per-area bars ✓ | none | B thresholds ✓ | none | none | E2E-L My Impact 50%, E2E-V2 milestone ✓ | Tested |
| M1.3 | Active mission and shift feed matched by category, distance, skills | P1 | none | Opportunities page: upcoming shifts with area facets, NGO filter, spots left ✓ | Attendance service `GET /opportunities` (public, no attendee data) ✓ | none | Shift DB | M2, M5 | Feed shows only open, real shifts ✓ (ended shifts and suspended NGOs left out; E2E-DISC); distance and skills matching not built | In Progress |
| M1.4 | Badge unlock vault: real SBTs, art, mint tx, share | P1 | none | Real tokens and on-chain art ✓; unlock animation once per badge per browser (off with reduced motion) ✓; "Copy public link" ✓ | none | B `tokenOfKey`, `tokenURI` ✓ | none | M8.2 | E2E-GAME: 5 badges animate on first view only ✓. Mint-transaction link not shown (needs the indexer to track badge mints) | In Progress |
| M1.5 | Wallet-linked volunteer identity | P1 | none | Passport tied to the connected wallet ✓ | Smart-account and passkey adapters (Stage 6) | L `optIn` ✓, V1 linking ✓ | none | none | F-V2 opt-in tests ✓, E2E-V2 ✓ | In Progress |
| M1.6 | Impact Companion avatar grows with verified hours (§7, App. A #1) | P1 | none | Five-stage plant (Seed → Grove keeper) by civic level, Arcade view only ✓ | none | none | none | M1.1 | Grows only from verified hours ✓ (S-PROG, E2E-GAME) | Tested (local) |
| M1.7 | Loading, empty and error states | P1 | Design system | Every V2 screen has honest empty, loading and not-deployed states ✓ | none | none | none | none | E2E-V2 "not deployed on Base Sepolia" ✓ | Tested |

## M2: Proof-of-service and attendance

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M2.1 | Rotating HMAC-QR check-in/out (~90 s), single-use nonce, replay protection | P1 | none | Coordinator QR panel (rotates every 30 s, by service clock) ✓; volunteer check-in page opened by the phone camera ✓ | HMAC-SHA256 tokens bound to shift, kind and 30 s window, accepted ≤ 60 s; one check-in and one check-out per wallet per shift (DB unique) ✓ | none | `ATTENDANCE_SECRET` (env) | none | Forged, edited-window, wrong-kind, expired and replayed codes refused ✓ (S-ATT, E2E-ATT) | Tested (local) |
| M2.2 | Optional geofence: on-device Haversine, store only a boolean, explicit consent | P1 | none | Unticked consent box; Haversine on the device; only yes/no sent ✓ | Stores `in_site`/`out_site` as 1/0/null; non-booleans stored as null; coordinates never accepted ✓ | none | Site area per shift (public event site) | M2.1 | No coordinates stored ✓; refusal path (untick) ✓; client-reported, so informational only | Tested (local) |
| M2.3 | Supervisor quick-approve queue, approved duration, batch sign | P1 | L `issueBatch` ✓ | Review table with Approve/Reject; "Issue approved hours on-chain" sends one `issueBatch` from the coordinator's wallet ✓ | Whole hours inside the shift window, capped at the event maximum; evidence JSON (salted) + keccak256 hash; receipt verified before marking issued ✓ | L `issueBatch` ✓ | Check-in/out logs (SQLite) | M2.1 | QR + location alone issue nothing ✓; approval by the NGO's coordinator only ✓; on-chain evidence hash = attendance evidence ✓ (S-ATT, E2E-ATT) | Tested (local) |
| M2.4 | Double check-in and overlapping-shift prevention | P1 | L daily cap ✓ | Clear refusal messages ✓ | No check-in while checked in elsewhere; one attendance per wallet per shift and per event ✓ | L 12h/day cap ✓ | Shift times | M2.1 | Overlap and double check-in rejected ✓; cap enforced ✓ | Tested (local) |
| M2.5 | Offline paper-to-chain voucher (QR/SMS scratch codes, Merkle root) | P2 | none | Redeem screen | Voucher signing, Merkle batches | Optional Merkle redemption | SMS gateway (vendor) | Stage 6 | Voucher single-use, tamper-evident | Not Started |
| M2.6 | Attendance audit trail | P1 | L events ✓ | Volunteer sees own attendance and status ✓ | Attendance rows keep times, site flags, decision, approver, evidence, record id and tx hash ✓ | `evidenceHash` field ✓ | none | M2.1 | Every attendance-issued hour links to its evidence ✓; append-only history log not yet (rows are updated in place) | In Progress |

## M3: Volunteer Impact 360 and public passport

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M3.1 | Shareable public passport: lifetime hours by area, issuers, SBTs | P1 | Passport ✓ | Public read-only view at `#passport=0x…` (from search or a pasted wallet): totals, badges, records; no opt-in or V1-link forms ✓ | Optional profile handle (opt-in) not built | L, B views ✓ | none | M9.3 consent | Shows only public on-chain data ✓ (E2E-DISC); handles and per-category disclosure need M9.3 | In Progress |
| M3.2 | Dual-mode toggle: Arcade and Verifier Clean | P1 | V1 print report ✓ | Passport Arcade/Clean toggle, remembered per browser; public passports open in Clean ✓ | none | none | none | none | Same verified data in both modes ✓ (E2E-GAME) | Tested (local) |
| M3.3 | One-click proof drawer: issuer, timestamp, explorer link, status | P1 | V1 verify evidence ✓ | V2 per-record drawer with tx link | Indexer supplies tx hashes | L events ✓ | none | M11 | Every hour and badge links to its tx | In Progress |
| M3.4 | Endorsements and skill graph co-signed by supervisors | P2 | none | Skill tags | Signed endorsements | Optional | OB3 skill assertions | M8.2 | Endorsement verifies to the NGO signer | Not Started |
| M3.5 | Correction and revocation history | P1 | V1 trail ✓; L chain ✓ | Passport shows latest entry and reason ✓; full trail view to add | none | L `supersededBy` / `replacesId` ✓ | none | none | Corrections update totals ✓ (F-V2) | In Progress |
| M3.6 | PDF and structured-data exports | P2 | none | Export buttons | PDF and JSON-LD generator | none | none | M10, M8.2 | Export matches on-chain state | Not Started |

## M4: Gamification, quests and leagues

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M4.1 | Skill trees: Environmental, Education, Healthcare, Emergency, Inclusion; tiers 10/50/100/250/500 | P1 | B category badges ✓ | Tree per area with reached tiers ✓ | none | B category milestones ✓ | none | none | Tiers follow verified hours, including after a revocation ✓ (S-PROG, E2E-GAME) | Tested (local) |
| M4.2 | 30-person opt-in cohort leagues, seasonal resets, fair grouping, private opt-out | P1 | none | League panel on your own passport (Arcade view), join and leave ✓ | Service: opt-in table; generated aliases; cohorts of ≤30 within lifetime-hours bands; monthly seasons scored on verified hours served that month ✓ | none | Opt-in record (wallet, alias, join time) | M9.3 | Non-members never ranked; leaving removes you everywhere; no wallets in responses ✓ (S-ATT, E2E-GAME) | Tested (local) |
| M4.3 | Near-me rival strip (3 above, 3 below) | P1 | none | Strip with ranks, aliases, hours, "you" marked ✓ | Only the 3 above and 3 below are returned ✓ | none | none | M4.2 | Never shows full lists ✓ (S-ATT) | Tested (local) |
| M4.4 | Co-op guild and campus quests; collective milestone art | P1 | none | none | none | Optional group SBT | none | M9.3 | Only verified member hours count | **Deferred** to Stage 5: guild membership needs a consent store (the consent vault) before members' hours can be pooled |
| M4.5 | Impact Twin factual equivalents, clearly labelled estimates | P1 | none | Card: hours × US$36.14/h, labelled "estimate", "not money earned, paid or owed", with source link ✓ | none | none | Independent Sector 2025 national value of a volunteer hour (configurable in `config.js` → `impactRate`) | none | Always labelled an estimate, never a payment ✓ (E2E-GAME). Physical equivalents (trees planted etc.) not added: no sourced per-area rates | In Progress |
| M4.6 | Streak Freeze shields | P1 | none | Streak and shields on the progress strip ✓ | Weekly rule: active week = verified service that week; a shield every 4th consecutive active week (max 2); a missed week uses one ✓ | none | none | M1.1 | Freeze rules deterministic and order-independent ✓ (S-PROG) | Tested (local) |
| M4.7 | Unsung Hero cosmetic drops (surprise, arcade only) | P1 | none | none | none | none | none | M2 | Cosmetic only, no hours | **Deferred:** needs eligibility signals (hard-to-fill shifts) from more attendance history |
| M4.8 | Anti-hour-farming: 12h/day cap with emergency override, Polymath prestige, supervisor-signed upper tiers | P1 | none | Refusal messages ✓; Polymath title (3 areas at 10h+; II at 5) ✓ | Polymath computed from verified category hours ✓ | L `DAILY_CAP`, `EMERGENCY_DAILY_CAP` ✓, per-NGO cap ✓ | none | M3.4 (upper tiers) | Cap enforced in contract ✓; Polymath follows revocations ✓ (E2E-GAME). Polymath is a computed title, not an on-chain badge; supervisor-signed tiers need M3.4 | In Progress |
| M4.9 | Competition optional; gamification can't be advanced with fabricated hours | P1 | none | Leagues opt-in; Clean view hides all game elements ✓ | none | Totals only from NGO issuance or approved V1 imports ✓ | none | none | No self-reported path ✓ (F-V2); every progress figure derives from ledger data ✓ (S-PROG, E2E-GAME revocation test) | Tested (local) |

## M5: Search and discovery

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M5.1 | Global Cmd/Ctrl+K omni-search: opportunities, verified NGOs, opted-in volunteers, badges, credentials; typo-tolerant; <50 ms target | P1 | none | Command palette (Ctrl/Cmd+K, top-bar button, arrow keys, Esc) ✓ | Indexer search API on SQLite FTS5: NGOs and events, prefix matching, ranked ✓ | none | none (Meilisearch deferred, see architecture §4) | M11 | Benchmarked ✓: 1,000 events: p50 0.4 ms / p95 1.2 ms; 10,000: p50 2.7 ms / p95 3.7 ms; 100,000: p50 28.8 ms / p95 38.1 ms (server query time, localhost, Ryzen 7 7800X3D, Node 26). Volunteers deliberately not searchable (no profile consent exists yet) ✓. **Not typo-tolerant** (FTS5 matches prefixes only) | In Progress |
| M5.2 | Facets: impact area, SDG, verified-hours slider, city/remote, accessibility, EN/AR | P1 | none | Impact-area facet chips with counts (search and directory), NGO filter, spots-left filter ✓ | Facet counts per text match ✓ | none | Opportunity schema | M5.1 | Facet counts correct ✓ (S-IDX, E2E-DISC). SDG, hours slider, city/remote, accessibility, language: no data for them yet | In Progress |
| M5.3 | Paste-to-verify resolver: wallet, handle, badge id or URL, with non-revocation check | P1 | V1 verify by ID + salt ✓ | In the palette: wallet, tx hash, `record N`, `badge N`, V1 verification links, check-in and passport links, all read from the chain ✓ | none needed | B `ownerOf` / `locked` ✓ | none | M5.1 | Revoked records show "Revoked"; burned badges show "not held" ✓ (E2E-DISC). Handles need M3.1 | Tested (local) |
| M5.4 | Hybrid semantic skill matching (opt-in talent) | P2 | none | NL query | Meilisearch hybrid / embeddings | none | Embedding model | M5.1, M9.3 | Only opted-in profiles | Not Started |

## M6: NGO operations cockpit

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M6.1 | Batch hour issuance with automatic SBT mint | P1 | none | V2 issuance roster (multi-line = one batch) ✓ | none | L `issueBatch` ✓, auto mint ✓ | none | none | All-or-nothing batch ✓ (F-V2); E2E-V2 issuance ✓ | Tested |
| M6.2 | Event management with category and service date | P1 | V1 events | V2 event form ✓ | none | L `createEvent` ✓ | none | none | E2E-V2 create event ✓ | Tested |
| M6.3 | Shift scheduling, roster, QR management, approval queue | P1 | none | Attendance page: create shift (times, capacity, optional site area), shift list, QR panel, review queue ✓ | Shift and attendance tables; capacity; check-in window (30 min early) and check-out window (2 h late) ✓ | none | none | M2 | Shift lifecycle tests ✓ (S-ATT, E2E-ATT); recurring shifts and roster import not built | In Progress |
| M6.4 | Transaction previews and explicit progress | P1 | V1 pre-check ✓ | Dry-run before the wallet opens, receipt summaries ✓ | none | none | none | none | E2E-V2 refusals before signing ✓ | Tested |
| M6.5 | Gas sponsorship (paymaster) | P1 | none | Gasless send | Paymaster integration | Selector allowlist | Pimlico / Coinbase paymaster (vendor) | Stage 6 | Spend caps enforced | Blocked (vendor account) |
| M6.6 | Grant and Form 990 report pack | P2 | none | Export | Report generator | none | none | M10 | Values labelled estimates | Not Started |
| M6.7 | Corporate "Dollars for Doers" eligibility packet | P2 | none | Claim packet | Employer directory | none | Grant directory (vendor) | M10 | Never claims a grant is earned | Blocked (directory data, legal) |
| M6.8 | NGO activity and performance reporting | P2 | none | Dashboard | Aggregates | none | none | M11 | Matches chain | Not Started |
| M6.9 | Strict NGO-specific permissions | P1 | none | none | none | L org scoping ✓ | none | none | Other NGO can't issue, correct or revoke ✓ (F-V2) | Tested |

## M7: Auditor and compliance console

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M7.1 | Anomaly radar: >12h/day, overlapping shifts, issuance spikes, large one-time issuance; alerts are allegations | P1 | L caps ✓ (preventive) | Console with a quarantine queue | Rule engine over indexed data | none | none | M11 | Alert never auto-penalises; review required | Not Started |
| M7.2 | Random 2–5% spot-audit sampling, evidence queue | P2 | none | Queue | Sampler, evidence links | none | none | M2, M11 | Sample reproducible | Not Started |
| M7.3 | Disputes, NGO suspension and credential revocation proposals, multisig approval | P2 | none | Dispute workflow | Case records | L `suspendOrg` (auditor) ✓, governance-only `reinstateOrg` / `unpause` / revoke ✓ | Safe multisig | M12.2 | Auditor can't reinstate or unpause ✓ (F-V2) | In Progress |
| M7.4 | Dedicated auditor role | P1 | none | Console access | none | L `AUDITOR_ROLE` ✓ | none | none | F-V2 ✓ | Implemented |
| M7.5 | Break-glass access log with typed justification (App. A #29) | P2 | none | Justification prompt | Immutable access log | none | none | M9 | Every restricted view logged | Not Started |

## M8: Soulbound token system

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M8.1 | Milestone auto-mint: totals 10/25/50/100/250/500, categories 10/50/100/250/500, ERC-5192 locked, ERC-165 ids, no transfer path, duplicate prevention | P1 | none | Trophy Vault ✓ | none | B ✓ | none | none | F-V2: interfaces, every transfer path reverts, 500h mints all, invariant: badge ⇔ eligibility ✓ | Tested (local chain); Base Sepolia deployment Blocked (approval) |
| M8.2 | Correction and revocation lifecycle: burn when hours fall below, re-mint on re-cross | P1 | none | Vault updates ✓ | none | B `_reconcile` ✓ | none | none | F-V2, E2E-V2 burn after correction ✓ | Tested (local chain) |
| M8.3 | ERC-5484 consensual: `burnAuth` = Both, consent before mint, holder renounce/reclaim | P1 | none | Renounce (with confirmation) and Reclaim in the vault; reclaim re-mints via `resyncBadges` ✓ | none | B `burnAuth`, `renounce`, `reclaim`; L `optIn`, `resyncBadges` ✓ | none | none | F-V2 ✓; E2E-GAME renounce burns, reclaim re-mints, hours unchanged ✓ | Tested (local) |
| M8.4 | Dynamic evolving badge artwork | P1 | none | Vault renders on-chain SVG ✓ | none | B on-chain JSON + SVG (tier ring) ✓ | none | none | F-V2 `tokenURI` decodes ✓ | Tested |
| M8.5 | Pinned immutable assets (IPFS) | P1 | none | none | none | none | none | Stage 5 | CID stable | **Deferred:** nothing needs pinning yet (badge art is generated on-chain). Built with OB3 evidence in Stage 5 |
| M8.6 | Open Badges 3.0 / W3C VC 2.0 credential generation and validation, Status List, LinkedIn sharing | P2 | none | Export and share | Issuer key (KMS) / DID, signer, status list | none | 1EdTech validator | Stage 5 | OB3 validates; revocation reflected | Not Started |

## M9: Risk, privacy and regulatory tools

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M9.1 | NGO KYB and charity-registry gate before issuer role | P2 | L `registerOrg` (governance) ✓ | Verification workflow | Registry adapters | none | CharityAPI, Candid, Sumsub, CDA/IACAD | Stage 5 | Unverified NGO can't get issuer rights | Blocked (vendor accounts, legal) |
| M9.2 | Encrypted off-chain identity vault, erasure (crypto-shredding), unlinking | P2 | none | Account settings | Encrypted Postgres, per-user keys (KMS) | none | KMS | Stage 5 | After erasure, PII unrecoverable; chain holds none | Not Started |
| M9.3 | Consent and selective disclosure: Public / Link-only / Private per category | P2 | L opt-in ✓ | Disclosure matrix | Profile visibility | none | none | M3.1 | Private data never served | In Progress |
| M9.4 | Data retention, restricted access, auditor access logs, key management | P2 | none | none | Policies, logs | none | KMS | M9.2 | Tests per policy | Not Started |
| M9.5 | No personal data on-chain | P1 | V1 commitments ✓ | none | none | L stores only addresses, hours, hashes ✓ | none | none | Code review ✓; see security model | Implemented |

Compliance claims: none. GDPR and UAE PDPL compliance needs legal review and a DPIA, which are **Blocked (legal)**.

## M10: Reports, transcripts and CSR

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M10.1 | University co-curricular transcript: PDF with QR and verification reference (CLR 2.0) | P2 | V1 print report ✓ | Transcript view | PDF generator | none | none | M11 | QR resolves to live verification | In Progress (V1 print only) |
| M10.2 | NGO, ESG and CSR impact packs by category, period and NGO | P2 | none | Reports | Aggregates | none | none | M11 | Totals match chain | Not Started |
| M10.3 | Benchmark civic-value figures, always labelled estimates | P2 | none | Labels | Configurable rates | none | none | none | Never presented as money earned | Not Started |
| M10.4 | Exportable audit evidence | P2 | none | Export | Evidence bundles | none | none | M7 | Bundle hashes verify | Not Started |

## M11: Data and indexing

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M11.1 | Event indexer with reorg handling and confirmation depth | P1 | V1 view reads | none | `server/indexer.js`: confirmation depth, stored block hashes, rollback to the last matching hash and replay; finds the deploy block ✓ | L events ✓ | SQLite | Stage 3 | Reorg replay test on a real chain ✓ (S-IDX); full reindex = delete the database | Tested (local) |
| M11.2 | Durable storage and backend APIs | P1 | none | API clients in the page ✓ | Attendance REST API ✓; read-only search API ✓ | none | SQLite files (`server/data/`) | Stage 3 | API tests ✓ (S-ATT, S-IDX) | In Progress (Postgres when the limits in architecture §4 are reached) |
| M11.3 | Search synchronisation | P1 | none | none | The index is rebuilt from indexed logs whenever they change, so it follows reorgs ✓ | none | SQLite FTS5 | M5 | Index reflects the chain within the confirmation depth ✓ (S-IDX) | Tested (local) |
| M11.4 | EAS integration where justified | P1 | none | none | none | none | EAS on Base | Stage 3 | Decision recorded ✓ (architecture §4: not now; the ledger already is the attestation registry) | **Decided: not now** |
| M11.5 | Content-addressed storage adapter | P1 | none | none | none | none | IPFS | Stage 5 | CID round trip | **Deferred** to Stage 5 (no content needs it yet; see M8.5) |
| M11.6 | Blockchain truth separate from cached views | P1 | FE reads chain directly ✓ | "From cache" labels | Cache marked derived | none | none | M11.1 | UI distinguishes cached data | In Progress |
| M11.7 | V1 read-only compatibility | P1 | V1 ✓ | V1 screens unchanged ✓ | none | L reads V1 via interface ✓ | none | none | E2E-L 91/91, F-V2 V1 migration ✓ | Tested |

## M12: Governance and administration

| ID | Requirement | Pri | Reuse | Front end | Backend | Contract | Data / integrations | Depends on | Acceptance tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| M12.1 | RBAC: volunteer, coordinator, NGO admin, auditor, governance | P1 | V1 admin/coordinator | One top-bar role pill for V1 + V2 roles (e.g. "V2 COORDINATOR: …", "V2 VOLUNTEER") ✓; admin screens for V2 orgs to add | Attendance service re-checks the coordinator's NGO on-chain on every action ✓ | L roles ✓ | none | none | F-V2 permission tests ✓; S-ATT role tests ✓; E2E-ATT pill ✓ | In Progress (V2 admin UI) |
| M12.2 | Multisig governance (Safe 3-of-5) with timelock | P1 | none | none | none | Governance handover in the deploy script ✓; timelock to add | Safe | Approval | Admin role held by the multisig on deploy | Blocked (multisig signers, approval) |
| M12.3 | Coordinator can never grant itself admin or auditor | P1 | none | none | none | Coordinators hold no AccessControl role ✓ | none | none | F-V2 ✓ | Tested |
| M12.4 | Emergency pause; issuance limits; issuer suspension | P1 | none | Status shown in issuance context ✓ | none | L `pause` / `unpause`, org daily cap, `suspendOrg` ✓ | none | none | F-V2 ✓ | Tested |
| M12.5 | Paymaster spend limits and selector allowlist | P1 | none | none | Paymaster policy | none | Paymaster vendor | M6.5 | Disallowed selector refused | Blocked (vendor) |
| M12.6 | Security monitoring, audit logging, configuration management | P1 | none | none | Monitors, alerts | Events ✓ | none | M11 | Alert fires on test anomaly | Not Started |
| M12.7 | Protected upgrade and versioning | P1 | none | none | none | Contracts are immutable; new versions deploy side by side (V1 untouched) ✓ | none | none | Documented in the deployment plan | Implemented |

## §6 Dashboard, §7 gamification, §9 UX: cross-cutting requirements

| ID | Requirement | Pri | Status |
|---|---|---|---|
| X6.1 | Eight tiles: verified hours ✓, badges ✓, primary pillar, civic value (estimate), streak, league tier (hidden in verifier mode), NGOs served, integrity status | P1 | In Progress (2 of 8) |
| X6.2 | Drill-down proof drawer from any tile, badge or log | P1 | In Progress (V1 verify) |
| X6.3 | Presets: Volunteer Arcade, Institutional Verifier, NGO Coordinator, Auditor Forensic | P1 | Not Started |
| X6.4 | Deliberately excluded: tradable NFTs, global all-time leaderboards, unverified hours in totals, strobing animation | P1 | Implemented (none exist; badges are soulbound) |
| X7.1 | No monetary or tradable rewards | P1 | Implemented |
| X7.2 | Endowed progress (start partway to "First Spark") | P1 | Tested (local): First Spark quest where opting in is a real first step (1 of 3 done), so no fabricated progress |
| X9.1 | WCAG 2.2 AA contrast, 24×24 px targets (44 px on touch), visible focus | P1 | In Progress (tokens ≥ 4.5:1, focus rings ✓; a full axe audit is outstanding) |
| X9.2 | `prefers-reduced-motion` | P1 | Implemented |
| X9.3 | English / Arabic with RTL from day one | P1 | Not Started (Stage 6) |
| X9.4 | Mobile PWA for QR scanning | P1 | In Progress (the phone's own camera opens the check-in link, and the page has no sideways scrolling at 375 px ✓; installable PWA and offline queue in Stage 6) |
| X9.5 | High-contrast mode | P1 | Not Started |
| X12.1 | Roles see/cannot table (§12) enforced at the right trust boundary | P1 | In Progress (contract roles ✓; attendance service checks roles against the chain ✓; indexer/API roles in Stage 3) |
| X12.2 | No on-platform donations (fundraising firewall) | P1 | Implemented (no payment code exists) |

## Appendix A: idea bank (evaluated separately, not validated requirements)

| # | Idea | Overlaps | Candidate stage | Status |
|---|---|---|---|---|
| 1 | Impact Companion avatar | M1.6 | 4 | Tested (local) |
| 2 | Co-op campus / guild boss quests | M4.4 | 5 | Deferred (needs consent store) |
| 3 | 30-person tiered leagues | M4.2 | 4 | Tested (local) |
| 4 | Civic Receipt share card (labelled estimate) | M4.5 | 4 | In Progress (Impact Twin estimate; share card not built) |
| 5 | Streak Freeze shields | M4.6 | 4 | Tested (local) |
| 6 | Unsung Hero drops | M4.7 | later | Deferred |
| 7 | Polymath all-rounder badge | M4.8 | 4 (needs a contract tier) | In Progress (computed title; not an on-chain badge) |
| 8 | Near-me rival strip | M4.3 | 4 | Tested (local) |
| 9 | Rotating 90 s HMAC-QR gate | M2.1 | 2 | Tested (local; 30 s rotation, ≤ 60 s validity) |
| 10 | Geofence boolean proof | M2.2 | 2 | Tested (local) |
| 11 | Anomaly radar | M7.1 | 5 | Not Started |
| 12 | Peer-vouched micro-checkpoints | M2 | 6 | Not Started |
| 13 | Offline scratch-card / SMS voucher | M2.5 | 6 | Not Started |
| 14 | Emergency-response fast-track | M4.8 | later | Not Started |
| 15 | Sub-50 ms omni-search | M5.1 | 3 | Tested (local benchmark: p95 38 ms at 100,000 events) |
| 16 | Paste-to-verify resolver | M5.3 | 3 | Tested (local) |
| 17 | SDG and inclusion filter matrix | M5.2 | 3 | In Progress (impact-area facets; SDG tags need event metadata) |
| 18 | NL recruiter talent finder | M5.4 | later | Not Started |
| 19 | City impact heatmap (district-level, anonymised) | none | later | Not Started |
| 20 | Dollars-for-Doers auto-matcher | M6.7 | 5 | Blocked |
| 21 | Board / Form 990 ROI deck | M6.6 | 5 | Not Started |
| 22 | Volunteers.ae and LMS export adapter | M10 | 5 | Blocked (partner formats) |
| 23 | Returning-volunteer retention radar | none | later | Not Started |
| 24 | No-show predictor and waitlist | none | later | Not Started |
| 25 | Arcade ⇄ Verifier Clean skin switch | M3.2 | 4 | Tested (local, passport) |
| 26 | Category cloaking and selective disclosure | M9.3 | 5 | Not Started |
| 27 | One-click erasure (crypto-shredding) | M9.2 | 5 | Not Started |
| 28 | ERC-5484 burn and guardian recovery | M8.3, wallet recovery | 6 | In Progress (burn ✓) |
| 29 | Break-glass auditor access log | M7.5 | 5 | Not Started |
| 30 | Public NGO trust scorecard | M7 | 5 | Not Started |
| 31 | LinkedIn Open Badges 3.0 push | M8.6 | 5 | Not Started |
| 32 | Co-curricular transcript (CLR 2.0) | M10.1 | 5 | In Progress |
| 33 | Supervisor micro-endorsements | M3.4 | 5 | Not Started |
| 34 | Course-credit milestone tracker | M10 | later | Not Started |
| 35 | Alumni lifelong continuity (wallet migration) | wallet recovery | 6 | Not Started |
| 36 | Hypercerts bridge | none | later | Not Started |
| 37 | UNV GIVE telemetry feed (anonymised) | M10 | later | Not Started |
| 38 | Cross-border humanitarian passport | M3 | later | Not Started |
| 39 | Civic perks via ZK proof (non-monetary) | none | later | Not Started |
| 40 | Embeddable verifier web component | M5.3 | 3 | Not Started |
