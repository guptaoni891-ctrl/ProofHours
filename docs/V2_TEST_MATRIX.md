# ProofHours V2: test matrix

Run everything:
```bash
forge test                      # Solidity: V1 + V2 unit, fuzz, invariant
node --test server/              # attendance service + indexer (needs ethers: cd server && npm install; anvil)
node server/bench-search.js 100000 1000   # search latency benchmark
cd e2e && npm install && node run.js     # browser: live read-only + isolated fork + V2 + attendance + discovery + progress
node shots.js                   # visual QA screenshots (360/390/768/1440/1920)
```

## Suites (results after Stage 4)

| ID | Suite | Where | What it proves | Result |
|---|---|---|---|---|
| F-V1 | `test/VolunteerHours.t.sol` | Foundry | V1 rules R1–R5 (unchanged) | 18/18 |
| F-V2 | `test/v2/ProofHoursV2.t.sol` | Foundry | Permissions; consent; duplicates; hour limits; daily and NGO caps; pause; suspension; batch; corrections and revocations; badge mint, burn, renounce and reclaim; ERC-165/5192/5484 ids; every transfer path reverts; on-chain metadata; V1 migration (consent, issuer-only, once, sync on V1 correction and revocation); fuzz | 37/37 (fuzz 512 runs) |
| F-INV | `test/v2/ProofHoursV2.invariant.t.sol` | Foundry | Totals = sum of latest entries; badge ⇔ eligibility; no orphan tokens; every run issues real records | 3 invariants × 128 runs × 64 depth (8,192 calls) |
| E2E-L | `e2e/live.test.js` | Live Base Sepolia, read-only | Seeded V1 records validated on-chain; default network is Base Sepolia; all V1 journeys; picker; duplicate check; admin confirmations; wallet switching; wrong chain; RPC failover (including 408 timeouts); responsive layouts incl. V2 screens | 91/91 |
| E2E-F | `e2e/fork.test.js` | Isolated fork, real signatures | V1 write journeys with throwaway keys; reject, Retry, wrong and different chain; unauthorized and revoked accounts | 32/32 |
| E2E-V2 | `e2e/v2.test.js` | Isolated fork, real signatures | V2 honest "not deployed" on Base Sepolia; deterministic deploy; opt-in; event; issuance; badges minted and shown with on-chain art; daily cap, consent and unauthorized refusals before signing; correction burns badges; V1 link (consent + real V1 issuer) and no double claim; holder can't transfer | 33/33 |
| S-ATT | `server/attendance.test.js` | Node test runner, real HTTP, real signatures (throwaway keys), fake chain and clock | Sign-in nonce single use, wrong-wallet signature, forged/extended/expired sessions; shifts only by the event's own NGO coordinator, time and date validation, suspended NGO; QR codes forged, window-edited, wrong kind, expired, replayed; not opted in; check-in window, capacity, overlapping attendance, one per event, late check-out; nothing issuable before approval; duration capped at the event maximum; volunteers and other NGOs can't list or approve; evidence hash = keccak256(evidence); no coordinates stored; rejection needs a reason; under-one-hour refused; marked issued only for a matching on-chain log; public opportunities list without attendee data; leagues (opt-in only, aliases, near-me strip, season scoring, bands, leave) | 9/9 |
| S-IDX | `server/indexer.test.js` | Node test runner on plain Anvil (real chain, real reorgs via `evm_snapshot`/`evm_revert`) | Deploy-block search; confirmation depth; NGOs and events indexed; **reorg: orphaned events removed, replacement indexed, every stored log on the canonical chain**; facet counts and filters; NGO names searchable; query sanitising; volunteer wallets stored nowhere | 4/4 |
| S-PROG | `server/progress.test.js` | Node test runner | Level curve; Monday weeks; streak (current week never breaks it, one count per week, V1 imports excluded); freeze shields (earned every 4th week, max 2, spent on a miss, order-independent); skill trees; Polymath; companion; First Spark; Impact Twin | 5/5 |
| E2E-ATT | `e2e/attend.test.js` | Isolated fork (8648) + the real attendance service in-process, real signatures | Unified role pill (V2 coordinator, V2 volunteer); one free sign-in signature; shift creation; rotating QR rendered; check-in from the link with location yes; replayed, forged, expired codes and a non-opted-in wallet refused; **no hours on-chain after check-in, check-out and location**; check-out code after a 10 h service-clock jump (sign-in renewed automatically); review shows 10h; issuing before approval sends nothing; approve; `issueBatch` from the coordinator's wallet → record #1 = 10h with the attendance evidence hash → 10h badge minted; service marks it issued from the receipt; volunteer sees it; 375 px layouts | 36/36 |
| E2E-DISC | `e2e/discover.test.js` | Isolated fork (8650) + indexer and attendance service in-process; no wallet | Ctrl+K opens the palette; prefix search; measured time shown; facet counts and filter; partial volunteer wallet finds nothing; NGO → directory; paste wallet (hours, badges) → public passport; paste tx, `record 1`, `badge 1`, `badge 99`, V1 link (opens the V1 check); directory: spots, area facets, spots-left filter, disabled empty facet, 375 px; suspended NGO's shifts disappear | 27/27 |
| E2E-GAME | `e2e/gamify.test.js` | Isolated fork (8651) + attendance service in-process, real signatures | Arcade default; level 4, streak 4 wk + shield, Polymath, Impact Twin estimate wording, companion stage, skill trees; unlock animation on first view only; renounce (confirmed) burns, reclaim re-mints (2 txs), hours unchanged; league join/leave by alias, no wallets; Clean view remembered; new volunteer First Spark 1 of 3; direct public passport link opens in Clean with no controls; **revocation lowers level, removes Polymath, breaks streak, switches tree node off**; 375 px | 31/31 |
| BENCH | `server/bench-search.js` | Synthetic fictional data, real index and API, 1,000 sequential queries | 1,000 events: p50 0.4 ms / p95 1.2 ms; 10,000: p50 2.7 ms / p95 3.7 ms; 100,000: p50 28.8 ms / p95 38.1 ms (server query time, localhost, Ryzen 7 7800X3D, Node 26) | measured |

**Total after Stage 4:** 56 Solidity tests (+ 8,192 invariant calls), 18 Node tests (attendance 9, indexer 4, progress 5) and 250 browser checks. All pass.

## Not yet covered
- **Real MetaMask extension:** not automated. That would need the extension download and a scripted throwaway wallet, which needs approval.
- **Accessibility:** no axe/Lighthouse audit (planned for Stage 6).
- **Load and performance:** search latency is benchmarked (sequential queries on one machine), not load-tested under concurrency. The services have no rate limiting.
- **Static analysers:** Slither/Aderyn are not installed (Blocked).
