// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {IPayeeRegistry} from "../src/interfaces/IPayeeRegistry.sol";

contract InvoiceBookTest is BaseTest {
    uint256 internal nkechiId;
    bytes32 internal constant REF = keccak256("INV-0042");

    function setUp() public override {
        super.setUp();
        nkechiId = _registerAndVerify(nkechi, NKECHI_NAME);
        vm.prank(buyer);
        usd.approve(address(book), type(uint256).max);
    }

    function _create(address payer, uint128 amount, bool partial_) internal returns (uint256 id) {
        vm.prank(nkechi);
        id = book.createInvoice(payer, amount, uint64(block.timestamp + 7 days), REF, keccak256("doc"), partial_);
    }

    // ------------------------------------------------------------ creation

    function test_CreateInvoice() public {
        uint256 id = _create(buyer, 250e6, false);
        assertEq(id, 1);
        InvoiceBook.Invoice memory inv = book.getInvoice(id);
        assertEq(inv.payeeId, nkechiId);
        assertEq(inv.payer, buyer);
        assertEq(inv.amount, 250e6);
        assertEq(uint8(inv.status), uint8(InvoiceBook.Status.Open));
        assertEq(book.invoiceIdByRef(nkechiId, REF), id);
        assertEq(book.remaining(id), 250e6);
        assertEq(book.payability(id, buyer), 0);
    }

    function test_RevertWhen_CreateInvalid() public {
        vm.startPrank(nkechi);
        uint64 due = uint64(block.timestamp + 1 days);
        vm.expectRevert(InvoiceBook.InvalidAmount.selector);
        book.createInvoice(address(0), 0, due, REF, 0, false);
        vm.expectRevert(InvoiceBook.InvalidDueDate.selector);
        book.createInvoice(address(0), 1, uint64(block.timestamp), REF, 0, false);
        vm.expectRevert(InvoiceBook.InvalidRef.selector);
        book.createInvoice(address(0), 1, due, bytes32(0), 0, false);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(InvoiceBook.NotRegisteredPayee.selector);
        book.createInvoice(address(0), 1, due, REF, 0, false);
    }

    function test_DuplicateRefIsIdempotentGuard() public {
        uint256 id = _create(buyer, 1e6, false);
        vm.prank(nkechi);
        vm.expectRevert(abi.encodeWithSelector(InvoiceBook.DuplicateRef.selector, id));
        book.createInvoice(buyer, 1e6, uint64(block.timestamp + 1 days), REF, 0, false);
        // a different payee may reuse the same ref string
        _registerAndVerify(emeka, "Emeka Logistics");
        vm.prank(emeka);
        book.createInvoice(buyer, 1e6, uint64(block.timestamp + 1 days), REF, 0, false);
    }

    function test_RevertWhen_SuspendedPayeeCreates() public {
        vm.prank(attester);
        registry.suspend(nkechiId, "fraud");
        vm.prank(nkechi);
        vm.expectRevert(InvoiceBook.PayeeIsSuspended.selector);
        book.createInvoice(buyer, 1e6, uint64(block.timestamp + 1 days), REF, 0, false);
    }

    // ------------------------------------------------------------ direct payment

    function test_PayInFull() public {
        uint256 id = _create(buyer, 250e6, false);
        vm.expectEmit(true, true, true, true);
        emit InvoiceBook.PaymentReceived(id, 1, buyer, nkechi, 250e6, 0, 250e6, InvoiceBook.Method.Direct);
        vm.expectEmit(true, false, false, true);
        emit InvoiceBook.InvoicePaid(id, true);
        vm.prank(buyer);
        uint256 rid = book.pay(id, 250e6);
        assertEq(rid, 1);
        assertEq(usd.balanceOf(nkechi), 250e6);
        assertEq(uint8(book.getInvoice(id).status), uint8(InvoiceBook.Status.Paid));
        InvoiceBook.Receipt memory r = book.getReceipt(rid);
        assertEq(r.invoiceId, id);
        assertEq(r.payer, buyer);
        assertEq(r.paidTo, nkechi);
        assertEq(r.amount, 250e6);
        assertEq(r.paidAt, block.timestamp);
        PayeeRegistry.Payee memory p = registry.getPayee(nkechiId);
        assertEq(p.settledInvoices, 1);
        assertEq(p.settledOnTime, 1);
        assertEq(book.payability(id, buyer), 1);
    }

    function test_LatePaymentRecordedAsLate() public {
        uint256 id = _create(address(0), 10e6, false);
        vm.warp(block.timestamp + 8 days);
        vm.prank(buyer);
        book.pay(id, 10e6);
        PayeeRegistry.Payee memory p = registry.getPayee(nkechiId);
        assertEq(p.settledInvoices, 1);
        assertEq(p.settledOnTime, 0);
    }

    function test_RevertWhen_PayTwice() public {
        uint256 id = _create(buyer, 10e6, false);
        vm.startPrank(buyer);
        book.pay(id, 10e6);
        vm.expectRevert(InvoiceBook.NotOpen.selector);
        book.pay(id, 10e6);
    }

    function test_RevertWhen_UnknownInvoice() public {
        vm.prank(buyer);
        vm.expectRevert(InvoiceBook.UnknownInvoice.selector);
        book.pay(42, 1);
    }

    function test_PartialPayments() public {
        uint256 id = _create(buyer, 100e6, true);
        vm.startPrank(buyer);
        book.pay(id, 30e6);
        assertEq(book.remaining(id), 70e6);
        vm.expectRevert(abi.encodeWithSelector(InvoiceBook.Overpayment.selector, 70e6));
        book.pay(id, 71e6);
        book.pay(id, 70e6);
        vm.stopPrank();
        assertEq(uint8(book.getInvoice(id).status), uint8(InvoiceBook.Status.Paid));
        assertEq(book.receiptCount(), 2);
        assertEq(usd.balanceOf(nkechi), 100e6);
    }

    function test_RevertWhen_PartialNotAllowed() public {
        uint256 id = _create(buyer, 100e6, false);
        vm.prank(buyer);
        vm.expectRevert(InvoiceBook.PartialNotAllowed.selector);
        book.pay(id, 50e6);
    }

    function test_RevertWhen_ZeroAmount() public {
        uint256 id = _create(buyer, 100e6, true);
        vm.prank(buyer);
        vm.expectRevert(InvoiceBook.InvalidAmount.selector);
        book.pay(id, 0);
    }

    function test_RevertWhen_WrongPayer() public {
        uint256 id = _create(buyer, 10e6, false);
        usd.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usd.approve(address(book), 10e6);
        vm.expectRevert(InvoiceBook.NotAuthorizedPayer.selector);
        book.pay(id, 10e6);
        vm.stopPrank();
        assertEq(book.payability(id, stranger), 4);
    }

    function test_OpenInvoiceAnyonePays() public {
        uint256 id = _create(address(0), 10e6, false);
        usd.mint(stranger, 10e6);
        vm.startPrank(stranger);
        usd.approve(address(book), 10e6);
        book.pay(id, 10e6);
        vm.stopPrank();
        assertEq(usd.balanceOf(nkechi), 10e6);
    }

    // ------------------------------------------------------------ cancel

    function test_Cancel() public {
        uint256 id = _create(buyer, 10e6, false);
        vm.prank(stranger);
        vm.expectRevert(InvoiceBook.NotIssuer.selector);
        book.cancelInvoice(id);
        vm.prank(nkechi);
        book.cancelInvoice(id);
        vm.prank(buyer);
        vm.expectRevert(InvoiceBook.NotOpen.selector);
        book.pay(id, 10e6);
    }

    function test_RevertWhen_CancelAfterPartial() public {
        uint256 id = _create(buyer, 10e6, true);
        vm.prank(buyer);
        book.pay(id, 1e6);
        vm.prank(nkechi);
        vm.expectRevert(InvoiceBook.AlreadyPartiallyPaid.selector);
        book.cancelInvoice(id);
    }

    // ------------------------------------------------------------ fraud protections

    function test_SuspendedPayeeCannotBePaid() public {
        uint256 id = _create(buyer, 10e6, false);
        vm.prank(attester);
        registry.suspend(nkechiId, "fraud");
        assertEq(book.payability(id, buyer), 2);
        vm.prank(buyer);
        vm.expectRevert(InvoiceBook.PayeeIsSuspended.selector);
        book.pay(id, 10e6);
    }

    function test_WalletChangeFreezesInvoiceUntilReconfirmed() public {
        uint256 id = _create(buyer, 10e6, false);
        address newWallet = makeAddr("nkechiNew");
        vm.prank(nkechi);
        registry.proposeWalletChange(newWallet);
        vm.warp(block.timestamp + 1);
        vm.prank(newWallet);
        registry.acceptWalletChange(nkechiId);

        assertEq(book.payability(id, buyer), 3);
        vm.prank(buyer);
        vm.expectRevert(InvoiceBook.WalletChangedSinceIssue.selector);
        book.pay(id, 10e6);

        // the old wallet is no longer the issuer
        vm.prank(nkechi);
        vm.expectRevert(InvoiceBook.NotIssuer.selector);
        book.reconfirmInvoice(id);

        uint256 until = block.timestamp + COOLDOWN;
        vm.prank(newWallet);
        vm.expectRevert(abi.encodeWithSelector(InvoiceBook.CooldownActive.selector, until));
        book.reconfirmInvoice(id);

        vm.warp(until);
        vm.prank(newWallet);
        book.reconfirmInvoice(id);
        vm.prank(buyer);
        book.pay(id, 10e6);
        assertEq(usd.balanceOf(newWallet), 10e6, "pays current registry wallet");
        assertEq(usd.balanceOf(nkechi), 0);
    }

    function test_InvoiceCreatedAfterWalletChangeIsPayable() public {
        address newWallet = makeAddr("nkechiNew");
        vm.prank(nkechi);
        registry.proposeWalletChange(newWallet);
        vm.prank(newWallet);
        registry.acceptWalletChange(nkechiId);
        vm.prank(newWallet);
        uint256 id = book.createInvoice(buyer, 5e6, uint64(block.timestamp + 1 days), REF, 0, false);
        vm.prank(buyer);
        book.pay(id, 5e6);
        assertEq(usd.balanceOf(newWallet), 5e6);
    }

    function test_BlacklistedPayeeTransferReverts() public {
        uint256 id = _create(buyer, 10e6, false);
        usd.blacklist(nkechi, true);
        vm.prank(buyer);
        vm.expectRevert("Blacklistable: account is blacklisted");
        book.pay(id, 10e6);
        assertEq(uint8(book.getInvoice(id).status), uint8(InvoiceBook.Status.Open));
    }

    // ------------------------------------------------------------ fees

    function test_FeeSnapshotAndSplit() public {
        vm.prank(admin);
        book.setFee(50, treasury); // 0.5%
        uint256 id = _create(buyer, 200e6, false);
        vm.prank(admin);
        book.setFee(100, treasury); // later change must not affect issued invoice
        vm.prank(buyer);
        book.pay(id, 200e6);
        assertEq(usd.balanceOf(treasury), 1e6);
        assertEq(usd.balanceOf(nkechi), 199e6);
        assertEq(book.getReceipt(1).fee, 1e6);
    }

    function test_FeeAdmin() public {
        vm.startPrank(admin);
        vm.expectRevert(InvoiceBook.FeeTooHigh.selector);
        book.setFee(101, treasury);
        vm.expectRevert(InvoiceBook.ZeroAddress.selector);
        book.setFee(10, address(0));
        book.setFee(0, address(0));
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.setFee(10, treasury);
    }

    function test_RevertWhen_ConstructorZero() public {
        vm.expectRevert(InvoiceBook.ZeroAddress.selector);
        new InvoiceBook(IERC20(address(0)), IPayeeRegistry(address(registry)), admin);
        vm.expectRevert(InvoiceBook.ZeroAddress.selector);
        new InvoiceBook(usd, IPayeeRegistry(address(0)), admin);
    }

    // ------------------------------------------------------------ reputation resilience

    function test_PaymentSucceedsEvenIfReputationHookFails() public {
        vm.prank(admin);
        registry.setReporter(address(book), false);
        uint256 id = _create(buyer, 10e6, false);
        vm.expectEmit(true, false, false, false);
        emit InvoiceBook.ReputationUpdateFailed(id);
        vm.prank(buyer);
        book.pay(id, 10e6);
        assertEq(uint8(book.getInvoice(id).status), uint8(InvoiceBook.Status.Paid));
        assertEq(registry.getPayee(nkechiId).settledInvoices, 0);
    }

    // ------------------------------------------------------------ gasless EIP-3009

    function _authPay(uint256 id, uint128 amount, bytes32 salt, uint256 validBefore) internal returns (uint256) {
        bytes32 nonce = book.authorizationNonce(id, buyer, amount, salt);
        (uint8 v, bytes32 r, bytes32 s) =
            _signReceiveAuth(buyerKey, buyer, address(book), amount, 0, validBefore, nonce);
        vm.prank(relayer);
        return book.payWithAuthorization(id, buyer, amount, 0, validBefore, salt, v, r, s);
    }

    function test_PayWithAuthorizationGasless() public {
        uint256 id = _create(buyer, 250e6, false);
        vm.prank(buyer);
        usd.approve(address(book), 0); // no allowance needed
        uint256 rid = _authPay(id, 250e6, bytes32("salt1"), block.timestamp + 1 hours);
        assertEq(usd.balanceOf(nkechi), 250e6);
        assertEq(usd.balanceOf(address(book)), 0, "book holds nothing");
        InvoiceBook.Receipt memory r = book.getReceipt(rid);
        assertEq(r.payer, buyer);
        assertEq(uint8(r.method), uint8(InvoiceBook.Method.Authorization));
        assertTrue(usd.authorizationState(buyer, book.authorizationNonce(id, buyer, 250e6, bytes32("salt1"))));
    }

    function test_AuthorizationIsBoundToInvoice() public {
        uint256 id1 = _create(buyer, 50e6, false);
        _registerAndVerify(emeka, "Emeka Logistics");
        vm.prank(emeka);
        uint256 id2 = book.createInvoice(address(0), 50e6, uint64(block.timestamp + 1 days), REF, 0, false);

        bytes32 salt = bytes32("s");
        bytes32 nonce = book.authorizationNonce(id1, buyer, 50e6, salt);
        (uint8 v, bytes32 r, bytes32 s) =
            _signReceiveAuth(buyerKey, buyer, address(book), 50e6, 0, block.timestamp + 1 hours, nonce);

        // relayer tries to spend the signature on Emeka's invoice instead
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: invalid signature");
        book.payWithAuthorization(id2, buyer, 50e6, 0, block.timestamp + 1 hours, salt, v, r, s);

        vm.prank(relayer);
        book.payWithAuthorization(id1, buyer, 50e6, 0, block.timestamp + 1 hours, salt, v, r, s);
        assertEq(usd.balanceOf(nkechi), 50e6);
        assertEq(usd.balanceOf(emeka), 0);
    }

    function test_RevertWhen_AuthorizationReplayed() public {
        uint256 id = _create(buyer, 100e6, true);
        bytes32 salt = bytes32("s");
        bytes32 nonce = book.authorizationNonce(id, buyer, 40e6, salt);
        (uint8 v, bytes32 r, bytes32 s) =
            _signReceiveAuth(buyerKey, buyer, address(book), 40e6, 0, block.timestamp + 1 hours, nonce);
        vm.prank(relayer);
        book.payWithAuthorization(id, buyer, 40e6, 0, block.timestamp + 1 hours, salt, v, r, s);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        book.payWithAuthorization(id, buyer, 40e6, 0, block.timestamp + 1 hours, salt, v, r, s);
    }

    function test_RevertWhen_AuthorizationExpired() public {
        uint256 id = _create(buyer, 10e6, false);
        uint256 validBefore = block.timestamp + 10 minutes;
        bytes32 salt = bytes32("s");
        bytes32 nonce = book.authorizationNonce(id, buyer, 10e6, salt);
        (uint8 v, bytes32 r, bytes32 s) = _signReceiveAuth(buyerKey, buyer, address(book), 10e6, 0, validBefore, nonce);
        vm.warp(validBefore);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        book.payWithAuthorization(id, buyer, 10e6, 0, validBefore, salt, v, r, s);
    }

    function test_RevertWhen_AuthorizationAmountTampered() public {
        uint256 id = _create(buyer, 100e6, true);
        bytes32 salt = bytes32("s");
        bytes32 nonce = book.authorizationNonce(id, buyer, 10e6, salt);
        (uint8 v, bytes32 r, bytes32 s) =
            _signReceiveAuth(buyerKey, buyer, address(book), 10e6, 0, block.timestamp + 1 hours, nonce);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: invalid signature");
        book.payWithAuthorization(id, buyer, 100e6, 0, block.timestamp + 1 hours, salt, v, r, s);
    }

    function test_RevertWhen_AuthorizationFromWrongPayer() public {
        uint256 id = _create(stranger, 10e6, false); // invoice addressed to someone else
        bytes32 salt = bytes32("s");
        bytes32 nonce = book.authorizationNonce(id, buyer, 10e6, salt);
        (uint8 v, bytes32 r, bytes32 s) =
            _signReceiveAuth(buyerKey, buyer, address(book), 10e6, 0, block.timestamp + 1 hours, nonce);
        vm.prank(relayer);
        vm.expectRevert(InvoiceBook.NotAuthorizedPayer.selector);
        book.payWithAuthorization(id, buyer, 10e6, 0, block.timestamp + 1 hours, salt, v, r, s);
    }

    function test_AuthorizationWithFee() public {
        vm.prank(admin);
        book.setFee(30, treasury); // 0.3%
        uint256 id = _create(buyer, 1000e6, false);
        _authPay(id, 1000e6, bytes32("x"), block.timestamp + 1 hours);
        assertEq(usd.balanceOf(treasury), 3e6);
        assertEq(usd.balanceOf(nkechi), 997e6);
        assertEq(usd.balanceOf(address(book)), 0);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_PartialPaymentsConserveValue(uint128 amount, uint128 first, uint16 fee) public {
        amount = uint128(bound(amount, 2, 500_000e6));
        first = uint128(bound(first, 1, amount - 1));
        fee = uint16(bound(fee, 0, 100));
        vm.prank(admin);
        book.setFee(fee, treasury);
        uint256 id = _create(buyer, amount, true);
        uint256 before = usd.balanceOf(buyer);
        vm.startPrank(buyer);
        book.pay(id, first);
        book.pay(id, amount - first);
        vm.stopPrank();
        assertEq(before - usd.balanceOf(buyer), amount);
        assertEq(usd.balanceOf(nkechi) + usd.balanceOf(treasury), amount);
        assertLe(usd.balanceOf(treasury), (uint256(amount) * fee) / 10_000 + 1);
        assertEq(uint8(book.getInvoice(id).status), uint8(InvoiceBook.Status.Paid));
    }
}
