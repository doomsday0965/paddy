// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Vm} from "forge-std/Vm.sol";
import {AccountBaseTest} from "./AccountBase.t.sol";
import {PaddyAccount} from "../src/PaddyAccount.sol";
import {PaddyPaymaster} from "../src/PaddyPaymaster.sol";

contract PaddyPaymasterTest is AccountBaseTest {
    bytes32 internal constant REF = keccak256("r");

    function _transferOp() internal view returns (PackedUserOperation memory) {
        return
            _signSession(_op(abi.encodeCall(PaddyAccount.sessionTransfer, (clerk, nkechi, 1e6, REF))), clerk, clerkKey);
    }

    function _expectAA33(bytes memory inner) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOpWithRevert.selector, 0, "AA33 reverted", inner));
    }

    function test_SponsorsAndEmits() public {
        vm.recordLogs();
        _send(_transferOp());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(paymaster) && logs[i].topics[0] == PaddyPaymaster.GasSponsored.selector) {
                found = true;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), address(account));
            }
        }
        assertTrue(found);
        (,, uint128 allowance, uint128 spent) = paymaster.sponsorships(address(account));
        assertEq(allowance, 1 ether);
        assertGt(spent, 0);
        assertLt(spent, 0.05 ether, "reservation refunded to actual cost");
    }

    function test_RejectsUnenrolled() public {
        vm.prank(admin);
        paymaster.unenroll(address(account));
        PackedUserOperation memory op = _transferOp();
        _expectAA33(abi.encodeWithSelector(PaddyPaymaster.NotEnrolled.selector));
        _send(op);
    }

    function test_RejectsTooExpensiveOp() public {
        vm.prank(admin);
        paymaster.setMaxCostPerOp(1 gwei);
        PackedUserOperation memory op = _transferOp();
        vm.expectPartialRevert(IEntryPoint.FailedOpWithRevert.selector);
        _send(op);
    }

    function test_DailyAllowanceEnforcedAndResets() public {
        uint256 maxCost = 1_120_000 * 2 gwei; // sum of all gas limits x maxFeePerGas
        _send(_transferOp());
        (,,, uint128 spent) = paymaster.sponsorships(address(account));
        vm.prank(admin);
        paymaster.enroll(address(account), uint128(spent + maxCost - 1)); // next op no longer fits
        PackedUserOperation memory op = _transferOp();
        _expectAA33(abi.encodeWithSelector(PaddyPaymaster.DailyAllowanceExceeded.selector));
        _send(op);
        vm.warp(block.timestamp + 1 days);
        _send(_transferOp());
        assertEq(usd.balanceOf(nkechi), 2e6);
    }

    function test_OnlyOwnerAdmin() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        paymaster.enroll(stranger, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        paymaster.unenroll(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        paymaster.setMaxCostPerOp(1);
        vm.stopPrank();
        assertEq(paymaster.owner(), admin);
    }
}
