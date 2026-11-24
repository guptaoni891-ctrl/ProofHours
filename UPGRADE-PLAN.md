# ProofHours upgrade plan: gamified volunteer platform

Source vision: *Gamified Volunteer SBT Discovery Plan* ("CivicQuest", 85 pages): feature catalogue M1–M12, dashboard zones A–F, gamification (§7), SBT and privacy (§8), UI/UX and dual mode (§9), architecture (§11) and roles (§12).

**Hard constraint:** the live contract `0xFbDC…9F9b` on Base Sepolia stays exactly as it is, along with its records S-001, S-002, S-003 and S-404. All work happens on branch `feature/gamified-redesign` and nothing is published until it is approved.

## 1. Audit of the existing application

### What the deployed contract can and cannot do

| Capability | Status on `0xFbDC…9F9b` |
|---|---|
| Admin registers or revokes NGO coordinators (R1) | ✅ `registerCoordinator`, `revokeCoordinator` |
| Coordinator creates events with a 1–24h maximum (R2) | ✅ `createEvent(eventCode, maxHours)` |
| Hours per student per event, no duplicates, within the limit (R2–R4) | ✅ `recordVolunteerHours(eventId, commitment, hours)` |
| Append-only corrections and revocations by the issuer only (R5) | ✅ `appendCorrection`, `appendRevocation`, `getEffectiveRecord` |
| All of one student's records | ✅ `getRecordsByCommitment(fp, offset, limit)`, keyed by a **salted fingerprint**, not a wallet |
| Volunteer **wallet** identity | ❌ none; volunteers never sign or hold anything |
| Impact **category** | ❌ no field; only the free-text `eventCode` |
| Cumulative hours computed **on-chain** | ❌ no running total; it can be summed from records off-chain |
| SBT / milestone minting | ❌ no token contract exists |
| Event dates, location, capacity, discovery | ❌ only `eventCode` and `maxDurationHours` |
| Search index or enumeration by NGO | ⚠️ only by reading every event or record (fine at demo scale) |

### Front end today (`docs/`)
The pages are Overview, Verify Hours, Coordinator Portal, Admin Portal, Security Demo and Network Status. The design is midnight dark with an off-canvas mobile drawer and respects reduced motion. The site reads live from public RPCs, has friendly errors and wallet diagnostics, and shows ADMIN and COORDINATOR together when one wallet holds both.

### Usability problems found

| Area | Problem | Fix (phase) |
|---|---|---|
| First visit | The home page is a technical overview. A newcomer can't tell where to start or which role is theirs. | Role-selection home page (P1) |
| Volunteer | A student has **no view of their own progress**. Verify is written for auditors. | Volunteer Impact Dashboard (P1), progression (P2) |
| Verify | The page asks for a raw 64-hex "salt" without explaining it. Jargon like "fingerprint" and "commitment" goes unexplained. | Plain-language helper text and tooltips (P1/P3) |
| Coordinator | Correct and revoke ask for a **raw record number** with no preview of what you're about to change. | Searchable record picker with preview (P3) |
| Coordinator | A duplicate record is only caught at MetaMask's gas estimate, after the wallet step. | Read-only pre-check before sending (P3) |
| Coordinator | Four separate forms with no order. New coordinators don't know the sequence. | Guided steps: event → record → share receipt (P1/P3) |
| Coordinator | The salt is shown once. If it's lost, the student can't prove their hours. | Stronger receipt: copy, download, QR (P3) |
| Admin | Registration takes a pasted address with no label preview. The coordinator list shows only NGOs that created events. | Confirm step, plus a registry from the same reads (P1/P3) |
| Trust pages | Security Demo and Network Status are developer-oriented. | One clean "Audit & Proof" view (P1) |

## 2. Feature compatibility matrix

**F** means it works in the front end only with today's contract. **B** needs a backend or indexer. **C** needs a new or extra smart contract.

