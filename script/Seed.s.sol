// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {VolunteerHours} from "../src/VolunteerHours.sol";

/// Seeds the demo story into an already-deployed contract.
/// Env: ADMIN_PK, COORD_PK (testnet throwaway keys), CONTRACT (deployed address).
contract Seed is Script {
    // 0x...dEaD has no known private key: it is registered only so the demo console can staticCall
    // a correction "from another NGO" and show the NotOriginalIssuer refusal.
    address constant SECOND_COORDINATOR = 0x000000000000000000000000000000000000dEaD;

    string json;

    function run() external {
        uint256 adminPk = vm.envUint("ADMIN_PK");
        uint256 coordPk = vm.envUint("COORD_PK");
        VolunteerHours v = VolunteerHours(vm.envAddress("CONTRACT"));

        // demo-volunteers.js is `window.DEMO_VOLUNTEERS = [...];` (a script, so the page works from file://)
        json = vm.replace(vm.replace(vm.readFile("docs/demo-volunteers.js"), "window.DEMO_VOLUNTEERS = ", ""), ";", "");

        vm.startBroadcast(adminPk);
        v.registerCoordinator(vm.addr(coordPk), "Green Shores NGO (demo)");
        v.registerCoordinator(SECOND_COORDINATOR, "Desert Bloom NGO (demo)");
        vm.stopBroadcast();

        vm.startBroadcast(coordPk);
        uint256 e = v.createEvent("EVT-001 Beach Cleanup (demo)", 6);
        v.recordVolunteerHours(e, commitment(0), 4); // S-001 -> VALID
        uint256 r2 = v.recordVolunteerHours(e, commitment(1), 4); // S-002
        v.appendCorrection(r2, 5, "TYPO_FIX"); // -> CORRECTED (5h)
        uint256 r4 = v.recordVolunteerHours(e, commitment(2), 3); // S-003
        v.appendRevocation(r4, "ATTENDANCE_VOID"); // -> REVOKED
        vm.stopBroadcast();
    }

    function commitment(uint256 i) internal view returns (bytes32) {
        string memory p = string.concat("$[", vm.toString(i), "]");
        return keccak256(abi.encodePacked(vm.parseJsonBytes32(json, string.concat(p, ".salt")), vm.parseJsonString(json, string.concat(p, ".id"))));
    }
}
