// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {IPayeeRegistry} from "../src/interfaces/IPayeeRegistry.sol";

interface ITUSD8 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
}

/// @notice Live end-to-end smoke test on Aevum Testnet:
///   payee registers -> attester verifies -> payee issues invoice -> buyer (holding NO gas)
///   signs an EIP-3009 authorization off-chain -> relayer settles it gaslessly.
/// Env: PRIVATE_KEY (deployer = attester + relayer), PAYEE_PRIVATE_KEY, BUYER_PRIVATE_KEY,
///      REGISTRY, BOOK, INVOICE_AMOUNT (6 decimals), BUYER_TOPUP (6 decimals)
contract SmokeTest is Script {
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    string internal constant NAME = "Paddy Demo Foods Ltd";

    function run() external {
        require(block.chainid == 44005, "wrong chain");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 payeeKey = vm.envUint("PAYEE_PRIVATE_KEY");
        uint256 buyerKey = vm.envUint("BUYER_PRIVATE_KEY");
        address payee = vm.addr(payeeKey);
        address buyer = vm.addr(buyerKey);
        PayeeRegistry registry = PayeeRegistry(vm.envAddress("REGISTRY"));
        InvoiceBook book = InvoiceBook(vm.envAddress("BOOK"));
        uint128 amount = uint128(vm.envOr("INVOICE_AMOUNT", uint256(100_000))); // 0.1 tUSD8
        uint256 topup = vm.envOr("BUYER_TOPUP", uint256(150_000)); // 0.15 tUSD8
        bytes32 nameHash = registry.hashName(NAME);

        // 1. deployer funds the payee with a little gas and the buyer with tUSD8 only (no gas)
        vm.startBroadcast(deployerKey);
        if (payee.balance < 0.01 ether) {
            (bool ok,) = payable(payee).call{value: 0.02 ether}("");
            require(ok, "gas topup failed");
        }
        if (IERC20(TUSD8).balanceOf(buyer) < amount) IERC20(TUSD8).transfer(buyer, topup);
        vm.stopBroadcast();

        // 2. payee registers
        uint256 payeeId = registry.payeeIdOf(payee);
        if (payeeId == 0) {
            vm.broadcast(payeeKey);
            payeeId = registry.register(NAME, nameHash, "https://github.com/paddy-pay/demo-payee.json");
        }

        // 3. attester (deployer) verifies for 180 days
        if (!registry.isVerified(payee)) {
            vm.broadcast(deployerKey);
            registry.verify(payeeId, nameHash, uint64(block.timestamp + 180 days));
        }
        (IPayeeRegistry.CopResult cop,,) = registry.confirmPayeeByName(payee, "PADDY demo foods ltd.");
        require(cop == IPayeeRegistry.CopResult.Match, "CoP did not match");

        // 4. payee issues the invoice to the buyer
        bytes32 ref = keccak256(abi.encodePacked("DEMO-INV-", vm.toString(block.timestamp)));
        vm.broadcast(payeeKey);
        uint256 invoiceId = book.createInvoice(
            buyer,
            amount,
            uint64(block.timestamp + 7 days),
            ref,
            keccak256("2 bags of rice, 1 carton of Indomie"),
            false
        );

        // 5. buyer signs off-chain (no transaction from the buyer)
        bytes32 salt = keccak256(abi.encodePacked("smoke", block.timestamp));
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = book.authorizationNonce(invoiceId, buyer, amount, salt);
        bytes32 structHash = keccak256(
            abi.encode(
                ITUSD8(TUSD8).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                buyer,
                address(book),
                uint256(amount),
                uint256(0),
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITUSD8(TUSD8).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, digest);

        // 6. relayer (deployer) settles gaslessly for the buyer
        vm.broadcast(deployerKey);
        uint256 receiptId = book.payWithAuthorization(invoiceId, buyer, amount, 0, validBefore, salt, v, r, s);

        console2.log("payeeId", payeeId);
        console2.log("invoiceId", invoiceId);
        console2.log("receiptId", receiptId);
    }
}
