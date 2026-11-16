// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";

/// @notice Random sequences of create / pay / cancel; ghost totals are compared with balances.
contract BookHandler is Test {
    InvoiceBook internal book;
    MockUSD8 internal usd;
    address internal issuer;
    address internal payer;
    uint256 public ghostPaid;
    uint256 internal refNonce;

    constructor(InvoiceBook b, MockUSD8 u, address issuer_, address payer_) {
        book = b;
        usd = u;
        issuer = issuer_;
        payer = payer_;
    }

    function create(uint128 amount, bool partial_) external {
        amount = uint128(bound(amount, 1, 1_000_000e6));
        vm.prank(issuer);
        book.createInvoice(
            address(0), amount, uint64(block.timestamp + 30 days), keccak256(abi.encode(++refNonce)), 0, partial_
        );
    }

    function pay(uint256 seed, uint128 amount) external {
        uint256 n = book.invoiceCount();
        if (n == 0) return;
        uint256 id = (seed % n) + 1;
        InvoiceBook.Invoice memory inv = book.getInvoice(id);
        if (inv.status != InvoiceBook.Status.Open) return;
        uint128 left = inv.amount - inv.paid;
        amount = inv.allowPartial ? uint128(bound(amount, 1, left)) : left;
        usd.mint(payer, amount);
        vm.startPrank(payer);
        usd.approve(address(book), amount);
        book.pay(id, amount);
        vm.stopPrank();
        ghostPaid += amount;
    }

    function cancel(uint256 seed) external {
        uint256 n = book.invoiceCount();
        if (n == 0) return;
        uint256 id = (seed % n) + 1;
        InvoiceBook.Invoice memory inv = book.getInvoice(id);
        if (inv.status != InvoiceBook.Status.Open || inv.paid != 0) return;
        vm.prank(issuer);
        book.cancelInvoice(id);
    }
}

contract InvoiceBookInvariantTest is BaseTest {
    BookHandler internal handler;

    function setUp() public override {
        super.setUp();
        _registerAndVerify(nkechi, NKECHI_NAME);
        vm.prank(admin);
        book.setFee(25, treasury);
        address payer = makeAddr("payer");
        handler = new BookHandler(book, usd, nkechi, payer);
        targetContract(address(handler));
    }

    function invariant_BookNeverHoldsFunds() public view {
        assertEq(usd.balanceOf(address(book)), 0);
    }

    function invariant_AllPaymentsReachPayeeOrTreasury() public view {
        assertEq(usd.balanceOf(nkechi) + usd.balanceOf(treasury), handler.ghostPaid());
    }

    function invariant_PaidNeverExceedsAmountAndStatusConsistent() public view {
        uint256 n = book.invoiceCount();
        uint256 sumPaid;
        for (uint256 i = 1; i <= n; ++i) {
            InvoiceBook.Invoice memory inv = book.getInvoice(i);
            assertLe(inv.paid, inv.amount);
            if (inv.status == InvoiceBook.Status.Paid) assertEq(inv.paid, inv.amount);
            if (inv.status == InvoiceBook.Status.Cancelled) assertEq(inv.paid, 0);
            sumPaid += inv.paid;
        }
        assertEq(sumPaid, handler.ghostPaid());
    }
}