| Feature (plan module) | Type | Notes |
|---|---|---|
| Role-selection home page, mobile navigation (M1) | **F** | — |
| Volunteer Impact Dashboard for one student ID + salt (M1/M3) | **F** | Sums effective hours across all the student's records via `getRecordsByCommitment` → `getEffectiveRecord` |
| Verified-hours progression and next-milestone bar (M1) | **F** | Computed in the browser from on-chain records; **labelled "computed, not minted"** |
| Trophy Vault of earned milestones, unlock animation (M1/M8) | **F** (display) / **C** (mint) | Shows **earned** milestones only. "Minted" appears only once an SBT contract confirms a token. |
| Proof links on every hour (M3 Proof Drawer) | **F** | Single-block log lookup already exists |
| Arcade mode and Verifier Clean mode (M3) | **F** | One CSS theme switch, remembered in localStorage |
| Impact categories | **F** (convention) / **C** (proper) | Now: new events carry a category tag in `eventCode` (e.g. `[ENV] Beach Cleanup`). Old events show "Uncategorised". Later: a category field in contract v2. |
| Guided multi-step coordinator workflow, searchable record picker, duplicate pre-check (M6) | **F** | Uses `hasRecorded()`, `getRecord()`, staticCall |
| Event directory (list of on-chain events) | **F** | Code and maximum hours only. Dates, places and sign-ups need **B**. |
| Event discovery with dates, location, sign-ups (M1 shift feed) | **B** | Off-chain event store |
| Fast faceted search (M5) | **B** | Indexer (Ponder/Goldsky) + Postgres/Meilisearch. Client-side filtering is fine at demo scale. |
| Wallet-linked cumulative hours (M3/M8) | **C** + **B** | v2 contract keyed by a volunteer address or an opt-in link to a commitment. Off-chain identity vault. |
| Real SBT milestone minting, ERC-5192 + ERC-5484 (M8) | **C** | Separate SBT contract that reads hours (or receives attestations). Needs volunteer wallets. |
| QR check-in and NGO approval queue (M2) | **B** + **C** | Rotating HMAC-QR server, approval queue, batch issuance |
| Opt-in leaderboards and co-op quests (M4) | **B** (+ **C** for group SBTs) | Requires an identity and opt-in consent |
| University transcript PDF and Open Badges 3.0 / VC export (M8/M10) | **F** (PDF of verified data) / **B** (signed VC) | Signing needs an issuer key or DID, which must not live in the browser |
| KYB, anomaly radar, spot audits, multisig governance (M7/M9/M12) | **B** + **C** | Out of scope for the front end |

## 3. Proposed sitemap

```
Home (role selection + live network stats)
├── Verify Hours            public, no wallet  · Verifier Clean mode
├── My Impact               public, no wallet  · progression, milestones, Trophy Vault
├── NGO Coordinator         wallet · guided: 1 Event → 2 Record → 3 Share receipt · Fix a record
├── University Admin        wallet · Register NGO · Registry · Wallet lookup
├── Audit & Proof           contract rules (live refusals) · network health · explorer links
└── (header) Mode switch: Arcade ⇄ Verifier Clean · Connect wallet (optional)
```

## 4. Wireframe descriptions

- **Home**
  - Brand hero line: "Every hour matters. Every hour verified."
  - **Four large role cards**, each a one-line promise plus a button:
    - "Verify a student's hours: no wallet needed"
    - "See my volunteer impact"
    - "I'm an NGO coordinator"
    - "I'm the university admin"
  - A live stats strip below: verified hours, records, events, NGOs.
  - Then "how it works" in four steps and a short "stored vs never stored" block.
- **My Impact (Volunteer Dashboard)**
  - Top: Student ID and salt inputs, demo chips, and "open from my receipt link".
  - Result hero: big **verified hours** counter, records, NGOs served, events.
  - **Next-milestone bar**, e.g. "4 / 5 h to *First Spark*", labelled "milestones are calculated from on-chain hours; badges are not minted yet".
  - Phase 2 adds the Trophy Vault grid: earned badges glow, the next one is a silhouette.
  - Record list: event, NGO, verdict pill, hours and a **proof link** for each.
