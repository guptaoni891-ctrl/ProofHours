// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.28;

/// @title ERC-5484: Consensual Soulbound Tokens (https://eips.ethereum.org/EIPS/eip-5484).
interface IERC5484 {
    /// Who may burn a token. ProofHours badges use Both: the issuer (when verified hours drop below the
    /// milestone) and the owner (renouncing a badge they no longer want).
    enum BurnAuth {
        IssuerOnly,
        OwnerOnly,
        Both,
        Neither
    }

    /// Emitted when a soulbound token is issued.
    event Issued(address indexed from, address indexed to, uint256 indexed tokenId, BurnAuth burnAuth);

    /// Returns the burn authorization of a token; immutable once issued.
    function burnAuth(uint256 tokenId) external view returns (BurnAuth);
}
