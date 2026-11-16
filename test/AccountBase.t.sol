// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EntryPoint} from "@account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {BaseTest} from "./Base.t.sol";
import {PaddyAccount} from "../src/PaddyAccount.sol";
import {PaddyAccountFactory} from "../src/PaddyAccountFactory.sol";
import {PaddyPaymaster} from "../src/PaddyPaymaster.sol";

abstract contract AccountBaseTest is BaseTest {
    EntryPoint internal ep;
    PaddyAccountFactory internal factory;
    PaddyPaymaster internal paymaster;
    PaddyAccount internal account;

    address internal owner;
    uint256 internal ownerKey;
    address internal clerk; // AI session key
    uint256 internal clerkKey;
    address internal attacker = makeAddr("attacker");
    address payable internal bundler = payable(makeAddr("bundler"));

    uint128 internal constant CAP = 200e6;
    uint128 internal constant DAILY = 500e6;
    uint128 internal constant TOTAL = 2_000e6;

    function setUp() public virtual override {
        super.setUp();
        (owner, ownerKey) = makeAddrAndKey("owner");
        (clerk, clerkKey) = makeAddrAndKey("clerk");
        ep = new EntryPoint();
        factory = new PaddyAccountFactory(IEntryPoint(address(ep)), usd, book, registry);
        paymaster = new PaddyPaymaster(IEntryPoint(address(ep)), admin, 0.05 ether);
        vm.deal(admin, 100 ether);
        vm.prank(admin);
        paymaster.deposit{value: 10 ether}();
        account = factory.createAccount(owner, 1);
        vm.prank(admin);
        paymaster.enroll(address(account), 1 ether);
        usd.mint(address(account), 5_000e6);

        _registerAndVerify(nkechi, NKECHI_NAME);
        _registerAndVerify(emeka, "Emeka Logistics");

        address[] memory payees = new address[](1);
        payees[0] = nkechi;
        vm.prank(owner);
        account.createSession(clerk, "AI clerk", 0, uint48(block.timestamp + 7 days), CAP, DAILY, TOTAL, true, payees);
    }

    // ------------------------------------------------------------ userOp helpers

    function _op(bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = address(account);
        op.nonce = ep.getNonce(address(account), 0);
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(300_000) << 128) | uint256(600_000));
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(100_000), uint128(60_000));
    }

    function _signOwner(PackedUserOperation memory op) internal view returns (PackedUserOperation memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, _digest(op));
        op.signature = abi.encodePacked(uint8(0), r, s, v);
        return op;
    }

    function _signSession(PackedUserOperation memory op, address key, uint256 pk)
        internal
        view
        returns (PackedUserOperation memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _digest(op));
        op.signature = abi.encodePacked(uint8(1), key, r, s, v);
        return op;
    }

    function _digest(PackedUserOperation memory op) internal view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(ep.getUserOpHash(op));
    }

    function _send(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(bundler, bundler);
        ep.handleOps(ops, bundler);
    }

    function _expectFailedOp(string memory reason) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason));
    }

    function _clerkTransfer(address payee, uint128 amount, bytes32 ref) internal {
        _send(
            _signSession(
                _op(abi.encodeCall(PaddyAccount.sessionTransfer, (clerk, payee, amount, ref))), clerk, clerkKey
            )
        );
    }

    function _clerkPayInvoice(uint256 invoiceId, uint128 amount) internal {
        _send(
            _signSession(
                _op(abi.encodeCall(PaddyAccount.sessionPayInvoice, (clerk, invoiceId, amount))), clerk, clerkKey
            )
        );
    }
}
