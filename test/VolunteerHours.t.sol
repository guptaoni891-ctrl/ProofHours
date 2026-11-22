// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {VolunteerHours} from "../src/VolunteerHours.sol";

contract VolunteerHoursTest is Test {
    VolunteerHours v; // deployed by this test contract, so address(this) is admin
    address coord = makeAddr("coord");
    address coord2 = makeAddr("coord2");
    address stranger = makeAddr("stranger");

    bytes32 constant SALT = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
    bytes32 C1 = keccak256(abi.encodePacked(SALT, "S-001"));

    function setUp() public {
        v = new VolunteerHours();
        v.registerCoordinator(coord, "Green Shores NGO (demo)");
        v.registerCoordinator(coord2, "Desert Bloom NGO (demo)");
        vm.prank(coord);
        v.createEvent("EVT-001 Beach Cleanup (demo)", 6); // event 1, owned by coord
    }

    function _record(uint16 h) internal returns (uint256) {
        vm.prank(coord);
        return v.recordVolunteerHours(1, C1, h);
    }

    // ---------- R1: only admin manages coordinators ----------
    function test_R1_adminRegistersAndRevokes() public {
        (bool active, string memory label) = v.coordinators(coord);
        assertTrue(active);
        assertEq(label, "Green Shores NGO (demo)");
        v.revokeCoordinator(coord);
        (active,) = v.coordinators(coord);
        assertFalse(active);
    }

    function test_R1_revert_nonAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.UnauthorizedAdmin.selector, stranger));
        vm.prank(stranger);
        v.registerCoordinator(stranger, "Fake NGO");

        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.UnauthorizedAdmin.selector, coord));
        vm.prank(coord);
        v.revokeCoordinator(coord2);
    }

    // ---------- R2: active coordinator, own event only ----------
    function test_R2_ownerRecords() public {
        assertEq(_record(4), 1);
        assertEq(v.getRecord(1).issuer, coord);
    }

    function test_R2_revert_randomWallet() public {
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.UnauthorizedCoordinator.selector, stranger));
        vm.prank(stranger);
        v.createEvent("EVT-X", 6);

        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.UnauthorizedCoordinator.selector, stranger));
        vm.prank(stranger);
        v.recordVolunteerHours(1, C1, 4);
    }

    function test_R2_revert_otherCoordinatorsEvent() public {
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.NotEventOwner.selector, 1, coord2, coord));
        vm.prank(coord2);
        v.recordVolunteerHours(1, C1, 4);
    }

    function test_R2_revert_revokedCoordinator() public {
        v.revokeCoordinator(coord);
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.UnauthorizedCoordinator.selector, coord));
        vm.prank(coord);
        v.recordVolunteerHours(1, C1, 4);
    }

    // ---------- R3: one record per (event, commitment) ----------
    function test_R3_sameVolunteerOtherEvent() public {
        _record(4);
        vm.startPrank(coord);
        v.createEvent("EVT-002", 8);
        assertEq(v.recordVolunteerHours(2, C1, 8), 2);
        vm.stopPrank();
    }

    function test_R3_revert_duplicate() public {
        _record(4);
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.DuplicateVolunteerRecord.selector, 1, C1));
        _record(4);
    }

    // ---------- R4: hours 1..max, corrections too ----------
    function test_R4_maxHoursAccepted() public {
        assertEq(v.getRecord(_record(6)).hoursLogged, 6);
    }

    function test_R4_revert_overAndZero() public {
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.InvalidHours.selector, 10, 6));
        _record(10);
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.InvalidHours.selector, 0, 6));
        _record(0);

        _record(4);
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.InvalidHours.selector, 7, 6));
        vm.prank(coord);
        v.appendCorrection(1, 7, "TYPO_FIX");
    }

    // ---------- R5: issuer-only, head-only, never revoked ----------
    function test_R5_correctionAppendsWithoutEditing() public {
        _record(4);
        vm.prank(coord);
        uint256 id = v.appendCorrection(1, 5, "TYPO_FIX");

        VolunteerHours.VolunteerRecord memory old = v.getRecord(1);
        VolunteerHours.VolunteerRecord memory fix = v.getRecord(id);
        assertEq(old.hoursLogged, 4); // never edited
        assertEq(old.supersededBy, 2);
        assertEq(fix.hoursLogged, 5);
        assertEq(fix.replacesRecordId, 1);
        assertEq(fix.volunteerCommitment, C1);
        assertEq(uint8(fix.entryType), uint8(VolunteerHours.EntryType.CORRECTION));
    }

    function test_R5_revert_wrongIssuer() public {
        _record(4);
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.NotOriginalIssuer.selector, 1, coord2, coord));
        vm.prank(coord2);
        v.appendCorrection(1, 5, "TYPO_FIX");
    }

    function test_R5_revert_alreadySuperseded() public {
        _record(4);
        vm.startPrank(coord);
        v.appendCorrection(1, 5, "TYPO_FIX");
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.RecordAlreadySuperseded.selector, 1, 2));
        v.appendRevocation(1, "ATTENDANCE_VOID");
        vm.stopPrank();
    }

    function test_R5_revert_revoked() public {
        _record(3);
        vm.startPrank(coord);
        v.appendRevocation(1, "ATTENDANCE_VOID");
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.RecordIsRevoked.selector, 2));
        v.appendCorrection(2, 5, "TYPO_FIX");
        vm.stopPrank();
    }

    // ---------- Reads ----------
    function test_effectiveRecordTrail() public {
        _record(4);
        vm.startPrank(coord);
        v.appendCorrection(1, 5, "TYPO_FIX");
        v.appendRevocation(2, "ATTENDANCE_VOID");
        vm.stopPrank();

        (VolunteerHours.VolunteerRecord memory head, uint256[] memory trail) = v.getEffectiveRecord(1);
        assertEq(trail.length, 3);
        assertEq(trail[0], 1);
        assertEq(trail[1], 2);
        assertEq(trail[2], 3);
        assertEq(head.id, 3);
        assertEq(uint8(head.entryType), uint8(VolunteerHours.EntryType.REVOCATION));
        assertEq(head.hoursLogged, 0);
    }

    function test_recordsByCommitmentPagination() public {
        vm.startPrank(coord);
        for (uint16 i = 1; i <= 3; i++) {
            uint256 e = i == 1 ? 1 : v.createEvent("EVT-N", 6);
            v.recordVolunteerHours(e, C1, i);
        }
        v.appendCorrection(1, 5, "TYPO_FIX"); // corrections are not listed, only originals
        vm.stopPrank();

        (uint256[] memory ids, uint256 total) = v.getRecordsByCommitment(C1, 0, 2);
        assertEq(total, 3);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
        (ids,) = v.getRecordsByCommitment(C1, 2, 2);
        assertEq(ids.length, 1);
        assertEq(ids[0], 3);
        (ids,) = v.getRecordsByCommitment(C1, 5, 2);
        assertEq(ids.length, 0);
    }

    function test_revert_inputs() public {
        vm.startPrank(coord);
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.InvalidDuration.selector, 25));
        v.createEvent("EVT-X", 25);
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.EventNotFound.selector, 9));
        v.recordVolunteerHours(9, C1, 4);
        vm.expectRevert(VolunteerHours.EmptyCommitment.selector);
        v.recordVolunteerHours(1, bytes32(0), 4);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(VolunteerHours.RecordNotFound.selector, 1));
        v.getRecord(1);
        vm.expectRevert(VolunteerHours.InvalidAddress.selector);
        v.registerCoordinator(address(0), "x");
    }

    // ---------- Cross-language fingerprint ----------
    function test_hashMatchesEthers() public view {
        // node: ethers.solidityPackedKeccak256(["bytes32","string"], ["0x11..11", "S-001"]) (ethers 6.17.0)
        assertEq(C1, 0xa7b1d716439d91d8981184705ddf70871343088b2189d34ff687b3014dcc34b2);
    }
}
