// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../src/EvidenceAnchor.sol";

interface Vm {
    function expectEmit(bool, bool, bool, bool, address) external;
    function prank(address) external;
}

contract EvidenceAnchorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    EvidenceAnchor private anchor = new EvidenceAnchor();
    bytes32 private constant HASH = keccak256("evidence");
    string private constant VERSION = "verdict-evidence-manifest-v1";

    event EvidenceAnchored(address indexed publisher, bytes32 indexed evidenceHash, string formatVersion);

    function testAnchorsAndEmitsExpectedEvent() external {
        vm.expectEmit(true, true, false, true, address(anchor));
        emit EvidenceAnchored(address(this), HASH, VERSION);
        anchor.anchor(HASH, VERSION);
        require(anchor.exists(keccak256(abi.encode(address(this), HASH, VERSION))), "record missing");
    }

    function testPublishersAreIsolated() external {
        anchor.anchor(HASH, VERSION);
        address publisher = address(0xBEEF);
        vm.prank(publisher);
        anchor.anchor(HASH, VERSION);
        require(anchor.exists(keccak256(abi.encode(publisher, HASH, VERSION))), "other publisher overwritten");
    }

    function testDuplicateFromSamePublisherReverts() external {
        anchor.anchor(HASH, VERSION);
        (bool ok,) = address(anchor).call(abi.encodeCall(EvidenceAnchor.anchor, (HASH, VERSION)));
        require(!ok, "duplicate unexpectedly accepted");
    }
}
