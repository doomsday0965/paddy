// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaddyAccount} from "./PaddyAccount.sol";
import {InvoiceBook} from "./InvoiceBook.sol";
import {IPayeeRegistry} from "./interfaces/IPayeeRegistry.sol";

/// @title PaddyAccountFactory: deterministic (CREATE2) deployment of PaddyAccounts
/// @notice Usable as ERC-4337 `factory` in a UserOperation, so an SME's account address is known
///         before it exists and the first userOp deploys it.
contract PaddyAccountFactory {
    IEntryPoint public immutable entryPoint;
    IERC20 public immutable token;
    InvoiceBook public immutable book;
    IPayeeRegistry public immutable registry;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(IEntryPoint entryPoint_, IERC20 token_, InvoiceBook book_, IPayeeRegistry registry_) {
        entryPoint = entryPoint_;
        token = token_;
        book = book_;
        registry = registry_;
    }

    function createAccount(address owner, uint256 salt) external returns (PaddyAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length != 0) return PaddyAccount(payable(predicted));
        account = new PaddyAccount{salt: bytes32(salt)}(entryPoint, owner, token, book, registry);
        emit AccountCreated(address(account), owner, salt);
    }

    function getAddress(address owner, uint256 salt) public view returns (address) {
        bytes memory init =
            abi.encodePacked(type(PaddyAccount).creationCode, abi.encode(entryPoint, owner, token, book, registry));
        return Create2.computeAddress(bytes32(salt), keccak256(init));
    }
}
