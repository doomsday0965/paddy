// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BasePaymaster} from "@account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";

/// @title PaddyPaymaster: sponsors gas for enrolled Paddy accounts, within limits
/// @notice SMEs and their AI clerk never need to hold tQDAY. The operator enrols accounts; each
///         enrolled account has a daily gas allowance (in wei) and a per-operation ceiling, so a
///         compromised session key can't drain the sponsor. Every sponsored op emits an event.
/// @dev QDay's own stablecoin paymaster isn't published for Aevum Testnet yet; this can be swapped
///      out for it later without touching PaddyAccount.
contract PaddyPaymaster is BasePaymaster {
    struct Sponsorship {
        bool enrolled;
        uint32 day;
        uint128 dailyGasAllowance; // wei
        uint128 spentToday; // wei, includes in-flight reservations
    }

    uint256 public maxCostPerOp; // wei
    mapping(address => Sponsorship) public sponsorships;

    event AccountEnrolled(address indexed account, uint128 dailyGasAllowance);
    event AccountUnenrolled(address indexed account);
    event MaxCostPerOpSet(uint256 maxCostPerOp);
    event GasSponsored(address indexed account, bytes32 indexed userOpHash, uint256 actualGasCost, bool opSucceeded);

    error NotEnrolled();
    error OpTooExpensive(uint256 maxCost, uint256 limit);
    error DailyAllowanceExceeded();

    constructor(IEntryPoint entryPoint_, address operator, uint256 maxCostPerOp_) BasePaymaster(entryPoint_) {
        maxCostPerOp = maxCostPerOp_;
        if (operator != msg.sender) _transferOwnership(operator);
    }

    function enroll(address account, uint128 dailyGasAllowance) external onlyOwner {
        Sponsorship storage s = sponsorships[account];
        s.enrolled = true;
        s.dailyGasAllowance = dailyGasAllowance;
        emit AccountEnrolled(account, dailyGasAllowance);
    }

    function unenroll(address account) external onlyOwner {
        sponsorships[account].enrolled = false;
        emit AccountUnenrolled(account);
    }

    function setMaxCostPerOp(uint256 limit) external onlyOwner {
        maxCostPerOp = limit;
        emit MaxCostPerOpSet(limit);
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        Sponsorship storage s = sponsorships[userOp.sender];
        if (!s.enrolled) revert NotEnrolled();
        if (maxCost > maxCostPerOp) revert OpTooExpensive(maxCost, maxCostPerOp);
        uint32 today = uint32(block.timestamp / 1 days);
        if (s.day != today) {
            s.day = today;
            s.spentToday = 0;
        }
        if (uint256(s.spentToday) + maxCost > s.dailyGasAllowance) revert DailyAllowanceExceeded();
        s.spentToday += uint128(maxCost); // reserve worst case; refunded in postOp
        return (abi.encode(userOp.sender, userOpHash, maxCost, today), 0);
    }

    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256) internal override {
        (address account, bytes32 userOpHash, uint256 reserved, uint32 day) =
            abi.decode(context, (address, bytes32, uint256, uint32));
        Sponsorship storage s = sponsorships[account];
        if (s.day == day) {
            uint256 refund = reserved > actualGasCost ? reserved - actualGasCost : 0;
            s.spentToday = refund > s.spentToday ? 0 : s.spentToday - uint128(refund);
        }
        emit GasSponsored(account, userOpHash, actualGasCost, mode == PostOpMode.opSucceeded);
    }
}
