// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {AccountBaseTest} from "./AccountBase.t.sol";
import {PaddyAccount} from "../src/PaddyAccount.sol";
import {PaddyAccountFactory} from "../src/PaddyAccountFactory.sol";

contract PaddyAccountFactoryTest is AccountBaseTest {
    function test_DeterministicAndIdempotent() public {
        address predicted = factory.getAddress(owner, 77);
        assertEq(predicted.code.length, 0);
        PaddyAccount a = factory.createAccount(owner, 77);
        assertEq(address(a), predicted);
        assertEq(address(factory.createAccount(owner, 77)), predicted);
        assertEq(a.owner(), owner);
        assertEq(address(a.entryPoint()), address(ep));
        assertTrue(factory.getAddress(emeka, 77) != predicted);
    }

    function test_FirstUserOpDeploysAccount() public {
        address predicted = factory.getAddress(owner, 99);
        vm.prank(admin);
        paymaster.enroll(predicted, 1 ether);
        PackedUserOperation memory op;
        op.sender = predicted;
        op.nonce = 0;
        op.initCode = abi.encodePacked(address(factory), abi.encodeCall(PaddyAccountFactory.createAccount, (owner, 99)));
        address[] memory payees = new address[](1);
        payees[0] = nkechi;
        op.callData = abi.encodeCall(
            PaddyAccount.createSession,
            (clerk, "clerk", 0, uint48(block.timestamp + 1 days), CAP, DAILY, TOTAL, true, payees)
        );
        op.accountGasLimits = bytes32((uint256(3_000_000) << 128) | uint256(300_000));
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(100_000), uint128(60_000));
        vm.prank(admin);
        paymaster.setMaxCostPerOp(1 ether);
        _send(_signOwner(op));
        assertGt(predicted.code.length, 0);
        assertTrue(PaddyAccount(payable(predicted)).isSessionLive(clerk));
    }

    function test_RevertWhen_ZeroOwner() public {
        vm.expectRevert(PaddyAccount.ZeroAddress.selector);
        factory.createAccount(address(0), 5);
    }
}
