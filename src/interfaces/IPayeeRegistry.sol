// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPayeeRegistry {
    enum Status {
        None,
        Registered,
        Verified,
        Suspended
    }

    /// @notice Result of a Confirmation of Payee check, ordered from worst to best.
    enum CopResult {
        NoRecord, // address is not a registered payee
        Suspended, // payee flagged (e.g. fraud report); never pay
        NotVerified, // registered but no valid attestation
        VerificationExpired, // attestation lapsed
        NameMismatch, // verified, but the name the payer typed does not match
        Match // verified and the name matches
    }

    struct PayeeCore {
        address wallet;
        Status status;
        uint64 verifiedUntil;
        uint64 walletChangedAt;
    }

    function payeeIdOf(address wallet) external view returns (uint256);
    function payeeCore(uint256 payeeId) external view returns (PayeeCore memory);
    function walletChangeCooldown() external view returns (uint64);
    function confirmPayee(address wallet, bytes32 expectedNameHash)
        external
        view
        returns (CopResult result, uint256 payeeId, bool walletRecentlyChanged);
    function recordSettlement(uint256 payeeId, bool onTime) external;
}
