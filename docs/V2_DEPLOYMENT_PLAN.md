# ProofHours V2: deployment plan

**Approval gates.** Each of these needs the project owner's explicit approval first:
- public-chain transactions or contract deployment;
- paid services;
- pushing to GitHub or merging into `main`;
- publishing the website.

## Environments

| Environment | Chain | V1 | V2 | Who uses it |
|---|---|---|---|---|
| Live V1 | Base Sepolia (84532) | `0xFbDC…9F9b` (unchanged) | not deployed | Public site from `main` (tag `v1.0.0`) |
| Local fork | Anvil fork of Base Sepolia, chain 31337, `127.0.0.1:8546` | copy of the live V1 | `ProofHoursLedger 0xd714…44bA`, `ProofHoursBadges 0x64d4…35F4` | Development, demos, e2e |
| V2 staging | Base Sepolia | live V1 (read-only) | **not deployed (needs approval)** | After approval |
| Attendance service | Off-chain | — | local only (`127.0.0.1:8790`) | Public hosting needs approval, rate limiting and a legal review of the data it holds |

## Local (reproducible, no keys)
```bash
anvil --fork-url https://base-sepolia-rpc.publicnode.com --chain-id 31337 --port 8546
cast rpc anvil_impersonateAccount 0x0000000000000000000000000000000050000001 --rpc-url http://127.0.0.1:8546
cast rpc anvil_setBalance 0x0000000000000000000000000000000050000001 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8546
SEED_DEMO=true forge script script/DeployV2.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
  --unlocked --sender 0x0000000000000000000000000000000050000001
ATTENDANCE_SECRET=<random 32+ bytes> node server/attendance.js   # attendance service on 127.0.0.1:8790 (Node 22.13+)
python -m http.server 8765 --directory docs    # open http://localhost:8765/?local
```
- **Attendance service:** needs `ethers` (`cd server && npm install`). Settings: `PORT` (8790), `RPC_URL` (`http://127.0.0.1:8546`), `LEDGER` (local ledger address), `CHAIN_ID` (31337), `ATTENDANCE_DB` (`server/data/attendance.sqlite`). The page finds it through `config.js` → `local.attendance`, or `?api=` for another address.
- **Fixed addresses:** the deployer `0x…50000001` has nonce 0 on Base Sepolia, so on every fresh fork the V2 contracts get the same addresses, which match `docs/config.js` → `local.v2`.
- **Demo seed:** "Green Shores NGO (demo)" (coordinator = the V1 issuer wallet, so V1 records can be linked) and "Desert Bloom NGO (demo)".

## Base Sepolia (after approval)
1. **Pre-flight:**
   - `forge test` green;
   - independent review of the diff;
   - multisig created (Safe, 3-of-5 suggested), with signer list confirmed by the owner;
   - deployer wallet funded with test ETH by the owner (never a key shared in chat).
2. **Deploy with a keystore:**
   ```bash
   GOVERNANCE=<safe address> forge script script/DeployV2.s.sol --rpc-url https://sepolia.base.org --broadcast --account <keystore>
   ```
   The script grants admin and pauser to the multisig and renounces the deployer's roles. `SEED_DEMO` is never set on public chains.
3. **Verify source** on Sourcify, Blockscout and BaseScan.
4. **Record** the transaction hashes from real receipts, then put the addresses in `config.js` → `v2`.
5. **Smoke test:** run the e2e V2 suite read-only against staging, then a single real write approved by the owner.
6. **Governance actions** through the multisig: register NGOs, assign NGO admins, grant the auditor role.

## Versioning and upgrades
- **Immutable contracts:** a fix ships as a **new version deployed alongside**, and the old one is never overwritten (as with V1 → V2).
- **Version changes:** the front end switches by config. Records on an old version stay verifiable there.
- **Migrations:** any migration follows the V1 pattern of consent, issuer approval, reading truth from the old contract, and recording provenance.

## Rollback
- **Front end:** revert the merge commit on `main`; GitHub Pages republishes V1 (`v1.0.0`).
- **Contracts:** pause through governance. Contracts aren't upgradeable, so rollback means pausing and pointing the UI back to V1.
