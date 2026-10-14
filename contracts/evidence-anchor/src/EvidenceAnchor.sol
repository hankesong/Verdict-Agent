// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Records a submitter's claim that it committed an evidence digest.
/// @dev This contract does not inspect evidence contents or determine correctness.
contract EvidenceAnchor {
    error DuplicateRecord();

    event EvidenceAnchored(
        address indexed publisher,
        bytes32 indexed evidenceHash,
        string formatVersion
    );

    mapping(bytes32 => bool) public exists;

    function anchor(bytes32 evidenceHash, string calldata formatVersion) external {
        require(evidenceHash != bytes32(0), "EMPTY_HASH");
        require(bytes(formatVersion).length != 0 && bytes(formatVersion).length <= 40, "INVALID_VERSION");
        bytes32 key = keccak256(abi.encode(msg.sender, evidenceHash, formatVersion));
        if (exists[key]) revert DuplicateRecord();
        exists[key] = true;
        emit EvidenceAnchored(msg.sender, evidenceHash, formatVersion);
    }
}
