# ProofHours: one-page note

## 1. The user and their one task
A UAE university **graduation auditor** in the community-service office. Their one task: confirm in seconds, with no wallet and no account, that a student's claimed volunteer hours were recorded by an NGO the university accredited and were never altered, or see that they were corrected or revoked.

A shared spreadsheet can't do this. Any NGO editor can silently change or delete another NGO's rows, nothing proves years later which NGO signed a row, and every viewer sees student data.

## 2. On the blockchain
Contract `0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b` on Base Sepolia stores:
- the admin;
- accredited coordinator wallets with an organisation label;
- events with a maximum duration;
- **append-only records**: event, hours, issuer, time, block, type (original, correction or revocation), and links to the record replaced and the record replacing it.

A student appears only as a **commitment**, `keccak256(salt ‖ studentId)`. There is **zero personal data**: no names and no raw IDs.

Proof (S-002 issued for 4h, then corrected to 5h): `0xfd730a570ec00925af44055530de1deffd454dc9da4d6fa5cbb42301a76a691d` and `0x5d43d5233f4c9f67a1f67794b0919096c0318fefbee322f8efc999967d52969f`.

## 3. Only on the page
- the student ID and salt;
- recomputing the fingerprint in the browser;
- the verdict (VALID / CORRECTED / REVOKED / NOT FOUND) and the effective hours;
- the correction history with explorer links;
- the **claim check** (claimed vs on-chain hours);
- plain-language errors.

The page holds no database and no backend. Everything shown is read live from the contract.

## 4. What the contract refuses
- **R1:** anyone but the university admin adding or removing NGO coordinators.
- **R2:** a wallet that isn't an active coordinator creating an event, or recording hours for another NGO's event.
- **R3:** a second record for the same student at the same event.
- **R4:** 0 hours, or more than the event's maximum (for example 10h on a 6h event).
- **R5:**
  - a correction or revocation by anyone but the NGO that issued the record;
  - changing an entry that has already been replaced;
  - changing anything after a revocation.

Nothing can ever be edited or deleted. The Security Demo page shows R2–R5 refused live. The Admin Portal shows R1 refused when a non-admin wallet tries.

## 5. How to run it
1. Serve `docs/`, for example with `python -m http.server 8765 --directory docs`, or use the GitHub Pages site.
2. Open **Verify Hours** and click S-001 (VALID), S-002 (CORRECTED), S-003 (REVOKED) or S-404 (NOT FOUND). No wallet is needed.
3. To write records, use MetaMask on Base Sepolia (chain 84532) with a registered coordinator wallet.
4. To run the contract tests: `forge test` (18 tests pass).

## 6. Path to real life
Partner NGOs are independent organisations that share no database, and a student's record must outlive any one NGO's staff or systems. A neutral public chain gives every party the same tamper-evident history.

Names, real IDs and salts stay off-chain with the university and the student. Deleting a salt makes the record unlinkable to the person, which supports privacy requests.

The university's community-service office would run the admin role from a multisig, accredit NGO wallets, and sponsor the coordinators' gas so NGOs never handle crypto.
