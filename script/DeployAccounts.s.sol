// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PaddyAccountFactory} from "../src/PaddyAccountFactory.sol";
import {PaddyPaymaster} from "../src/PaddyPaymaster.sol";
import {PaddyAccount} from "../src/PaddyAccount.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {IPayeeRegistry} from "../src/interfaces/IPayeeRegistry.sol";

/// @notice Deploys the ERC-4337 layer on Aevum Testnet: factory, paymaster (funded), and a demo
///         SME account owned by OWNER (defaults to the broadcaster), enrolled for sponsorship.
/// Env: REGISTRY, BOOK, [OWNER], [PAYMASTER_DEPOSIT wei], [ACCOUNT_SALT]
contract DeployAccounts is Script {
    address internal constant TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    IEntryPoint internal constant EP = IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032);

    function run() external returns (PaddyAccountFactory factory, PaddyPaymaster paymaster, PaddyAccount account) {
        require(block.chainid == 44005, "wrong chain: expected Aevum Testnet 44005");
        require(address(EP).code.length > 0, "EntryPoint v0.7 missing");
        IPayeeRegistry registry = IPayeeRegistry(vm.envAddress("REGISTRY"));
        InvoiceBook book = InvoiceBook(vm.envAddress("BOOK"));
        uint256 deposit = vm.envOr("PAYMASTER_DEPOSIT", uint256(0.2 ether));
        uint256 salt = vm.envOr("ACCOUNT_SALT", uint256(1));

        vm.startBroadcast();
        address owner = vm.envOr("OWNER", msg.sender);
        factory = new PaddyAccountFactory(EP, IERC20(TUSD8), book, registry);
        paymaster = new PaddyPaymaster(EP, msg.sender, 0.01 ether);
        paymaster.deposit{value: deposit}();
        account = factory.createAccount(owner, salt);
        paymaster.enroll(address(account), 0.1 ether);
        vm.stopBroadcast();

        console2.log("PaddyAccountFactory", address(factory));
        console2.log("PaddyPaymaster     ", address(paymaster));
        console2.log("PaddyAccount (demo)", address(account));
    }
}
