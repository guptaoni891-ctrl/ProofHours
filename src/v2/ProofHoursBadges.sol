// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC5192} from "./interfaces/IERC5192.sol";
import {IERC5484} from "./interfaces/IERC5484.sol";

/// @title ProofHours milestone badges (soulbound, ERC-5192 + ERC-5484).
/// @notice A badge exists exactly while its holder's verified hours meet the milestone:
///         the ledger (MINTER_ROLE) mints it when hours cross the threshold and burns it if a
///         correction or revocation drops them below. Badges never move between wallets.
///         The holder may renounce (burn) a badge; it is then not re-minted until they reclaim it.
///         Metadata and artwork are generated on-chain, so they cannot drift from the chain state.
contract ProofHoursBadges is ERC721, AccessControl, IERC5192, IERC5484 {
    using Strings for uint256;

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint8 public constant KIND_TOTAL = 0; // kinds 1..5 = impact category index + 1

    error Soulbound();
    error NotBadgeOwner(uint256 tokenId);
    error NotRenounced();
    error InvalidKind(uint8 kind);

    struct Badge {
        uint8 kind;
        uint16 threshold;
        uint64 issuedAt;
    }

    mapping(uint256 tokenId => Badge) public badges;
    mapping(bytes32 key => uint256 tokenId) public tokenOfKey; // live token for (volunteer, kind, threshold)
    mapping(bytes32 key => bool) public renounced;
    uint256 public nextTokenId = 1;

    event BadgeRevoked(uint256 indexed tokenId, address indexed volunteer, uint8 kind, uint16 threshold);
    event BadgeRenounced(uint256 indexed tokenId, address indexed volunteer, uint8 kind, uint16 threshold);
    event BadgeReclaimed(address indexed volunteer, uint8 kind, uint16 threshold);

    constructor(address admin) ERC721("ProofHours Milestone Badge", "PHBADGE") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------- Milestones (from the discovery plan: totals 10/25/50/100/250/500, categories 10/50/100/250/500) ----------

    function totalThresholds() public pure returns (uint16[6] memory) {
        return [uint16(10), 25, 50, 100, 250, 500];
    }

    function categoryThresholds() public pure returns (uint16[5] memory) {
        return [uint16(10), 50, 100, 250, 500];
    }

    function keyOf(address volunteer, uint8 kind, uint16 threshold) public pure returns (bytes32) {
        return keccak256(abi.encode(volunteer, kind, threshold));
    }

    /// @notice Reconciles a volunteer's badges with their current verified totals. Idempotent.
    /// @param category impact category whose total changed (0..4)
    function sync(address volunteer, uint256 totalHours, uint8 category, uint256 categoryHours) external onlyRole(MINTER_ROLE) {
        if (category > 4) revert InvalidKind(category + 1);
        uint16[6] memory tt = totalThresholds();
        for (uint256 i; i < tt.length; i++) _reconcile(volunteer, KIND_TOTAL, tt[i], totalHours >= tt[i]);
        uint16[5] memory ct = categoryThresholds();
        for (uint256 i; i < ct.length; i++) _reconcile(volunteer, category + 1, ct[i], categoryHours >= ct[i]);
    }

    function _reconcile(address volunteer, uint8 kind, uint16 threshold, bool eligible) internal {
        bytes32 k = keyOf(volunteer, kind, threshold);
        uint256 id = tokenOfKey[k];
        if (eligible && id == 0 && !renounced[k]) {
            id = nextTokenId++;
            tokenOfKey[k] = id;
            badges[id] = Badge(kind, threshold, uint64(block.timestamp));
            _mint(volunteer, id); // not _safeMint: no receiver callback, so no reentrancy into the ledger
            emit Locked(id);
            emit Issued(address(this), volunteer, id, BurnAuth.Both);
        } else if (!eligible && id != 0) {
            delete tokenOfKey[k];
            emit BadgeRevoked(id, volunteer, kind, threshold);
            _burn(id);
        }
    }

    // ---------- Holder consent (ERC-5484 BurnAuth.Both) ----------

    /// @notice The holder burns their own badge and opts out of having it re-minted.
    function renounce(uint256 tokenId) external {
        address holder = ownerOf(tokenId);
        if (holder != msg.sender) revert NotBadgeOwner(tokenId);
        Badge memory b = badges[tokenId];
        bytes32 k = keyOf(holder, b.kind, b.threshold);
        renounced[k] = true;
        delete tokenOfKey[k];
        emit BadgeRenounced(tokenId, holder, b.kind, b.threshold);
        _burn(tokenId);
    }

    /// @notice The holder opts back in; the next ledger sync re-mints the badge if still eligible.
    function reclaim(uint8 kind, uint16 threshold) external {
        bytes32 k = keyOf(msg.sender, kind, threshold);
        if (!renounced[k]) revert NotRenounced();
        renounced[k] = false;
        emit BadgeReclaimed(msg.sender, kind, threshold);
    }

    // ---------- Soulbound behaviour ----------

    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function burnAuth(uint256 tokenId) external view returns (BurnAuth) {
        _requireOwned(tokenId);
        return BurnAuth.Both;
    }

    /// Every transfer path in ERC721 (transferFrom, both safeTransferFrom) goes through _update:
    /// only mint (from == 0) and burn (to == 0) are allowed.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return interfaceId == type(IERC5192).interfaceId || interfaceId == type(IERC5484).interfaceId || super.supportsInterface(interfaceId);
    }

    // ---------- On-chain metadata ----------

    function kindName(uint8 kind) public pure returns (string memory) {
        if (kind == 0) return "All causes";
        if (kind == 1) return "Environmental";
        if (kind == 2) return "Education";
        if (kind == 3) return "Healthcare";
        if (kind == 4) return "Emergency response";
        if (kind == 5) return "Inclusion";
        revert InvalidKind(kind);
    }

    function _accent(uint8 kind) internal pure returns (string memory) {
        if (kind == 1) return "#4fc58c";
        if (kind == 2) return "#8a90f7";
        if (kind == 3) return "#f06363";
        if (kind == 4) return "#e2a640";
        if (kind == 5) return "#5bc0eb";
        return "#f4f4f5";
    }

    /// Tier index 1..6 used by the artwork: more threshold, more ring segments.
    function _tier(uint16 threshold) internal pure returns (uint256) {
        if (threshold >= 500) return 6;
        if (threshold >= 250) return 5;
        if (threshold >= 100) return 4;
        if (threshold >= 50) return 3;
        if (threshold >= 25) return 2;
        return 1;
    }

    function _ring(string memory accent, uint256 tier) internal pure returns (string memory segs) {
        // six arcs around the medallion; earned tiers are drawn in the accent colour
        for (uint256 i; i < 6; i++) {
            segs = string.concat(
                segs,
                '<circle cx="200" cy="170" r="92" fill="none" stroke-width="6" stroke-linecap="round" pathLength="600" stroke-dasharray="84 516" stroke-dashoffset="',
                (600 - i * 100).toString(),
                '" stroke="',
                i < tier ? accent : "#2b2c32",
                '"/>'
            );
        }
    }

    function _svg(Badge memory b) internal pure returns (string memory) {
        string memory accent = _accent(b.kind);
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" font-family="Inter,Segoe UI,system-ui,sans-serif">',
            '<rect width="400" height="400" rx="28" fill="#0e0f12"/><rect x="0.5" y="0.5" width="399" height="399" rx="27.5" fill="none" stroke="#2b2c32"/>',
            _ring(accent, _tier(b.threshold)),
            '<text x="200" y="182" text-anchor="middle" font-size="64" font-weight="600" fill="#f4f4f5" letter-spacing="-3">',
            uint256(b.threshold).toString(),
            '<tspan font-size="30" fill="#a4a5ad">h</tspan></text>',
            '<text x="200" y="306" text-anchor="middle" font-size="22" font-weight="600" fill="',
            accent,
            '">',
            kindName(b.kind),
            '</text><text x="200" y="338" text-anchor="middle" font-size="14" fill="#80828b">ProofHours verified milestone \xc2\xb7 soulbound</text></svg>'
        );
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        Badge memory b = badges[tokenId];
        string memory name = string.concat(uint256(b.threshold).toString(), "h ", kindName(b.kind));
        string memory json = string.concat(
            '{"name":"ProofHours \xc2\xb7 ',
            name,
            '","description":"Non-transferable milestone badge. It exists only while the holder\'s verified volunteer hours, recorded by accredited NGOs on the ProofHours ledger, meet this milestone.",',
            '"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_svg(b))),
            '","attributes":[{"trait_type":"Impact area","value":"',
            kindName(b.kind),
            '"},{"trait_type":"Milestone hours","display_type":"number","value":',
            uint256(b.threshold).toString(),
            '},{"trait_type":"Issued at","display_type":"date","value":',
            uint256(b.issuedAt).toString(),
            '},{"trait_type":"Transferable","value":"No"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
