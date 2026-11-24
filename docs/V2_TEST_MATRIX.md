# ProofHours V2: test matrix

Run everything:
```bash
forge test                      # Solidity: V1 + V2 unit, fuzz, invariant
node --test server/              # attendance service (needs ethers: cd server && npm install)
cd e2e && npm install && node run.js     # browser: live read-only + isolated fork + V2 + attendance
node shots.js                   # visual QA screenshots (360/390/768/1440/1920)
```

## Suites (results after Stage 2)

| ID | Suite | Where | What it proves | Result |
|---|---|---|---|---|
| F-V1 | `test/VolunteerHours.t.sol` | Foundry | V1 rules R1–R5 (unchanged) | 18/18 |
| F-V2 | `test/v2/ProofHoursV2.t.sol` | Foundry | Permissions; consent; duplicates; hour limits; daily and NGO caps; pause; suspension; batch; corrections and revocations; badge mint, burn, renounce and reclaim; ERC-165/5192/5484 ids; every transfer path reverts; on-chain metadata; V1 migration (consent, issuer-only, once, sync on V1 correction and revocation); fuzz | 37/37 (fuzz 512 runs) |
| F-INV | `test/v2/ProofHoursV2.invariant.t.sol` | Foundry | Totals = sum of latest entries; badge ⇔ eligibility; no orphan tokens; every run issues real records | 3 invariants × 128 runs × 64 depth (8,192 calls) |
| E2E-L | `e2e/live.test.js` | Live Base Sepolia, read-only | Seeded V1 records validated on-chain; default network is Base Sepolia; all V1 journeys; picker; duplicate check; admin confirmations; wallet switching; wrong chain; RPC failover (including 408 timeouts); responsive layouts incl. V2 screens | 91/91 |
| E2E-F | `e2e/fork.test.js` | Isolated fork, real signatures | V1 write journeys with throwaway keys; reject, Retry, wrong and different chain; unauthorized and revoked accounts | 32/32 |
| E2E-V2 | `e2e/v2.test.js` | Isolated fork, real signatures | V2 honest "not deployed" on Base Sepolia; deterministic deploy; opt-in; event; issuance; badges minted and shown with on-chain art; daily cap, consent and unauthorized refusals before signing; correction burns badges; V1 link (consent + real V1 issuer) and no double claim; holder can't transfer | 33/33 |
| S-ATT | `server/attendance.test.js` | Node test runner, real HTTP, real signatures (throwaway keys), fake chain and clock | Sign-in nonce single use, wrong-wallet signature, forged/extended/expired sessions; shifts only by the event's own NGO coordinator, time and date validation, suspended NGO; QR codes forged, window-edited, wrong kind, expired, replayed; not opted in; check-in window, capacity, overlapping attendance, one per event, late check-out; nothing issuable before approval; duration capped at the event maximum; volunteers and other NGOs can't list or approve; evidence hash = keccak256(evidence); no coordinates stored; rejection needs a reason; under-one-hour refused; marked issued only for a matching on-chain log | 7/7 |
| E2E-ATT | `e2e/attend.test.js` | Isolated fork (8648) + the real attendance service in-process, real signatures | Unified role pill (V2 coordinator, V2 volunteer); one free sign-in signature; shift creation; rotating QR rendered; check-in from the link with location yes; replayed, forged, expired codes and a non-opted-in wallet refused; **no hours on-chain after check-in, check-out and location**; check-out code after a 10 h service-clock jump (sign-in renewed automatically); review shows 10h; issuing before approval sends nothing; approve; `issueBatch` from the coordinator's wallet → record #1 = 10h with the attendance evidence hash → 10h badge minted; service marks it issued from the receipt; volunteer sees it; 375 px layouts | 36/36 |

**Total after Stage 2:** 56 Solidity tests (+ 8,192 invariant calls), 7 attendance-service tests and 192 browser checks. All pass.

## Not yet covered
- **Real MetaMask extension:** not automated. That would need the extension download and a scripted throwaway wallet, which needs approval.
- **Accessibility:** no axe/Lighthouse audit (planned for Stage 6).
- **Load and performance:** none yet. The attendance service has not been load-tested and has no rate limiting.
- **Static analysers:** Slither/Aderyn are not installed (Blocked).