- **Verify Hours**
  - Unchanged logic, plus helper text explaining what a salt is.
  - Verifier Clean mode (P3) removes gradients and animation for a print-ready audit table.
- **NGO Coordinator** (P3 guided)
  - A stepper: ① create or choose an event (with a category) → ② choose a volunteer.
  - The duplicate pre-check shows "already recorded for this event" *before* MetaMask opens.
  - ③ Confirm → ④ receipt with verify link, copy and QR.
  - A "Fix a record" tab with a searchable list of your records, a preview, then correct or revoke.
- **University Admin**
  - Register NGO (address + label → confirm card), a registry table, wallet lookup and revoke with confirmation.
- **Audit & Proof**
  - Contract address and verified-source links, the five rules with live refusals, network health and the two story transactions.

## 5. Prioritised roadmap

| # | Item | Why first | Effort |
|---|---|---|---|
| 1 | Role-selection home page, nav restructure | Biggest newcomer win, frontend only | S |
| 2 | Volunteer Impact Dashboard with milestone bar | The core of the gamified vision that works on today's contract | M |
| 3 | Trophy Vault, unlock animation, impact categories (convention) | Gamification, honestly labelled | M |
| 4 | Guided coordinator flow, record picker, duplicate pre-check | Removes the riskiest manual steps | M |
| 5 | Arcade / Verifier Clean mode, tooltips, a11y pass | Serves institutional verifiers | S |
| 6 | Transcript PDF (verified data + QR) | Useful today, frontend only | S |
| 7 | Contract v2 + SBT contract (categories, wallet link, ERC-5192/5484) on a **new** address | Unlocks real minting | L |
| 8 | Indexer and search, event discovery, QR check-in, leaderboards (opt-in) | Need a backend | L |

## 6. Implementation phases

- **Phase 1 (front end only, this branch):**
  - home page with role selection;
  - Volunteer Impact Dashboard (totals, per-record proof, next-milestone bar);
  - navigation restructure;
  - plain-language helper text.
  - Test: `forge test`, a live read-only regression of the existing flows (S-001/2/3/404, portals, refusals), and the new pages at desktop and 375 px.
- **Phase 2 (front end only):**
  - Trophy Vault with milestone ladder 5 / 10 / 25 / 50 / 100 / 250 / 500 h;
  - unlock animation, which respects reduced motion;
  - category progress views using the `[ENV]` / `[EDU]` / `[HLT]` / `[EMR]` / `[INC]` event-code convention, with "Uncategorised" for older events;
  - proof links on every badge.
  - Every badge says **"Earned · not minted on-chain"**.
- **Phase 3 (front end only):**
  - guided coordinator stepper, searchable record picker, duplicate pre-check via `hasRecorded`;
  - stronger receipt;
  - Arcade / Verifier Clean switch, tooltips, keyboard and focus audit.
- **Phase 4 (design, then a new deployment after approval):**
  - **Contract v2** (a new address; v1 stays as the historical record):
    - `category` enum on events;
    - optional volunteer address bound to a commitment by a signed opt-in;
    - on-chain cumulative totals per volunteer and category.
  - **SBT contract:** ERC-721 + ERC-5192 `locked()` + ERC-5484 `burnAuth`. `claimMilestone(threshold)` checks v2 totals and mints once per threshold.
  - **Backend:**
    - Ponder indexer → Postgres → Meilisearch for search and event discovery;
    - QR check-in service with rotating HMAC tokens and an NGO approval queue that batch-issues on-chain;
    - opt-in leagues and co-op quests;
    - a signed Open Badges 3.0 / VC issuer service.
  - **Privacy:** names, real IDs and salts stay off-chain, with no personal data on-chain (plan §8, Tier 1–3).
