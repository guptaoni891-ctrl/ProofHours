pragma solidity ^0.8.28;

import {console} from "forge-std/console.sol";
import {V2Fixture} from "./ProofHoursV2.t.sol";

/// Resource limits (final security review): measured gas for the loops Slither flagged, so their bounds are evidence, not guesses.
contract ProofHoursV2Limits is V2Fixture {
    /// issueBatch is paid for by the coordinator who sends it; the apps send at most 25 (MAX_BATCH). Worst case: two badge mints each.
    function test_batchOf25WithBadgeMintsFitsPerTransactionGasCap() public {
        vm.prank(gov);
        uint256 big = ledger.registerOrg("Big NGO (demo)", ngoAdmin, 5000);
        address c = makeAddr("bigCoordinator");
        vm.prank(ngoAdmin);
        ledger.setCoordinator(c, big);
        vm.prank(c);
        uint256 ev = ledger.createEvent("EVT-BIG (demo)", ENV, 12, today);
        address[] memory vs = new address[](25);
        uint16[] memory hs = new uint16[](25);
        bytes32[] memory evs = new bytes32[](25);
        for (uint256 i; i < 25; i++) {
            vs[i] = makeAddr(string(abi.encode(i)));
            hs[i] = 10;
            evs[i] = keccak256(abi.encode(i));
            vm.prank(vs[i]);
            ledger.optIn();
        }
        vm.prank(c);
        uint256 g = gasleft();
        ledger.issueBatch(ev, vs, hs, evs);
        g -= gasleft();
        console.log("issueBatch, 25 volunteers, 2 badge mints each: total gas / per volunteer", g, g / 25);
        assertEq(badges.balanceOf(vs[24]), 2);
        assertLt(g, 16_777_216, "MAX_BATCH (25) must fit the EIP-7825 per-transaction cap");
    }

    /// A coordinator can't make a V2 record unfixable by correcting it many times: correct/revoke take the head id directly.
    function test_longV2CorrectionChainStaysFixable() public {
        uint256 ev = _event(ENV, 12, today);
        uint256 head = _issue(ev, alice, 4);
        vm.startPrank(coord);
        uint256 g = gasleft();
        head = ledger.correct(head, 5, "FIX");
        uint256 first = g - gasleft();
        for (uint256 i; i < 300; i++) head = ledger.correct(head, i % 2 == 0 ? 6 : 5, "FIX");
        g = gasleft();
        head = ledger.correct(head, 7, "FIX");
        uint256 last = g - gasleft();
        vm.stopPrank();
        console.log("correct(): gas at entry 2 / entry 303", first, last);
        assertLt(last, first + first / 5, "correction cost must not grow with chain length");
        assertEq(ledger.headOf(1).hoursLogged, 7, "headOf still resolves a 303-entry chain");
        vm.prank(gov);
        ledger.revoke(head, "DISPUTE");
        assertEq(ledger.totalHours(alice), 0, "governance can still revoke");
    }

    /// V1 is deployed and immutable; its issuer controls how long a V1 trail grows. Measure the per-entry import cost.
    function test_v1TrailImportCostIsLinearAndBounded() public {
        uint256 h = v1RecordId;
        vm.startPrank(coord);
        for (uint256 i; i < 250; i++) h = v1.appendCorrection(h, i % 2 == 0 ? 5 : 6, "FIX");
        vm.stopPrank();
        vm.prank(alice);
        ledger.requestV1Link(v1RecordId);
        vm.prank(coord);
        uint256 g = gasleft();
        ledger.approveV1Link(v1RecordId, alice, ENV);
        g -= gasleft();
        console.log("approveV1Link over a 251-entry V1 trail: total gas / per entry", g, g / 251);
        assertEq(ledger.totalHours(alice), 6);
        assertLt(g / 251, 6_000, "about 5.3k gas per V1 entry: ~3,000 entries fill a 16.7M-gas transaction");
    }
}
