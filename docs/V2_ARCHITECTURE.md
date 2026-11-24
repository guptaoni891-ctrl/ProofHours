# ProofHours V2: architecture

## 1. Principles
1. **Never touch V1.** `VolunteerHours` at `0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b` (Base Sepolia) and its records stay exactly as they are. V2 is a separate, versioned contract suite that only **reads** V1.
2. **Chain is truth, everything else is a cache.**
   - Totals, records and badges live in contracts.
   - The future indexer, database and search index hold derived copies, and the UI labels them as derived.
3. **No personal data on-chain.** Only wallet addresses, integers, enums and hashes go on-chain. Names, real IDs, salts, raw locations and sensitive affiliations stay off-chain (§8, Tier 1).
4. **Smallest sound migration.** Keep the static, framework-free front end and its tested design system. Add backend services only where a capability truly needs a server: attendance tokens, indexing, search, private data.
5. **Every external vendor sits behind an adapter**, with a working local substitute. Integrations without credentials are marked **Blocked**, never faked.

## 2. Current state (after Stage 2)

```
Browser (docs/: static HTML/CSS/JS, ethers 6 and qrcode-generator vendored)
 ├─ V1 screens: verify, my impact, coordinator, admin, rules, network   ──reads/writes──▶  V1 VolunteerHours
 ├─ V2 screens: my passport, V2 issuance                                 ──reads/writes──▶  ProofHoursLedger ──▶ ProofHoursBadges
 │                                                                                               └──reads──▶ V1 (migration)
 └─ V2 attendance: shifts, QR, review (coordinator); check-in (volunteer)
        ├──REST + wallet sign-in──▶ attendance service (server/attendance.js, Node, SQLite) ──reads only──▶ ProofHoursLedger
        └──issueBatch from the coordinator's own wallet──────────────────────────────────────▶ ProofHoursLedger
Reads: public RPCs with failover (Base Sepolia) or a local fork (`?local`). Writes: the user's wallet (EIP-1193).
```

### Attendance service (`server/attendance.js`, Stage 2)

| Concern | Design |
|---|---|
| Keys | Holds **no** wallet keys and sends **no** transactions. It reads the ledger (coordinator NGO, opt-in, events, receipts) and stores attendance. |
| Sign-in | One-time nonce → the wallet signs a fixed message (`personal_sign`, free) → a 2-hour HMAC bearer token. No cookies, so CORS `*` exposes nothing ambient. |
| QR codes | `shift.kind.window.hmac`: HMAC-SHA256 over shift id, `in`/`out` and a 30-second window; accepted in its own window and the next (≤ 60 s). Stateless; replay is stopped by one check-in and one check-out per wallet per shift. |
| Check-in rules | Volunteer must have opted in on-chain; check-in opens 30 min before the shift and closes at its end; capacity; no check-in while checked in elsewhere (no overlapping attendance); one attendance per wallet per event (the ledger allows one record per event). |
| Location | Optional and unticked by default. The phone compares its position with the shift's site area (Haversine) and sends only yes/no. The service never accepts coordinates. Client-reported, so shown as information, not proof. |
| Approval | Only a coordinator of the shift's NGO (checked on-chain each time, and the NGO must not be suspended). Hours = whole hours inside the shift window, capped at the event's maximum. Approval writes a salted evidence JSON and its keccak256 hash. |
| Issuance | The page asks the service for the approved list and sends `issueBatch(event, wallets, hours, evidenceHashes)` from the coordinator's wallet. The service then reads the receipt and marks a row issued only if a `HoursIssued` log matches its event, wallet and evidence hash. |
| Storage | `node:sqlite` file (`server/data/`, git-ignored). Postgres arrives with the Stage 3 indexer. |

### Contract suite (`src/v2/`, OpenZeppelin v5.7.0)

| Contract | Responsibility |
|---|---|
| `ProofHoursLedger` | NGOs, NGO admins, coordinators, volunteer opt-in, categorised events, append-only records (original, correction, revocation, imported-from-V1), cumulative totals per wallet and per impact area, anti-farming caps, pause, suspension, consent-based V1 migration and V1 sync. |
| `ProofHoursBadges` | ERC-721 + ERC-5192 (`locked`) + ERC-5484 (`burnAuth` = Both). Mints and burns only on the ledger's instruction, so a badge exists exactly while its milestone is met. Holder can renounce and reclaim. Metadata and SVG artwork are generated on-chain. |

**Accounting:**
- `ProofHoursLedger._adjust(volunteer, category, oldEffective, newEffective)` is the single place totals change. Every issue, correction, revocation, import and V1 sync goes through it, and then reconciles badges.
- An invariant test proves totals always equal the sum of each record's latest entry, and that every badge matches eligibility.

