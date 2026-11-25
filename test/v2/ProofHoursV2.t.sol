// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {VolunteerHours} from "../../src/VolunteerHours.sol";
import {ProofHoursLedger} from "../../src/v2/ProofHoursLedger.sol";
import {ProofHoursBadges} from "../../src/v2/ProofHoursBadges.sol";
import {IERC5192} from "../../src/v2/interfaces/IERC5192.sol";
import {IERC5484} from "../../src/v2/interfaces/IERC5484.sol";

/// Shared fixture: governance, an auditor, one NGO with admin + coordinator, a second NGO, opted-in volunteers,
/// and a real V1 contract with one record issued by the same coordinator wallet.
abstract contract V2Fixture is Test {
    ProofHoursLedger ledger;
    ProofHoursBadges badges;
    VolunteerHours v1;

    address gov = makeAddr("governance");
    address auditor = makeAddr("auditor");
    address ngoAdmin = makeAddr("ngoAdmin");
    address coord = makeAddr("coordinator");
    address ngo2Admin = makeAddr("ngo2Admin");
    address coord2 = makeAddr("coordinator2");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");
    uint256 org1;
    uint256 org2;
    uint32 today;
    uint32 cursor; // next free service day for _grant

    ProofHoursLedger.Category constant ENV = ProofHoursLedger.Category.Environmental;
    ProofHoursLedger.Category constant EDU = ProofHoursLedger.Category.Education;
    ProofHoursLedger.Category constant EMR = ProofHoursLedger.Category.Emergency;

    // V1 fixture: S-001-style commitment issued by `coord` (who is also a V2 coordinator)
    bytes32 constant V1_COMMIT = keccak256("S-001 demo commitment");
    uint256 v1RecordId;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        today = uint32(block.timestamp / 1 days);
        cursor = today;

        vm.prank(gov);
        v1 = new VolunteerHours();
        vm.prank(gov);
        v1.registerCoordinator(coord, "Green Shores NGO (demo)");
        vm.startPrank(coord);
        uint256 v1Event = v1.createEvent("EVT-001 Beach Cleanup (demo)", 6);
        v1RecordId = v1.recordVolunteerHours(v1Event, V1_COMMIT, 4);
        vm.stopPrank();

        badges = new ProofHoursBadges(gov);
        ledger = new ProofHoursLedger(gov, badges, address(v1));
        vm.startPrank(gov);
        badges.grantRole(badges.MINTER_ROLE(), address(ledger));
        ledger.grantRole(ledger.AUDITOR_ROLE(), auditor);
        ledger.grantRole(ledger.PAUSER_ROLE(), auditor);
        org1 = ledger.registerOrg("Green Shores NGO (demo)", ngoAdmin, 500);
        org2 = ledger.registerOrg("Desert Bloom NGO (demo)", ngo2Admin, 500);
        vm.stopPrank();
        vm.prank(ngoAdmin);
        ledger.setCoordinator(coord, org1);
        vm.prank(ngo2Admin);
        ledger.setCoordinator(coord2, org2);
        vm.prank(alice);
        ledger.optIn();
        vm.prank(bob);
        ledger.optIn();
    }

    function _event(ProofHoursLedger.Category cat, uint16 maxHours, uint32 day) internal returns (uint256 id) {
        vm.prank(coord);
        id = ledger.createEvent("EVT-T (demo)", cat, maxHours, day);
    }

    function _issue(uint256 eventId, address v, uint16 h) internal returns (uint256 id) {
        vm.prank(coord);
        id = ledger.issueHours(eventId, v, h, keccak256("evidence"));
    }

    /// Gives `v` `n` hours in `cat`, spread over past days so the 12h/day cap is respected.
    function _grant(address v, ProofHoursLedger.Category cat, uint256 n) internal {
        while (n > 0) {
            uint16 h = n >= 12 ? 12 : uint16(n);
            _issue(_event(cat, 12, cursor), v, h);
            n -= h;
            cursor--;
        }
    }

    function _badgeId(address v, uint8 kind, uint16 t) internal view returns (uint256) {
        return badges.tokenOfKey(badges.keyOf(v, kind, t));
    }
}

