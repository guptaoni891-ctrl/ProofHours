// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ProofHoursLedger} from "../src/v2/ProofHoursLedger.sol";
import {ProofHoursBadges} from "../src/v2/ProofHoursBadges.sol";

/// Deploys the V2 suite next to (never over) the V1 contract.
///
/// Local fork (default demo, no keys needed; the fork impersonates the deployer):
///   anvil --fork-url https://base-sepolia-rpc.publicnode.com --chain-id 31337 --port 8546
///   cast rpc anvil_impersonateAccount 0x0000000000000000000000000000000050000001 --rpc-url http://127.0.0.1:8546
///   cast rpc anvil_setBalance 0x0000000000000000000000000000000050000001 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8546
///   SEED_DEMO=true forge script script/DeployV2.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
///     --unlocked --sender 0x0000000000000000000000000000000050000001
///
/// Base Sepolia (ONLY after explicit approval): set GOVERNANCE to the multisig; the deployer grants it admin
/// and pauser, then renounces its own roles. Do not set SEED_DEMO on a public network.
///
/// Env: V1_ADDRESS (default: live V1), GOVERNANCE (default: deployer), SEED_DEMO (default false),
///      SEED_COORDINATOR (default: the V1 Green Shores wallet, so V1 records can be linked on a fork),
///      AUDITOR (optional: granted AUDITOR_ROLE and PAUSER_ROLE, so the auditor can contain an incident alone).
contract DeployV2 is Script {
    address constant LIVE_V1 = 0xFbDC02860EA7d34Cd563d8Bd4420C6F713e29F9b;
    address constant V1_GREEN_SHORES = 0x99f3a8E50c1d14AB62c2688f6f21635E32B10674;

    function run() external returns (ProofHoursBadges badges, ProofHoursLedger ledger) {
        address v1 = vm.envOr("V1_ADDRESS", LIVE_V1);
        address deployer = msg.sender;
        address governance = vm.envOr("GOVERNANCE", deployer);
        bool seed = vm.envOr("SEED_DEMO", false);
        address seedCoordinator = vm.envOr("SEED_COORDINATOR", V1_GREEN_SHORES);
        address auditor = vm.envOr("AUDITOR", address(0));

        vm.startBroadcast(deployer);
        badges = new ProofHoursBadges(deployer);
        ledger = new ProofHoursLedger(deployer, badges, v1);
        badges.grantRole(badges.MINTER_ROLE(), address(ledger));
        if (auditor != address(0)) {
            ledger.grantRole(ledger.AUDITOR_ROLE(), auditor);
            ledger.grantRole(ledger.PAUSER_ROLE(), auditor);
        }

        if (seed) {
            // fictional demo organisations; the deployer acts as their NGO admin on the local chain
            uint256 green = ledger.registerOrg("Green Shores NGO (demo)", deployer, 500);
            ledger.registerOrg("Desert Bloom NGO (demo)", deployer, 500);
            ledger.setCoordinator(seedCoordinator, green);
        }

        if (governance != deployer) {
            ledger.grantRole(ledger.DEFAULT_ADMIN_ROLE(), governance);
            ledger.grantRole(ledger.PAUSER_ROLE(), governance);
            badges.grantRole(badges.DEFAULT_ADMIN_ROLE(), governance);
            ledger.renounceRole(ledger.PAUSER_ROLE(), deployer);
            ledger.renounceRole(ledger.DEFAULT_ADMIN_ROLE(), deployer);
            badges.renounceRole(badges.DEFAULT_ADMIN_ROLE(), deployer);
        }
        vm.stopBroadcast();

        console2.log("ProofHoursBadges", address(badges));
        console2.log("ProofHoursLedger", address(ledger));
        console2.log("V1 (read-only)  ", v1);
        console2.log("governance      ", governance);
    }
}
