// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NameHash
/// @notice Canonical hashing of a legal business or person name for Confirmation of Payee.
/// @dev Normalisation keeps only ASCII letters and digits and lower-cases letters, so
///      "Nkechi Foods Ltd." and "NKECHI  FOODS LTD" hash to the same value. Off-chain code
///      (frontend / agent) must use the identical rule; see `packages/guardrails` (planned).
library NameHash {
    error EmptyName();

    function normalize(string memory name) internal pure returns (bytes memory out) {
        bytes memory raw = bytes(name);
        out = new bytes(raw.length);
        uint256 n;
        for (uint256 i; i < raw.length; ++i) {
            bytes1 c = raw[i];
            if (c >= 0x41 && c <= 0x5A) {
                out[n++] = bytes1(uint8(c) + 32); // A-Z -> a-z
            } else if ((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39)) {
                out[n++] = c; // a-z, 0-9
            }
        }
        if (n == 0) revert EmptyName();
        assembly {
            mstore(out, n)
        }
    }

    function hash(string memory name) internal pure returns (bytes32) {
        return keccak256(normalize(name));
    }
}
