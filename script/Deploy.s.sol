// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {IPayeeRegistry} from "../src/interfaces/IPayeeRegistry.sol";

/// @notice Deploys PayeeRegistry + InvoiceBook on Aevum Testnet (chain 44005) against tUSD8.
/// Usage:
///   source ../.env && forge script script/Deploy.s.sol --rpc-url aevum --broadcast \
///     --private-key $PRIVATE_KEY --verify --verifier blockscout \
///     --verifier-url https://explorer-test.qday.info/api
contract Deploy is Script {
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    uint256 internal constant AEVUM_TESTNET = 44005;

    function run() external returns (PayeeRegistry registry, InvoiceBook book) {
        require(block.chainid == AEVUM_TESTNET, "wrong chain: expected Aevum Testnet 44005");
        uint64 cooldown = uint64(vm.envOr("WALLET_CHANGE_COOLDOWN", uint256(1 hours)));
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(30)));

        vm.startBroadcast();
        address deployer = msg.sender;
        registry = new PayeeRegistry(deployer, cooldown);
        book = new InvoiceBook(IERC20(TUSD8), IPayeeRegistry(address(registry)), deployer);
        registry.setReporter(address(book), true);
        registry.setAttester(deployer, true); // testnet demo attester; production uses KYB partners
        book.setFee(feeBps, deployer);
        vm.stopBroadcast();

        console2.log("PayeeRegistry", address(registry));
        console2.log("InvoiceBook  ", address(book));
    }
}
