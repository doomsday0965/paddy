// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NameHash} from "../src/libraries/NameHash.sol";

contract NameHashHarness {
    function normalize(string memory s) external pure returns (bytes memory) {
        return NameHash.normalize(s);
    }

    function hash(string memory s) external pure returns (bytes32) {
        return NameHash.hash(s);
    }
}

contract NameHashTest is Test {
    NameHashHarness internal h = new NameHashHarness();

    function test_NormalizesCaseSpacesAndPunctuation() public view {
        assertEq(string(h.normalize("Nkechi Foods Ltd.")), "nkechifoodsltd");
        assertEq(h.hash("Nkechi Foods Ltd."), h.hash("  NKECHI   foods, LTD "));
        assertEq(h.hash("Nkechi Foods Ltd"), keccak256("nkechifoodsltd"));
    }

    function test_KeepsDigits() public view {
        assertEq(string(h.normalize("Shop 24/7 Ventures")), "shop247ventures");
    }

    function test_DifferentNamesDiffer() public view {
        assertTrue(h.hash("Nkechi Foods Ltd") != h.hash("Nkechi Food Ltd"));
    }

    function test_DropsNonAscii() public view {
        // "Ọja Mart" -> the dotted O (UTF-8 multibyte) is dropped
        assertEq(string(h.normalize(unicode"Ọja Mart")), "jamart");
    }

    function test_RevertWhen_Empty() public {
        vm.expectRevert(NameHash.EmptyName.selector);
        h.hash("");
        vm.expectRevert(NameHash.EmptyName.selector);
        h.hash(" .,- ");
    }

    function testFuzz_Idempotent(string memory s) public view {
        try h.normalize(s) returns (bytes memory n) {
            assertEq(h.normalize(string(n)), n);
            assertEq(h.hash(string(n)), h.hash(s));
            for (uint256 i; i < n.length; ++i) {
                bytes1 c = n[i];
                assertTrue((c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39));
            }
        } catch {}
    }
}
