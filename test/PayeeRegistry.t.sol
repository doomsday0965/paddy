// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BaseTest} from "./Base.t.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {IPayeeRegistry} from "../src/interfaces/IPayeeRegistry.sol";

contract PayeeRegistryTest is BaseTest {
    // ------------------------------------------------------------ registration

    function test_Register() public {
        vm.expectEmit(true, true, false, true);
        emit PayeeRegistry.PayeeRegistered(1, nkechi, nkechiHash, NKECHI_NAME);
        vm.prank(nkechi);
        uint256 id = registry.register(NKECHI_NAME, nkechiHash, "ipfs://x");
        assertEq(id, 1);
        assertEq(registry.payeeIdOf(nkechi), 1);
        PayeeRegistry.Payee memory p = registry.getPayee(1);
        assertEq(p.wallet, nkechi);
        assertEq(uint8(p.status), uint8(IPayeeRegistry.Status.Registered));
        assertEq(p.displayName, NKECHI_NAME);
        assertEq(p.metadataURI, "ipfs://x");
        assertEq(p.registeredAt, block.timestamp);
        assertFalse(registry.isVerified(nkechi));
    }

    function test_RevertWhen_RegisterTwice() public {
        vm.startPrank(nkechi);
        registry.register(NKECHI_NAME, nkechiHash, "");
        vm.expectRevert(PayeeRegistry.AlreadyRegistered.selector);
        registry.register("Other", nkechiHash, "");
    }

    function test_RevertWhen_InvalidIdentity() public {
        vm.startPrank(nkechi);
        vm.expectRevert(PayeeRegistry.InvalidDisplayName.selector);
        registry.register("", nkechiHash, "");
        vm.expectRevert(PayeeRegistry.InvalidDisplayName.selector);
        registry.register(string(new bytes(65)), nkechiHash, "");
        vm.expectRevert(PayeeRegistry.InvalidNameHash.selector);
        registry.register(NKECHI_NAME, bytes32(0), "");
    }

    // ------------------------------------------------------------ verification

    function test_VerifyAndConfirmMatch() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        assertTrue(registry.isVerified(nkechi));
        (IPayeeRegistry.CopResult r, uint256 pid, bool changed) =
            registry.confirmPayeeByName(nkechi, "NKECHI FOODS LTD.");
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.Match));
        assertEq(pid, id);
        assertFalse(changed);
        assertEq(registry.getPayee(id).attester, attester);
    }

    function test_ConfirmNameMismatch() public {
        _registerAndVerify(nkechi, NKECHI_NAME);
        (IPayeeRegistry.CopResult r,,) = registry.confirmPayeeByName(nkechi, "Nkechi Fashion Ltd");
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.NameMismatch));
    }

    function test_ConfirmNoRecordAndNotVerified() public {
        (IPayeeRegistry.CopResult r, uint256 pid,) = registry.confirmPayee(stranger, nkechiHash);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.NoRecord));
        assertEq(pid, 0);
        vm.prank(nkechi);
        registry.register(NKECHI_NAME, nkechiHash, "");
        (r,,) = registry.confirmPayee(nkechi, nkechiHash);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.NotVerified));
    }

    function test_VerificationExpires() public {
        _registerAndVerify(nkechi, NKECHI_NAME);
        vm.warp(block.timestamp + 181 days);
        (IPayeeRegistry.CopResult r,,) = registry.confirmPayee(nkechi, nkechiHash);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.VerificationExpired));
        assertFalse(registry.isVerified(nkechi));
    }

    function test_RevertWhen_AttesterNameHashDiffers() public {
        vm.prank(nkechi);
        uint256 id = registry.register(NKECHI_NAME, nkechiHash, "");
        bytes32 other = registry.hashName("Someone Else Ltd");
        vm.prank(attester);
        vm.expectRevert(PayeeRegistry.NameHashMismatch.selector);
        registry.verify(id, other, uint64(block.timestamp + 1 days));
    }

    function test_RevertWhen_BadValidity() public {
        vm.prank(nkechi);
        uint256 id = registry.register(NKECHI_NAME, nkechiHash, "");
        vm.startPrank(attester);
        vm.expectRevert(PayeeRegistry.InvalidValidity.selector);
        registry.verify(id, nkechiHash, uint64(block.timestamp));
        vm.expectRevert(PayeeRegistry.InvalidValidity.selector);
        registry.verify(id, nkechiHash, uint64(block.timestamp + 401 days));
    }

    function test_RevertWhen_NonAttesterVerifies() public {
        vm.prank(nkechi);
        uint256 id = registry.register(NKECHI_NAME, nkechiHash, "");
        vm.prank(nkechi);
        vm.expectRevert(PayeeRegistry.NotAttester.selector);
        registry.verify(id, nkechiHash, uint64(block.timestamp + 1 days));
    }

    function test_RevertWhen_VerifyUnknown() public {
        vm.prank(attester);
        vm.expectRevert(PayeeRegistry.UnknownPayee.selector);
        registry.verify(99, nkechiHash, uint64(block.timestamp + 1 days));
    }

    function test_RevokeVerification() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        vm.prank(attester);
        registry.revokeVerification(id);
        assertFalse(registry.isVerified(nkechi));
        vm.prank(attester);
        vm.expectRevert(PayeeRegistry.NotVerified.selector);
        registry.revokeVerification(id);
    }

    function test_UpdateIdentityDropsVerification() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        bytes32 h2 = registry.hashName("Nkechi Foods and Drinks Ltd");
        vm.prank(nkechi);
        registry.updateIdentity("Nkechi Foods and Drinks Ltd", h2);
        assertEq(uint8(registry.getPayee(id).status), uint8(IPayeeRegistry.Status.Registered));
        (IPayeeRegistry.CopResult r,,) = registry.confirmPayee(nkechi, h2);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.NotVerified));
    }

    function test_UpdateMetadata() public {
        vm.startPrank(nkechi);
        uint256 id = registry.register(NKECHI_NAME, nkechiHash, "a");
        registry.updateMetadata("b");
        assertEq(registry.getPayee(id).metadataURI, "b");
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(PayeeRegistry.NotRegistered.selector);
        registry.updateMetadata("c");
    }

    // ------------------------------------------------------------ suspension

    function test_SuspendBlocksAndReinstateRequiresReverify() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        vm.prank(attester);
        registry.suspend(id, "fraud report #12");
        (IPayeeRegistry.CopResult r,,) = registry.confirmPayee(nkechi, nkechiHash);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.Suspended));

        vm.prank(attester);
        vm.expectRevert(PayeeRegistry.IsSuspended.selector);
        registry.verify(id, nkechiHash, uint64(block.timestamp + 1 days));

        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attester));
        registry.reinstate(id);

        vm.prank(admin);
        registry.reinstate(id);
        (r,,) = registry.confirmPayee(nkechi, nkechiHash);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.NotVerified));

        vm.prank(admin);
        vm.expectRevert(PayeeRegistry.NotSuspended.selector);
        registry.reinstate(id);
    }

    function test_OwnerCanSuspend_StrangerCannot() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        vm.prank(stranger);
        vm.expectRevert(PayeeRegistry.NotAttester.selector);
        registry.suspend(id, "x");
        vm.prank(admin);
        registry.suspend(id, "x");
        vm.prank(admin);
        vm.expectRevert(PayeeRegistry.IsSuspended.selector);
        registry.suspend(id, "again");
    }

    // ------------------------------------------------------------ wallet change

    function test_WalletChangeTwoStepAndFlag() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        address newWallet = makeAddr("nkechiNew");
        vm.prank(nkechi);
        registry.proposeWalletChange(newWallet);
        assertEq(registry.pendingWallet(id), newWallet);

        vm.prank(stranger);
        vm.expectRevert(PayeeRegistry.NotPendingWallet.selector);
        registry.acceptWalletChange(id);

        vm.prank(newWallet);
        registry.acceptWalletChange(id);
        assertEq(registry.payeeIdOf(newWallet), id);
        assertEq(registry.payeeIdOf(nkechi), 0);

        (IPayeeRegistry.CopResult r,, bool changed) = registry.confirmPayee(newWallet, nkechiHash);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.Match));
        assertTrue(changed, "flagged during cooldown");

        vm.warp(block.timestamp + COOLDOWN);
        (,, changed) = registry.confirmPayee(newWallet, nkechiHash);
        assertFalse(changed, "flag clears after cooldown");

        (r,,) = registry.confirmPayee(nkechi, nkechiHash);
        assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.NoRecord), "old wallet no longer resolves");
    }

    function test_CancelWalletChange() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        address newWallet = makeAddr("nkechiNew");
        vm.startPrank(nkechi);
        vm.expectRevert(PayeeRegistry.NoPendingChange.selector);
        registry.cancelWalletChange();
        registry.proposeWalletChange(newWallet);
        registry.cancelWalletChange();
        vm.stopPrank();
        vm.prank(newWallet);
        vm.expectRevert(PayeeRegistry.NoPendingChange.selector);
        registry.acceptWalletChange(id);
    }

    function test_RevertWhen_WalletChangeToRegisteredOrZero() public {
        _registerAndVerify(nkechi, NKECHI_NAME);
        _registerAndVerify(emeka, "Emeka Logistics");
        vm.startPrank(nkechi);
        vm.expectRevert(PayeeRegistry.AlreadyRegistered.selector);
        registry.proposeWalletChange(emeka);
        vm.expectRevert(PayeeRegistry.ZeroAddress.selector);
        registry.proposeWalletChange(address(0));
    }

    function test_RevertWhen_AcceptAfterTargetRegisteredElsewhere() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        address newWallet = makeAddr("nkechiNew");
        vm.prank(nkechi);
        registry.proposeWalletChange(newWallet);
        vm.prank(newWallet);
        registry.register("Squatter", keccak256("s"), "");
        vm.prank(newWallet);
        vm.expectRevert(PayeeRegistry.AlreadyRegistered.selector);
        registry.acceptWalletChange(id);
    }

    function test_SuspendClearsPendingWalletChange() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        address newWallet = makeAddr("nkechiNew");
        vm.prank(nkechi);
        registry.proposeWalletChange(newWallet);
        vm.prank(attester);
        registry.suspend(id, "account takeover");
        vm.prank(newWallet);
        vm.expectRevert(PayeeRegistry.NoPendingChange.selector);
        registry.acceptWalletChange(id);
        vm.prank(nkechi);
        vm.expectRevert(PayeeRegistry.IsSuspended.selector);
        registry.proposeWalletChange(newWallet);
    }

    // ------------------------------------------------------------ reporters & admin

    function test_RecordSettlementOnlyReporter() public {
        uint256 id = _registerAndVerify(nkechi, NKECHI_NAME);
        vm.prank(stranger);
        vm.expectRevert(PayeeRegistry.NotReporter.selector);
        registry.recordSettlement(id, true);
        vm.startPrank(address(book));
        registry.recordSettlement(id, true);
        registry.recordSettlement(id, false);
        vm.stopPrank();
        PayeeRegistry.Payee memory p = registry.getPayee(id);
        assertEq(p.settledInvoices, 2);
        assertEq(p.settledOnTime, 1);
    }

    function test_AdminControls() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        registry.setAttester(stranger, true);
        vm.startPrank(admin);
        vm.expectRevert(PayeeRegistry.ZeroAddress.selector);
        registry.setAttester(address(0), true);
        vm.expectRevert(PayeeRegistry.ZeroAddress.selector);
        registry.setReporter(address(0), true);
        registry.setAttester(attester, false);
        vm.stopPrank();
        assertFalse(registry.isAttester(attester));
    }

    function test_OwnershipIsTwoStep() public {
        vm.prank(admin);
        registry.transferOwnership(stranger);
        assertEq(registry.owner(), admin);
        vm.prank(stranger);
        registry.acceptOwnership();
        assertEq(registry.owner(), stranger);
    }

    function testFuzz_ConfirmOnlyMatchesExactHash(bytes32 guess) public {
        _registerAndVerify(nkechi, NKECHI_NAME);
        (IPayeeRegistry.CopResult r,,) = registry.confirmPayee(nkechi, guess);
        if (guess == nkechiHash) assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.Match));
        else assertEq(uint8(r), uint8(IPayeeRegistry.CopResult.NameMismatch));
    }
}
