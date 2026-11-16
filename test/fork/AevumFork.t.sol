// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PayeeRegistry} from "../../src/PayeeRegistry.sol";
import {InvoiceBook} from "../../src/InvoiceBook.sol";
import {IPayeeRegistry} from "../../src/interfaces/IPayeeRegistry.sol";

interface ITUSD8 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
}

/// @notice Runs against a fork of Aevum Testnet with the real tUSD8. Skipped unless AEVUM_FORK=true.
///   AEVUM_FORK=true forge test --mc AevumForkTest -vv
contract AevumForkTest is Test {
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function test_GaslessInvoicePaymentWithRealTUSD8() public {
        if (!vm.envOr("AEVUM_FORK", false)) return;
        vm.createSelectFork("aevum");
        assertEq(block.chainid, 44005);

        address admin = makeAddr("admin");
        address supplier = makeAddr("supplier");
        address relayer = makeAddr("relayer");
        (address buyer, uint256 buyerKey) = makeAddrAndKey("buyer");

        PayeeRegistry registry = new PayeeRegistry(admin, 1 hours);
        InvoiceBook book = new InvoiceBook(IERC20(TUSD8), IPayeeRegistry(address(registry)), admin);
        vm.startPrank(admin);
        registry.setReporter(address(book), true);
        registry.setAttester(admin, true);
        vm.stopPrank();

        bytes32 h = registry.hashName("Nkechi Foods Ltd");
        vm.prank(supplier);
        uint256 pid = registry.register("Nkechi Foods Ltd", h, "");
        vm.prank(admin);
        registry.verify(pid, h, uint64(block.timestamp + 30 days));

        deal(TUSD8, buyer, 500e6);
        vm.prank(supplier);
        uint256 id = book.createInvoice(buyer, 250e6, uint64(block.timestamp + 7 days), keccak256("INV-1"), 0, false);

        bytes32 salt = bytes32("fork");
        bytes32 nonce = book.authorizationNonce(id, buyer, 250e6, salt);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                ITUSD8(TUSD8).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                buyer,
                address(book),
                uint256(250e6),
                uint256(0),
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITUSD8(TUSD8).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);

        vm.prank(relayer);
        book.payWithAuthorization(id, buyer, 250e6, 0, validBefore, salt, v, r, s);

        assertEq(IERC20(TUSD8).balanceOf(supplier), 250e6);
        assertEq(IERC20(TUSD8).balanceOf(address(book)), 0);
        assertEq(uint8(book.getInvoice(id).status), uint8(InvoiceBook.Status.Paid));
    }
}
