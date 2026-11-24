# ProofHours V2: test matrix

Run everything:
```bash
forge test                      # Solidity: V1 + V2 unit, fuzz, invariant
cd e2e && npm install && node run.js     # browser: live read-only + isolated fork + V2
node shots.js                   # visual QA screenshots (360/390/768/1440/1920)
```

## Suites (Stage 1 results)

| ID | Suite | Where | What it proves | Result |
|---|---|---|---|---|
| F-V1 | `test/VolunteerHours.t.sol` | Foundry | V1 rules R1–R5 (unchanged) | 18/18 |
| F-V2 | `test/v2/ProofHoursV2.t.sol` | Foundry | Permissions; consent; duplicates; hour limits; daily and NGO caps; pause; suspension; batch; corrections and revocations; badge mint, burn, renounce and reclaim; ERC-165/5192/5484 ids; every transfer path reverts; on-chain metadata; V1 migration (consent, issuer-only, once, sync on V1 correction and revocation); fuzz | 37/37 (fuzz 512 runs) |
| F-INV | `test/v2/ProofHoursV2.invariant.t.sol` | Foundry | Totals = sum of latest entries; badge ⇔ eligibility; no orphan tokens; every run issues real records | 3 invariants × 128 runs × 64 depth (8,192 calls) |
| E2E-L | `e2e/live.test.js` | Live Base Sepolia, read-only | Seeded V1 records validated on-chain; default network is Base Sepolia; all V1 journeys; picker; duplicate check; admin confirmations; wallet switching; wrong chain; RPC failover (including 408 timeouts); responsive layouts incl. V2 screens | 91/91 |
| E2E-F | `e2e/fork.test.js` | Isolated fork, real signatures | V1 write journeys with throwaway keys; reject, Retry, wrong and different chain; unauthorized and revoked accounts | 32/32 |
| E2E-V2 | `e2e/v2.test.js` | Isolated fork, real signatures | V2 honest "not deployed" on Base Sepolia; deterministic deploy; opt-in; event; issuance; badges minted and shown with on-chain art; daily cap, consent and unauthorized refusals before signing; correction burns badges; V1 link (consent + real V1 issuer) and no double claim; holder can't transfer | 33/33 |

**Total, Stage 1:** 56 Solidity tests (+ 8,192 invariant calls) and 156 browser checks. All pass.

## Not yet covered
- **Real MetaMask extension:** not automated. That would need the extension download and a scripted throwaway wallet, which needs approval.
- **Accessibility:** no axe/Lighthouse audit (planned for Stage 6).
- **Load and performance:** none yet; there's no backend yet.
- **Static analysers:** Slither/Aderyn are not installed (Blocked).