contract ProofHoursLedgerTest is V2Fixture {
    // ---------- permissions ----------

    function test_coordinatorCannotGrantItselfAnyRole() public {
        bytes32 adminRole = ledger.DEFAULT_ADMIN_ROLE();
        bytes32 auditorRole = ledger.AUDITOR_ROLE();
        vm.startPrank(coord);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, coord, adminRole));
        ledger.grantRole(adminRole, coord);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, coord, adminRole));
        ledger.grantRole(auditorRole, coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotOrgAdmin.selector, org1, coord));
        ledger.setCoordinator(mallory, org1);
        vm.stopPrank();
    }

    function test_orgAdminCannotTakeOverAnotherNgosCoordinator() public {
        vm.prank(ngoAdmin);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.CoordinatorOfOtherOrg.selector, coord2, org2));
        ledger.setCoordinator(coord2, org1);
        vm.prank(ngoAdmin);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotOrgAdmin.selector, org2, ngoAdmin));
        ledger.setCoordinator(mallory, org2);
    }

    function test_onlyGovernanceRegistersOrgs() public {
        bytes32 adminRole = ledger.DEFAULT_ADMIN_ROLE();
        vm.prank(ngoAdmin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ngoAdmin, adminRole));
        ledger.registerOrg("Sham NGO", ngoAdmin, 1_000_000);
    }

    function test_removedCoordinatorCannotIssue() public {
        uint256 e = _event(ENV, 6, today);
        vm.prank(ngoAdmin);
        ledger.removeCoordinator(coord);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotCoordinator.selector, coord));
        ledger.issueHours(e, alice, 4, 0);
    }

    // ---------- issuance rules ----------

    function test_issueRequiresVolunteerOptIn() public {
        uint256 e = _event(ENV, 6, today);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotOptedIn.selector, mallory));
        ledger.issueHours(e, mallory, 4, 0);
    }

    function test_noDuplicatePerEventAndVolunteer() public {
        uint256 e = _event(ENV, 6, today);
        _issue(e, alice, 4);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.DuplicateRecord.selector, e, alice));
        ledger.issueHours(e, alice, 2, 0);
    }

    function test_hoursWithinEventLimits() public {
        uint256 e = _event(ENV, 6, today);
        vm.startPrank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.InvalidHours.selector, 7, 6));
        ledger.issueHours(e, alice, 7, 0);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.InvalidHours.selector, 0, 6));
        ledger.issueHours(e, alice, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.InvalidDuration.selector, 25));
        ledger.createEvent("too long", ENV, 25, today);
        vm.stopPrank();
    }

    function test_cannotIssueForAnotherNgosEvent() public {
        uint256 e = _event(ENV, 6, today);
        vm.prank(coord2);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.WrongOrg.selector, org1, org2));
        ledger.issueHours(e, alice, 4, 0);
    }

    function test_cannotIssueForFutureService() public {
        uint256 e = _event(ENV, 6, today + 1);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.ServiceDayInFuture.selector, today + 1, today));
        ledger.issueHours(e, alice, 4, 0);
    }

    function test_dailyCapTwelveHoursAcrossEvents() public {
        _issue(_event(ENV, 8, today), alice, 8);
        uint256 e2 = _event(EDU, 8, today);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.DailyCapExceeded.selector, alice, today, 13, 12));
        ledger.issueHours(e2, alice, 5, 0);
        _issue(e2, alice, 4); // exactly 12
    }

    function test_emergencyEventsMayExceedTwelveUpTo24() public {
        _issue(_event(EMR, 24, today), alice, 20);
        assertEq(ledger.totalHours(alice), 20);
    }

    function test_orgDailyIssuanceCap() public {
        vm.prank(gov);
        ledger.setOrgDailyCap(org1, 10);
        _issue(_event(ENV, 6, today), alice, 6);
        uint256 e2 = _event(ENV, 6, today);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.OrgDailyCapExceeded.selector, org1, 11, 10));
        ledger.issueHours(e2, bob, 5, 0);
    }

    function test_auditorSuspendsOrgButOnlyGovernanceReinstates() public {
        uint256 e = _event(ENV, 6, today);
        vm.prank(auditor);
        ledger.suspendOrg(org1);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.OrgIsSuspended.selector, org1));
        ledger.issueHours(e, alice, 4, 0);
        bytes32 adminRole = ledger.DEFAULT_ADMIN_ROLE();
        vm.prank(auditor);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, auditor, adminRole));
        ledger.reinstateOrg(org1);
        vm.prank(gov);
        ledger.reinstateOrg(org1);
        _issue(e, alice, 4);
    }

    function test_strangerCannotSuspend() public {
        bytes32 auditorRole = ledger.AUDITOR_ROLE();
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, auditorRole));
        ledger.suspendOrg(org1);
    }

    function test_pauseStopsIssuanceAndOnlyGovernanceUnpauses() public {
        uint256 e = _event(ENV, 6, today);
        vm.prank(auditor);
        ledger.pause();
        vm.prank(coord);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        ledger.issueHours(e, alice, 4, 0);
        bytes32 adminRole = ledger.DEFAULT_ADMIN_ROLE();
        vm.prank(auditor);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, auditor, adminRole));
        ledger.unpause();
        vm.prank(gov);
        ledger.unpause();
        _issue(e, alice, 4);
    }

    function test_batchIssuanceIsAllOrNothing() public {
        uint256 e = _event(ENV, 6, today);
        address[] memory vs = new address[](2);
        uint16[] memory hs = new uint16[](2);
        bytes32[] memory ev = new bytes32[](2);
        (vs[0], vs[1], hs[0], hs[1]) = (alice, mallory, 4, 4); // mallory never opted in
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotOptedIn.selector, mallory));
        ledger.issueBatch(e, vs, hs, ev);
        assertEq(ledger.totalHours(alice), 0, "nothing issued");
        vs[1] = bob;
        vm.prank(coord);
        uint256 first = ledger.issueBatch(e, vs, hs, ev);
        assertEq(ledger.totalHours(alice) + ledger.totalHours(bob), 8);
        assertEq(ledger.getRecord(first).volunteer, alice);
    }

    function test_optOutStopsNewIssuanceButKeepsHistory() public {
        _issue(_event(ENV, 6, today), alice, 4);
        vm.prank(alice);
        ledger.optOut();
        uint256 e2 = _event(ENV, 6, today - 1);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotOptedIn.selector, alice));
        ledger.issueHours(e2, alice, 4, 0);
        assertEq(ledger.totalHours(alice), 4);
    }

    // ---------- cumulative accounting, corrections, revocations ----------

    function test_totalsByCategory() public {
        _grant(alice, ENV, 15);
        _grant(alice, EDU, 7);
        uint256[5] memory c = ledger.categoryHours(alice);
        assertEq(ledger.totalHours(alice), 22);
        assertEq(c[0], 15);
        assertEq(c[1], 7);
    }

    function test_correctionAppendsAndAdjustsTotals() public {
        uint256 r = _issue(_event(ENV, 6, today), alice, 4);
        vm.prank(coord);
        uint256 c = ledger.correct(r, 6, "TYPO_FIX");
        assertEq(ledger.totalHours(alice), 6);
        assertEq(ledger.getRecord(r).hoursLogged, 4, "original kept");
        assertEq(ledger.getRecord(r).supersededBy, c);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.RecordAlreadySuperseded.selector, r, c));
        ledger.correct(r, 5, "AGAIN");
    }

    function test_correctionRespectsDailyCapAndOtherNgoCannotCorrect() public {
        uint256 r = _issue(_event(ENV, 6, today), alice, 6);
        _issue(_event(ENV, 6, today), alice, 6);
        uint256 rBig = r; // day is full (12h)
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.InvalidHours.selector, 7, 6));
        ledger.correct(rBig, 7, "X");
        vm.prank(coord2);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.WrongOrg.selector, org1, org2));
        ledger.correct(r, 5, "X");
        vm.prank(coord);
        ledger.correct(r, 5, "LOWER"); // frees an hour on that day
        assertEq(ledger.dayHours(alice, today), 11);
    }

    function test_revocationZeroesAndIsTerminal() public {
        uint256 r = _issue(_event(ENV, 6, today), alice, 4);
        vm.prank(coord);
        uint256 x = ledger.revoke(r, "ATTENDANCE_VOID");
        assertEq(ledger.totalHours(alice), 0);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.RecordIsRevoked.selector, x));
        ledger.correct(x, 3, "UNDO");
    }

    function test_governanceCanRevokeAfterDispute() public {
        uint256 r = _issue(_event(ENV, 6, today), alice, 4);
        vm.prank(gov);
        ledger.revoke(r, "DISPUTE_UPHELD");
        assertEq(ledger.totalHours(alice), 0);
    }

    // ---------- badges ----------

    function test_badgesMintAtMilestonesAndAreSoulbound() public {
        _grant(alice, ENV, 10);
        uint256 total10 = _badgeId(alice, 0, 10);
        uint256 env10 = _badgeId(alice, 1, 10);
        assertTrue(total10 != 0 && env10 != 0, "10h total + 10h Environmental minted");
        assertEq(badges.ownerOf(total10), alice);
        assertTrue(badges.locked(total10));
        assertEq(uint8(badges.burnAuth(total10)), uint8(IERC5484.BurnAuth.Both));
        assertEq(_badgeId(alice, 0, 25), 0, "25h not yet");
        _grant(alice, EDU, 16); // total 26
        assertTrue(_badgeId(alice, 0, 25) != 0);
        assertTrue(_badgeId(alice, 2, 10) != 0, "10h Education");
    }

    function test_allTransferPathsRevert() public {
        _grant(alice, ENV, 10);
        uint256 id = _badgeId(alice, 0, 10);
        vm.startPrank(alice);
        vm.expectRevert(ProofHoursBadges.Soulbound.selector);
        badges.transferFrom(alice, bob, id);
        vm.expectRevert(ProofHoursBadges.Soulbound.selector);
        badges.safeTransferFrom(alice, bob, id);
        vm.expectRevert(ProofHoursBadges.Soulbound.selector);
        badges.safeTransferFrom(alice, bob, id, "");
        vm.expectRevert(ProofHoursBadges.Soulbound.selector);
        badges.approve(bob, id);
        vm.expectRevert(ProofHoursBadges.Soulbound.selector);
        badges.setApprovalForAll(bob, true);
        vm.stopPrank();
        assertEq(badges.ownerOf(id), alice);
    }

    function test_interfaceIds() public view {
        assertTrue(badges.supportsInterface(0xb45a3c0e), "ERC-5192");
        assertEq(type(IERC5192).interfaceId, bytes4(0xb45a3c0e));
        assertTrue(badges.supportsInterface(type(IERC5484).interfaceId), "ERC-5484");
        assertTrue(badges.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(badges.supportsInterface(0x5b5e139f), "ERC-721 Metadata");
        assertTrue(badges.supportsInterface(0x01ffc9a7), "ERC-165");
        assertFalse(badges.supportsInterface(0xffffffff));
    }

    function test_correctionBelowMilestoneBurnsBadgeAndRecrossingReMints() public {
        uint256 r = _issue(_event(ENV, 10, today), alice, 10);
        uint256 id = _badgeId(alice, 0, 10);
        assertTrue(id != 0);
        vm.prank(coord);
        uint256 c = ledger.correct(r, 8, "TYPO_FIX");
        assertEq(_badgeId(alice, 0, 10), 0, "burned");
        vm.expectRevert();
        badges.ownerOf(id);
        vm.prank(coord);
        ledger.correct(c, 10, "TYPO_FIX");
        uint256 again = _badgeId(alice, 0, 10);
        assertTrue(again != 0 && again != id, "new token, old one stays burned");
    }

    function test_revocationBurnsBadges() public {
        uint256 r = _issue(_event(ENV, 10, today), alice, 10);
        vm.prank(coord);
        ledger.revoke(r, "FRAUD");
        assertEq(_badgeId(alice, 0, 10), 0);
        assertEq(_badgeId(alice, 1, 10), 0);
    }

    function test_holderRenouncesAndReclaims() public {
        _grant(alice, ENV, 10);
        uint256 id = _badgeId(alice, 0, 10);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursBadges.NotBadgeOwner.selector, id));
        badges.renounce(id);
        vm.prank(alice);
        badges.renounce(id);
        _grant(alice, ENV, 1); // a later sync must not re-mint a renounced badge
        assertEq(_badgeId(alice, 0, 10), 0);
        vm.prank(alice);
        badges.reclaim(0, 10);
        ledger.resyncBadges(alice);
        assertTrue(_badgeId(alice, 0, 10) != 0);
    }

    function test_onlyLedgerCanMint() public {
        bytes32 minterRole = badges.MINTER_ROLE();
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, mallory, minterRole));
        badges.sync(mallory, 500, 0, 500);
    }

    function test_reaching500MintsEveryTotalMilestone() public {
        _grant(alice, ENV, 500);
        uint16[6] memory t = badges.totalThresholds();
        for (uint256 i; i < 6; i++) assertTrue(_badgeId(alice, 0, t[i]) != 0);
        uint16[5] memory ct = badges.categoryThresholds();
        for (uint256 i; i < 5; i++) assertTrue(_badgeId(alice, 1, ct[i]) != 0);
        assertEq(badges.balanceOf(alice), 11);
    }

    function test_tokenUriIsOnChainJsonWithSvg() public {
        _grant(alice, ENV, 10);
        string memory uri = badges.tokenURI(_badgeId(alice, 1, 10));
        assertTrue(_startsWith(uri, "data:application/json;base64,"));
        string memory json = string(Base64Decode.decode(_after(uri, 29)));
        assertTrue(_contains(json, '"name":"ProofHours'), "name");
        assertTrue(_contains(json, "10h Environmental"), "title");
        assertTrue(_contains(json, '"image":"data:image/svg+xml;base64,'), "image");
        assertTrue(_contains(json, '"Transferable","value":"No"'), "trait");
    }

    // ---------- V1 migration ----------

    function test_v1MigrationNeedsVolunteerConsentAndIssuerApproval() public {
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NoLinkRequest.selector, v1RecordId));
        ledger.approveV1Link(v1RecordId, ENV);
        vm.prank(mallory); // not opted in
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotOptedIn.selector, mallory));
        ledger.requestV1Link(v1RecordId);
        vm.prank(alice);
        ledger.requestV1Link(v1RecordId);
        vm.prank(coord2); // a V2 coordinator, but not the V1 issuer
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotV1Issuer.selector, v1RecordId, coord2, coord));
        ledger.approveV1Link(v1RecordId, ENV);
        vm.prank(coord);
        uint256 id = ledger.approveV1Link(v1RecordId, ENV);
        assertEq(ledger.totalHours(alice), 4, "hours read from V1, not typed in");
        assertEq(ledger.getRecord(id).v1RecordId, v1RecordId);
        assertEq(uint8(ledger.getRecord(id).entryType), uint8(ProofHoursLedger.EntryType.MigratedV1));
    }

    function test_v1RecordCannotBeClaimedTwice() public {
        vm.prank(alice);
        ledger.requestV1Link(v1RecordId);
        vm.prank(coord);
        uint256 id = ledger.approveV1Link(v1RecordId, ENV);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.AlreadyMigrated.selector, v1RecordId, id));
        ledger.requestV1Link(v1RecordId);
    }

    function test_v1CorrectionAndRevocationFlowThroughSync() public {
        vm.prank(alice);
        ledger.requestV1Link(v1RecordId);
        vm.prank(coord);
        uint256 id = ledger.approveV1Link(v1RecordId, ENV);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NothingToSync.selector, v1RecordId));
        ledger.syncV1(v1RecordId);
        vm.prank(coord);
        uint256 v1c = v1.appendCorrection(v1RecordId, 5, "TYPO_FIX");
        ledger.syncV1(v1RecordId); // anyone may sync
        assertEq(ledger.totalHours(alice), 5);
        vm.prank(coord);
        v1.appendRevocation(v1c, "ATTENDANCE_VOID");
        ledger.syncV1(v1RecordId);
        assertEq(ledger.totalHours(alice), 0);
        assertEq(uint8(ledger.headOf(id).entryType), uint8(ProofHoursLedger.EntryType.Revocation));
        // V2 coordinators cannot edit imported records directly
        vm.prank(coord);
        vm.expectRevert();
        ledger.correct(id, 3, "NO");
    }

    function test_v1ImportOfCorrectedRecordUsesCurrentHours() public {
        vm.prank(coord);
        v1.appendCorrection(v1RecordId, 6, "TYPO_FIX");
        vm.prank(alice);
        ledger.requestV1Link(v1RecordId);
        vm.prank(coord);
        ledger.approveV1Link(v1RecordId, EDU);
        assertEq(ledger.categoryHours(alice)[1], 6);
    }

    function test_v1ImportFollowsTrailsLongerThanV1PageSize() public {
        uint256 head = v1RecordId;
        vm.startPrank(coord);
        for (uint16 i; i < 30; i++) head = v1.appendCorrection(head, i == 29 ? 6 : 5, "TYPO_FIX"); // 31 entries > MAX_TRAIL 25
        vm.stopPrank();
        vm.prank(alice);
        ledger.requestV1Link(v1RecordId);
        vm.prank(coord);
        ledger.approveV1Link(v1RecordId, ENV);
        assertEq(ledger.totalHours(alice), 6, "hours of the true head, not the 25th entry");
    }

    function test_v1CorrectionEntryIsNotAnOriginal() public {
        vm.prank(coord);
        uint256 v1c = v1.appendCorrection(v1RecordId, 6, "TYPO_FIX");
        vm.prank(alice);
        ledger.requestV1Link(v1c);
        vm.prank(coord);
        vm.expectRevert(abi.encodeWithSelector(ProofHoursLedger.NotV1Original.selector, v1c));
        ledger.approveV1Link(v1c, ENV);
    }

    // ---------- fuzz ----------

    function testFuzz_issueCorrectRevokeKeepsTotalsExact(uint16 a, uint16 b, bool revokeIt) public {
        a = uint16(bound(a, 1, 12));
        b = uint16(bound(b, 1, 12));
        uint256 r = _issue(_event(ENV, 12, today), alice, a);
        vm.prank(coord);
        uint256 c = ledger.correct(r, b, "FIX");
        uint256 expected = b;
        if (revokeIt) {
            vm.prank(coord);
            ledger.revoke(c, "VOID");
            expected = 0;
        }
        assertEq(ledger.totalHours(alice), expected);
        assertEq(ledger.categoryHours(alice)[0], expected);
        assertEq(_badgeId(alice, 0, 10) != 0, expected >= 10);
    }

    // ---------- helpers ----------

    function _startsWith(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    function _after(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory a = bytes(s);
        bytes memory out = new bytes(a.length - n);
        for (uint256 i; i < out.length; i++) out[i] = a[i + n];
        return string(out);
    }

    function _contains(string memory s, string memory p) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(p);
        if (b.length > a.length) return false;
        for (uint256 i; i <= a.length - b.length; i++) {
            bool ok = true;
            for (uint256 j; j < b.length && ok; j++) if (a[i + j] != b[j]) ok = false;
            if (ok) return true;
        }
        return false;
    }
}

/// Minimal base64 decoder for test assertions only (OpenZeppelin ships an encoder).
library Base64Decode {
    function decode(string memory data) internal pure returns (bytes memory out) {
        bytes memory d = bytes(data);
        uint256 pad = d.length > 0 && d[d.length - 1] == "=" ? (d.length > 1 && d[d.length - 2] == "=" ? 2 : 1) : 0;
        out = new bytes((d.length / 4) * 3 - pad);
        uint256 o;
        for (uint256 i; i < d.length; i += 4) {
            uint256 n = (_v(d[i]) << 18) | (_v(d[i + 1]) << 12) | (_v(d[i + 2]) << 6) | _v(d[i + 3]);
            for (uint256 k; k < 3 && o < out.length; k++) out[o++] = bytes1(uint8(n >> (16 - 8 * k)));
        }
    }

    function _v(bytes1 c) private pure returns (uint256) {
        if (c >= "A" && c <= "Z") return uint8(c) - 65;
        if (c >= "a" && c <= "z") return uint8(c) - 71;
        if (c >= "0" && c <= "9") return uint8(c) + 4;
        if (c == "+") return 62;
        if (c == "/") return 63;
        return 0; // '='
    }
}
