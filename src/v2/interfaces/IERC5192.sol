// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.28;

/// @title ERC-5192: Minimal Soulbound NFTs (https://eips.ethereum.org/EIPS/eip-5192). Interface id 0xb45a3c0e.
interface IERC5192 {
    /// Emitted when the locking status is changed to locked. If a token is minted and the status is locked,
    /// this event should be emitted.
    event Locked(uint256 tokenId);

    /// Emitted when the locking status is changed to unlocked.
    event Unlocked(uint256 tokenId);

    /// Returns the locking status of a Soulbound Token. Throws for assignments to the zero address.
    function locked(uint256 tokenId) external view returns (bool);
}
