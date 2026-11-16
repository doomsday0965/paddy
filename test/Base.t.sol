// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {InvoiceBook} from "../src/InvoiceBook.sol";
import {IPayeeRegistry} from "../src/interfaces/IPayeeRegistry.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";

abstract contract BaseTest is Test {
    uint64 internal constant COOLDOWN = 72 hours;

    PayeeRegistry internal registry;
    InvoiceBook internal book;
    MockUSD8 internal usd;

    address internal admin = makeAddr("admin");
    address internal attester = makeAddr("attester");
    address internal treasury = makeAddr("treasury");
    address internal nkechi = makeAddr("nkechi"); // supplier: Nkechi Foods Ltd
    address internal emeka = makeAddr("emeka"); // supplier: Emeka Logistics
    address internal stranger = makeAddr("stranger");
    address internal relayer = makeAddr("relayer");
    address internal buyer;
    uint256 internal buyerKey;

    string internal constant NKECHI_NAME = "Nkechi Foods Ltd";
    bytes32 internal nkechiHash;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        (buyer, buyerKey) = makeAddrAndKey("buyer");
        usd = new MockUSD8();
        registry = new PayeeRegistry(admin, COOLDOWN);
        book = new InvoiceBook(usd, IPayeeRegistry(address(registry)), admin);
        vm.startPrank(admin);
        registry.setAttester(attester, true);
        registry.setReporter(address(book), true);
        vm.stopPrank();
        nkechiHash = registry.hashName(NKECHI_NAME);
        usd.mint(buyer, 1_000_000e6);
    }

    function _registerAndVerify(address who, string memory name) internal returns (uint256 id) {
        bytes32 h = registry.hashName(name);
        vm.prank(who);
        id = registry.register(name, h, "ipfs://profile");
        vm.prank(attester);
        registry.verify(id, h, uint64(block.timestamp + 180 days));
    }

    function _signReceiveAuth(
        uint256 key,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(usd.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(key, digest);
    }
}
