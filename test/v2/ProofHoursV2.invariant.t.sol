// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ProofHoursLedger} from "../../src/v2/ProofHoursLedger.sol";
import {ProofHoursBadges} from "../../src/v2/ProofHoursBadges.sol";

/// Drives random issue / correct / revoke sequences as the coordinator.
contract LedgerHandler is Test {
    ProofHoursLedger public ledger;
    address public coord;
    address[3] public vols;
    uint256[] public originals;
    uint32 day;

    constructor(ProofHoursLedger l, address c, address[3] memory v) {
        (ledger, coord, vols) = (l, c, v);
        day = uint32(block.timestamp / 1 days);
    }

    function issue(uint8 volSeed, uint8 catSeed, uint16 h, bool newDay) external {
        if (newDay) day--;
        ProofHoursLedger.Category cat = ProofHoursLedger.Category(catSeed % 5);
        h = uint16(bound(h, 1, 12));
        vm.startPrank(coord);
        uint256 e = ledger.createEvent("INV", cat, 12, day);
        try ledger.issueHours(e, vols[volSeed % 3], h, 0) returns (uint256 id) {
            originals.push(id);
        } catch {}
        vm.stopPrank();
    }

    function correct(uint256 pick, uint16 h) external {
        if (originals.length == 0) return;
        uint256 head = ledger.headOf(originals[pick % originals.length]).id;
        vm.prank(coord);
        try ledger.correct(head, uint16(bound(h, 1, 12)), "INV") {} catch {}
    }

    function revoke(uint256 pick) external {
        if (originals.length == 0) return;
        uint256 head = ledger.headOf(originals[pick % originals.length]).id;
        vm.prank(coord);
        try ledger.revoke(head, "INV") {} catch {}
    }

    function originalsLength() external view returns (uint256) {
        return originals.length;
    }
}

contract ProofHoursV2Invariants is Test {
    ProofHoursLedger ledger;
    ProofHoursBadges badges;
    LedgerHandler handler;
    address[3] vols;

    function setUp() public {
        vm.warp(1_800_000_000);
        address gov = makeAddr("gov");
        address coord = makeAddr("coord");
        badges = new ProofHoursBadges(gov);
        ledger = new ProofHoursLedger(gov, badges, address(0));
        vm.startPrank(gov);
        badges.grantRole(badges.MINTER_ROLE(), address(ledger));
        uint256 org = ledger.registerOrg("Invariant NGO", gov, type(uint32).max);
        ledger.setCoordinator(coord, org);
        vm.stopPrank();
        vols = [makeAddr("v0"), makeAddr("v1"), makeAddr("v2")];
        for (uint256 i; i < 3; i++) {
            vm.prank(vols[i]);
            ledger.optIn();
        }
        handler = new LedgerHandler(ledger, coord, vols);
        targetContract(address(handler));
    }

    /// Guard against a vacuous pass: every run must have issued real records.
    function afterInvariant() public view {
        assertGt(handler.originalsLength(), 0, "run issued no records");
    }

    /// Totals always equal the sum of the latest entries of the volunteer's records, per category and overall.
    function invariant_totalsEqualSumOfLatestEntries() public view {
        uint256[3][5] memory sums;
        uint256 n = handler.originalsLength();
        for (uint256 i; i < n; i++) {
            ProofHoursLedger.Record memory h = ledger.headOf(handler.originals(i));
            uint256 eff = h.entryType == ProofHoursLedger.EntryType.Revocation ? 0 : h.hoursLogged;
            for (uint256 v; v < 3; v++) if (h.volunteer == vols[v]) sums[uint8(h.category)][v] += eff;
        }
        for (uint256 v; v < 3; v++) {
            uint256[5] memory cats = ledger.categoryHours(vols[v]);
            uint256 total;
            for (uint256 c; c < 5; c++) {
                assertEq(cats[c], sums[c][v], "category total");
                total += cats[c];
            }
            assertEq(ledger.totalHours(vols[v]), total, "overall total");
        }
    }

    /// A badge exists exactly when its milestone is met (nobody renounces in this run).
    function invariant_badgesMatchEligibility() public view {
        uint16[6] memory tt = badges.totalThresholds();
        uint16[5] memory ct = badges.categoryThresholds();
        for (uint256 v; v < 3; v++) {
            uint256 total = ledger.totalHours(vols[v]);
            for (uint256 i; i < 6; i++) {
                bool has = badges.tokenOfKey(badges.keyOf(vols[v], 0, tt[i])) != 0;
                assertEq(has, total >= tt[i], "total badge");
            }
            uint256[5] memory cats = ledger.categoryHours(vols[v]);
            for (uint8 c; c < 5; c++) {
                for (uint256 i; i < 5; i++) {
                    bool has = badges.tokenOfKey(badges.keyOf(vols[v], c + 1, ct[i])) != 0;
                    assertEq(has, cats[c] >= ct[i], "category badge");
                }
            }
        }
    }

    /// Every token a volunteer holds is a live, tracked milestone badge (no orphaned or duplicate tokens).
    function invariant_badgeBalanceMatchesLiveTokens() public view {
        for (uint256 v; v < 3; v++) {
            uint256 live;
            uint16[6] memory tt = badges.totalThresholds();
            for (uint256 i; i < 6; i++) if (badges.tokenOfKey(badges.keyOf(vols[v], 0, tt[i])) != 0) live++;
            uint16[5] memory ct = badges.categoryThresholds();
            for (uint8 c; c < 5; c++) for (uint256 i; i < 5; i++) if (badges.tokenOfKey(badges.keyOf(vols[v], c + 1, ct[i])) != 0) live++;
            assertEq(badges.balanceOf(vols[v]), live, "no orphaned or extra tokens");
        }
    }
}