**Impact categories:** Environmental, Education, Healthcare, Emergency, Inclusion (plan §5 M4). They're an enum on the event and copied onto each record.

**Milestones:**
- Totals: 10/25/50/100/250/500.
- Per category: 10/50/100/250/500.

**Caps:**
- 12 verified hours per volunteer per service day; Emergency events allow 24.
- A per-NGO daily issuance cap (a circuit breaker set by governance).

## 3. Wallet and identity design

| Problem | Design |
|---|---|
| V1 records belong to salted fingerprints, not wallets | A V1 fingerprint is **never** assumed to belong to a wallet. |
| Linking V1 to a wallet | Two steps: (1) the volunteer calls `requestV1Link(v1Id)` from their wallet; this is consent and grants nothing. (2) The **wallet that issued the V1 record** calls `approveV1Link` after checking the student's receipt off-chain. Hours are **read from V1** (`getEffectiveRecord`), never typed in. Each V1 record can be imported once. |
| Revocation-safe aggregation | `syncV1(v1Id)`, callable by anyone, mirrors later V1 corrections or revocations into V2 totals. V2 coordinators can't edit imported records; only V1 sync or a governance revocation can. |
| No self-reported hours | Totals change only through NGO issuance or NGO-approved imports; there is no other write path. |
| Cross-NGO cumulative hours | Totals are per wallet across all NGOs; each record keeps its NGO id. |
| Migration provenance | Imported records have type `MigratedV1` and store the V1 record id; the passport labels them "From V1". |
| Smart accounts and passkeys | The contracts only need `msg.sender`. Smart-account (ERC-4337/EIP-7702) and passkey wallets work unchanged. Embedded-wallet adapters (Privy, thirdweb, Coinbase) come in Stage 6. |
| Wallet recovery (Stage 6, designed, not built) | Governance-approved `recoverVolunteer(old, new)`: requires the volunteer's proof via a guardian or passkey recovery and an NGO attestation. It moves totals and record ownership, and re-mints badges by burning on the old wallet and minting on the new (ERC-5484). Until then a lost wallet keeps its history but can't be moved. |

## 4. Target architecture (Stages 2–6)

```
                    ┌──────────────── static front end (GitHub Pages compatible) ────────────────┐
                    │ V1 + V2 screens, Cmd+K search, passport, cockpit, auditor console, EN/AR RTL │
                    └───────▲─────────────────────────▲──────────────────────────▲───────────────┘
                            │ chain reads/writes       │ REST (JSON)              │ search
                     Base Sepolia / local fork    api (TypeScript, Fastify)   Meilisearch
                            │                          │   ├─ attendance: HMAC-QR tokens, nonces, approvals
                            │                          │   ├─ profiles & consent (encrypted PII vault)
                            ▼                          │   ├─ reports / transcripts / OB3 issuer (KMS key)
                     indexer (TypeScript) ──────────▶ PostgreSQL ◀─────┘
                     confirmations + reorg rollback     └─ search sync ─▶ Meilisearch
```

- **Why not Next.js or React now:** the current UI works, is tested and is static-host friendly. A framework rewrite adds risk and a build step without user value. The new screens are added as plain modules (like `docs/v2.js`). This decision gets revisited if the screen count makes plain modules unmanageable.
- **Backend:** Stage 2 ships the attendance service as plain Node (no build step, built-in SQLite). Stage 3 adds the indexer worker, Postgres, Meilisearch and Docker Compose, and moves attendance data to Postgres. Environment variables come from `.env.example` files; no secrets are committed.
- **Indexer:**
  - Polls logs by block range only in the backend; the front end never scans logs, which is a V1 rule.
  - Stores `(block number, block hash)`.
  - Treats data as final after N confirmations.
  - On a hash mismatch it rolls back to the last common block and replays.
  - Every derived row stores its source tx hash and log index.
- **EAS:** evaluated in Stage 3. The ledger already acts as the attestation registry, so EAS will be added only if interoperability needs it (plan §8 Path A), not as a second source of truth.
- **Content-addressed storage:** current badge art is generated on-chain (nothing to pin). An IPFS adapter (local Kubo in Docker; Pinata via env) is for OB3 evidence and bulk exports.

## 5. Trust boundaries

| Boundary | Enforced by |
|---|---|
| Who may issue, correct or revoke hours | The contract (org-scoped coordinators); the UI pre-check only improves feedback |
| Who may manage NGOs, caps, pause, reinstate | Contract roles (governance = intended multisig) |
| Attendance validity (QR window, single use per wallet, geofence boolean, approval) | Attendance service. A QR or GPS reading alone never issues hours; a coordinator approves, then signs `issueBatch` |
| Private profile data | Backend vault with consent checks (Stage 5); never on-chain |
| Search visibility | Index only public data and opted-in profiles |
