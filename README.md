# ProofHours: Verifiable Volunteer Impact

ProofHours lets a university graduation auditor confirm in seconds, with no wallet and no account, that a student's volunteer hours were recorded by an accredited NGO and never silently changed. NGO coordinators write records to a smart contract on **Base Sepolia**. Corrections and revocations are new entries that point back at the old one, so the full history stays public. Only a salted fingerprint of each (fictional) student ID goes on-chain.

Built for the **HASH-IT-OUT** hackathon, theme *Verifiable Records*. Testnet only, fictional data only.

## Live deployment (Base Sepolia, chain 84532)

| | |
|---|---|
| Contract | [`0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b`](https://sepolia.basescan.org/address/0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b) |
| BaseScan | https://sepolia.basescan.org/address/0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b |
| Blockscout | https://base-sepolia.blockscout.com/address/0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b |
| Sourcify (verified source) | https://repo.sourcify.dev/84532/0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b/ |
| Deployment tx | [`0x4464f73e25108e65c6465b5b518d54a386f237ee685200eac51754002483de88`](https://sepolia.basescan.org/tx/0x4464f73e25108e65c6465b5b518d54a386f237ee685200eac51754002483de88) (block 62,946,611) |
| Front end | `docs/` (static site). GitHub Pages URL once enabled: https://guptaoni891-ctrl.github.io/ProofHours/ |

## Blockchain evidence: the two submission transactions

Both transactions tell the S-002 story: hours issued, then corrected by the same NGO. Both receipts have **status 1 (success)** on Base Sepolia, and each emits the expected event from the contract above.

| Step | Transaction | What it did |
|---|---|---|
| 1. Issue S-002, 4 hours | [`0xfd730a570ec00925af44055530de1deffd454dc9da4d6fa5cbb42301a76a691d`](https://sepolia.basescan.org/tx/0xfd730a570ec00925af44055530de1deffd454dc9da4d6fa5cbb42301a76a691d) | `recordVolunteerHours` → record #2, event #1, 4h (`HoursRecorded`), block 62,951,183 |
| 2. Correct S-002 to 5 hours | [`0x5d43d5233f4c9f67a1f67794b0919096c0318fefbee322f8efc999967d52969f`](https://sepolia.basescan.org/tx/0x5d43d5233f4c9f67a1f67794b0919096c0318fefbee322f8efc999967d52969f) | `appendCorrection` → record #3 replaces #2, 5h, reason `TYPO_FIX` (`CorrectionAppended`), block 62,951,699 |

Record #2 still shows 4 hours on-chain, and its `supersededBy` points to #3. Nothing was edited.

These were sent from a MetaMask smart account (EIP-7702), so explorers list MetaMask's relayer as the transaction sender. The contract records the coordinator wallet `0x99f3…0674` as `msg.sender` and issuer.

## The problem

Seniors must finish off-campus volunteer hours with many independent partner NGOs before they can graduate. Today the proof is a shared spreadsheet or emailed letters. With a spreadsheet:

- any editor can silently change or delete another NGO's rows;
- nothing proves, years later, which accredited NGO signed a row;
- nothing stops unaccredited or inflated entries;
- every viewer sees student data.

## The solution and its roles

| Role | Who | Can do |
|---|---|---|
| **Admin** | University community-service office | Register and revoke NGO coordinator wallets |
| **Coordinator** | An accredited NGO, using its own wallet | Create events, record hours, append corrections and revocations to its own records |
| **Public reader** | Graduation auditor, anyone | Verify a student's hours with no wallet |

In the live demo, one wallet (`0x99f3…0674`) is both admin and the "Green Shores NGO (demo)" coordinator, and the UI shows both roles. `0x…dEaD` is registered as "Desert Bloom NGO (demo)". Nobody holds its key; it exists only so the Security Demo can show a second NGO being refused.

## Main features

- **Verify Hours (no wallet):**
  - The page recomputes the fingerprint `keccak256(salt ‖ studentId)` in the browser and reads the contract.
  - It shows **VALID**, **CORRECTED**, **REVOKED** or **NOT FOUND**, with hours, the issuing NGO and the event.
  - It shows the full correction history with transaction links, and a **claim check** (e.g. "claimed 8h, on-chain 5h").
- **Coordinator Portal:** create an event (1–24h max), record hours with a generated salt and a shareable verify link, append a correction or revocation.
- **Admin Portal:** register or revoke coordinators, see the coordinator list, look up any wallet's status.
- **Security Demo:** four live contract refusals (wrong wallet, duplicate, over the hour limit, another NGO correcting). Each is a read-only `eth_call` showing the decoded custom error, with an optional real broadcast that is mined and reverted.
- **Network Status:** live RPC health, wallet chain, balance, and a "same chain as page" check.
- **Friendly errors:** every contract refusal and wallet error is shown in plain language, not raw RPC text.

## Technology stack

- Solidity `^0.8.28` (solc 0.8.28, EVM `cancun`, optimizer 200 runs), with no imports in the contract.
- Foundry (forge 1.10.0) for tests and scripts; `forge-std` is vendored in `lib/`.
- A static front end (HTML, CSS, vanilla JS) with **ethers 6.17.0 vendored** in `docs/vendor/`. There is no framework, build step or backend.
- Base Sepolia public RPCs (publicnode, drpc, sepolia.base.org), tried in order. MetaMask is used only for writes.

## Smart contract architecture (`src/VolunteerHours.sol`)

- **Admin:** `admin`, the deployer, fixed at construction.
- **Coordinators:** `coordinators[address] → {active, orgLabel}`.
- **Events:** `events[id] → {coordinator, maxDurationHours, eventCode}`.
- **Records:** `records[id] → {eventId, volunteerCommitment, hoursLogged, issuer, recordedAt, recordedBlock, entryType (ORIGINAL | CORRECTION | REVOCATION), replacesRecordId, supersededBy, reasonCode}`.
- **Append-only chain:**
  - A correction or revocation is a new record with `replacesRecordId`.
  - The old record keeps its data; only its `supersededBy` pointer is set.
  - `getEffectiveRecord(id)` walks to the current head and returns the trail.
  - `getRecordsByCommitment(fingerprint, offset, limit)` finds a student's originals.
- **Rules:** five, enforced with custom errors (see "What the contract refuses" in [NOTE.md](NOTE.md)).
  - R1: only the admin manages coordinators.
  - R2: only an active coordinator creates events and records hours for **its own** events.
  - R3: one record per event and student.
  - R4: hours must be between 1 and the event's maximum.
  - R5: only the original issuer can correct or revoke, only the latest entry, and never after a revocation.
- **Events emitted:** `CoordinatorRegistered`, `CoordinatorRevoked`, `EventCreated`, `HoursRecorded`, `CorrectionAppended`, `RevocationAppended`.

The front-end ABI and contract address are in `docs/config.js`.

## Run the front end locally

1. Serve the static site. Python is one option:

   ```powershell
   python -m http.server 8765 --directory docs
   ```

2. Open http://localhost:8765/ and press Ctrl+Shift+R the first time.
3. Don't add `?rpc=` or `?local`. With neither, the page reads the live Base Sepolia contract through public RPCs. **Verifying needs no wallet.**

## Connect MetaMask (only needed for writes)

1. Add or select **Base Sepolia**:
   - RPC: `https://sepolia.base.org`
   - Chain ID: `84532`
   - Symbol: `ETH`
   - Explorer: `https://sepolia.basescan.org`

   Or click **Switch to Base Sepolia** in the page's top bar.
2. Fund the wallet with Base Sepolia test ETH from a faucet. Each write costs well under 0.0001 ETH.
3. Click **Connect**. The pill shows your role: ADMIN, COORDINATOR, ADMIN · COORDINATOR, or NOT AUTHORIZED. Only the admin wallet can register a new coordinator.

## Demonstrate the four verification outcomes

Open **Verify Hours** (no wallet needed) and click each demo button.

| Button | Expected result |
|---|---|
| **S-001** | **VALID**: 4 hours, Green Shores NGO (demo), EVT-001 Beach Cleanup (demo) |
| **S-002** | **CORRECTED**: 5 hours. The history shows original #2 (4h) and correction #3 (5h, `TYPO_FIX`) with transaction links |
| **S-003** | **REVOKED**: 0 hours. The history shows original #4 (3h) and revocation #5 (`ATTENDANCE_VOID`) |
| **S-404** | **NOT FOUND**: the recomputed fingerprint matches no on-chain record |

**Claim check:** select S-002, type `8` in "Claimed hours" and click Verify. You'll see **CLAIM MISMATCH: claimed 8h, on-chain 5h**.

**Live refusals:** open **Security Demo** and click each of the four buttons. Each shows "Actual: refused · matches expected" and the decoded custom error.

The demo IDs and salts in `docs/demo-volunteers.js` are **fictional and published on purpose** so anyone can reproduce the demo. In real use the salt stays with the student.

## Tests

```powershell
forge test
```

All **18 tests pass**. They cover:

- R1 to R5, pass and revert cases;
- revoked coordinators;
- correction and revocation trails;
- pagination;
- bad inputs;
- a cross-check that the Solidity fingerprint equals the ethers.js one.

We also checked the front end in a headless browser against the live deployment. That check passed 25/25: overview metrics, all four verdicts, claim mismatch, both portals, all four refusals and network diagnostics. Those browser scripts are local QA tools and are not part of this repository.

## Deploy and seed (for reference)

- **Live deployment:** done with Remix and MetaMask, using the compiler settings above. The seed was entered through the Admin and Coordinator portals, giving the same eight transactions that `script/Seed.s.sol` produces.
- **Scripted alternative with encrypted Foundry keystores** (no private keys in files):

  ```powershell
  cast wallet import proofhours-admin --interactive
  ```
  ```powershell
  forge create src/VolunteerHours.sol:VolunteerHours --rpc-url https://sepolia.base.org --account proofhours-admin --broadcast
  ```
  ```powershell
  $env:CONTRACT="<address>"; $env:COORD_ADDR="<coordinator address>"
  ```
  ```powershell
  forge script script/Seed.s.sol --rpc-url https://sepolia.base.org --account proofhours-admin --account proofhours-coord --broadcast
  ```

  Then put the new address in `docs/config.js`.
- **Offline development:** `?local` points the page at a local Anvil node on `127.0.0.1:8546`, using chain ID 31337 and the `local` block in `config.js`. It is not used by the live demo.

## Limitations and future improvements

- **Testnet and fictional data only.** Never use real student data or mainnet.
- **One wallet holds both roles in the demo:** the admin and the "Green Shores" coordinator are the same wallet. A real deployment would separate them, with the admin role on a multisig.
- **The admin can't be transferred.** It is fixed at deployment; a real version would add a two-step transfer.
- **Coordinator table:** the Admin Portal lists only coordinators that have created an event, because the page avoids scanning event logs. The lookup box checks any wallet.
- **Overview totals:** they are computed from the latest 200 records. The "your transactions" list lasts only for the browser session.
- **Source verification:** the source is verified on Sourcify. We did not confirm BaseScan source verification separately.
- **Public RPCs:** the page depends on public Base Sepolia RPCs, which can be slow or rate-limited. It tries three in order.
- **Possible future work:**
  - gas sponsorship for NGOs;
  - an Arabic/English verdict card;
  - a QR code on the receipt;
  - an on-chain index of each coordinator's events.

## Team

See [CONTRIBUTIONS.md](CONTRIBUTIONS.md). The required one-page note is [NOTE.md](NOTE.md).
