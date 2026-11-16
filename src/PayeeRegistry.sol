// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPayeeRegistry} from "./interfaces/IPayeeRegistry.sol";
import {NameHash} from "./libraries/NameHash.sol";

/// @title PayeeRegistry: on-chain Confirmation of Payee (CoP) for Paddy
/// @notice Businesses and people register the wallet they want to be paid at, together with the
///         hash of their legal name. Trusted attesters (KYB providers, cooperatives, banks or the
///         Paddy team on testnet) verify the claim for a limited time. Payers and AI agents call
///         `confirmPayee` before paying, the same way a Nigerian bank app shows a NIBSS name
///         enquiry before a transfer. Inspired by ERC-8004 identity registries: one numeric id per
///         identity, an address binding, attestations and a reputation trail.
/// @dev Wallet changes are two-step (propose by old wallet, accept by new wallet) and are
///      flagged as "recently changed" for `walletChangeCooldown`, because "we have changed our
///      account details" is the classic invoice-redirection scam.
contract PayeeRegistry is IPayeeRegistry, Ownable2Step {
    uint256 public constant MAX_DISPLAY_NAME = 64;
    uint64 public constant MAX_VERIFICATION_PERIOD = 400 days;

    struct Payee {
        address wallet;
        Status status;
        uint64 registeredAt;
        uint64 verifiedUntil;
        uint64 walletChangedAt;
        address attester;
        bytes32 nameHash;
        uint32 settledInvoices;
        uint32 settledOnTime;
        string displayName;
        string metadataURI;
    }

    uint64 public immutable override walletChangeCooldown;

    uint256 public payeeCount;
    mapping(uint256 => Payee) private _payees;
    mapping(address => uint256) public override payeeIdOf;
    mapping(uint256 => address) public pendingWallet;
    mapping(address => bool) public isAttester;
    mapping(address => bool) public isReporter;

    event AttesterSet(address indexed attester, bool allowed);
    event ReporterSet(address indexed reporter, bool allowed);
    event PayeeRegistered(uint256 indexed payeeId, address indexed wallet, bytes32 nameHash, string displayName);
    event IdentityUpdated(uint256 indexed payeeId, bytes32 nameHash, string displayName);
    event MetadataUpdated(uint256 indexed payeeId, string metadataURI);
    event PayeeVerified(uint256 indexed payeeId, address indexed attester, uint64 verifiedUntil);
    event VerificationRevoked(uint256 indexed payeeId, address indexed by);
    event PayeeSuspended(uint256 indexed payeeId, address indexed by, string reason);
    event PayeeReinstated(uint256 indexed payeeId);
    event WalletChangeProposed(uint256 indexed payeeId, address indexed from, address indexed to);
    event WalletChangeCancelled(uint256 indexed payeeId);
    event WalletChanged(uint256 indexed payeeId, address indexed from, address indexed to);
    event SettlementRecorded(uint256 indexed payeeId, address indexed reporter, bool onTime);

    error NotAttester();
    error NotReporter();
    error AlreadyRegistered();
    error NotRegistered();
    error UnknownPayee();
    error InvalidDisplayName();
    error InvalidNameHash();
    error NameHashMismatch();
    error InvalidValidity();
    error IsSuspended();
    error NotSuspended();
    error NotVerified();
    error ZeroAddress();
    error NoPendingChange();
    error NotPendingWallet();

    modifier onlyAttester() {
        if (!isAttester[msg.sender]) revert NotAttester();
        _;
    }

    modifier onlyReporter() {
        if (!isReporter[msg.sender]) revert NotReporter();
        _;
    }

    constructor(address initialOwner, uint64 cooldown) Ownable(initialOwner) {
        walletChangeCooldown = cooldown;
    }

    // ---------------------------------------------------------------- admin

    function setAttester(address attester, bool allowed) external onlyOwner {
        if (attester == address(0)) revert ZeroAddress();
        isAttester[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    function setReporter(address reporter, bool allowed) external onlyOwner {
        if (reporter == address(0)) revert ZeroAddress();
        isReporter[reporter] = allowed;
        emit ReporterSet(reporter, allowed);
    }

    // ---------------------------------------------------------------- payee self-service

    /// @param displayName Human-readable name shown in apps (max 64 bytes).
    /// @param nameHash `NameHash.hash(legalName)`; the attester checks the legal name off-chain.
    function register(string calldata displayName, bytes32 nameHash, string calldata metadataURI)
        external
        returns (uint256 payeeId)
    {
        if (payeeIdOf[msg.sender] != 0) revert AlreadyRegistered();
        _checkIdentity(displayName, nameHash);
        payeeId = ++payeeCount;
        Payee storage p = _payees[payeeId];
        p.wallet = msg.sender;
        p.status = Status.Registered;
        p.registeredAt = uint64(block.timestamp);
        p.nameHash = nameHash;
        p.displayName = displayName;
        p.metadataURI = metadataURI;
        payeeIdOf[msg.sender] = payeeId;
        emit PayeeRegistered(payeeId, msg.sender, nameHash, displayName);
    }

    /// @notice Changing the claimed identity drops any verification (a verified name can't be swapped).
    function updateIdentity(string calldata displayName, bytes32 nameHash) external {
        uint256 id = _requireOwnId();
        _checkIdentity(displayName, nameHash);
        Payee storage p = _payees[id];
        p.displayName = displayName;
        p.nameHash = nameHash;
        if (p.status == Status.Verified) {
            p.status = Status.Registered;
            p.verifiedUntil = 0;
            p.attester = address(0);
            emit VerificationRevoked(id, msg.sender);
        }
        emit IdentityUpdated(id, nameHash, displayName);
    }

    function updateMetadata(string calldata metadataURI) external {
        uint256 id = _requireOwnId();
        _payees[id].metadataURI = metadataURI;
        emit MetadataUpdated(id, metadataURI);
    }

    function proposeWalletChange(address newWallet) external {
        uint256 id = _requireOwnId();
        if (newWallet == address(0)) revert ZeroAddress();
        if (payeeIdOf[newWallet] != 0) revert AlreadyRegistered();
        if (_payees[id].status == Status.Suspended) revert IsSuspended();
        pendingWallet[id] = newWallet;
        emit WalletChangeProposed(id, msg.sender, newWallet);
    }

    function cancelWalletChange() external {
        uint256 id = _requireOwnId();
        if (pendingWallet[id] == address(0)) revert NoPendingChange();
        delete pendingWallet[id];
        emit WalletChangeCancelled(id);
    }

    /// @notice Called by the new wallet to prove it is controlled by the payee.
    function acceptWalletChange(uint256 payeeId) external {
        address pending = pendingWallet[payeeId];
        if (pending == address(0)) revert NoPendingChange();
        if (msg.sender != pending) revert NotPendingWallet();
        if (payeeIdOf[pending] != 0) revert AlreadyRegistered();
        Payee storage p = _payees[payeeId];
        if (p.status == Status.Suspended) revert IsSuspended();
        address old = p.wallet;
        delete payeeIdOf[old];
        delete pendingWallet[payeeId];
        payeeIdOf[pending] = payeeId;
        p.wallet = pending;
        p.walletChangedAt = uint64(block.timestamp);
        emit WalletChanged(payeeId, old, pending);
    }

    // ---------------------------------------------------------------- attesters

    /// @param expectedNameHash Hash of the legal name the attester checked; must equal the claim.
    function verify(uint256 payeeId, bytes32 expectedNameHash, uint64 validUntil) external onlyAttester {
        Payee storage p = _existing(payeeId);
        if (p.status == Status.Suspended) revert IsSuspended();
        if (expectedNameHash != p.nameHash) revert NameHashMismatch();
        if (validUntil <= block.timestamp || validUntil > block.timestamp + MAX_VERIFICATION_PERIOD) {
            revert InvalidValidity();
        }
        p.status = Status.Verified;
        p.verifiedUntil = validUntil;
        p.attester = msg.sender;
        emit PayeeVerified(payeeId, msg.sender, validUntil);
    }

    function revokeVerification(uint256 payeeId) external onlyAttester {
        Payee storage p = _existing(payeeId);
        if (p.status != Status.Verified) revert NotVerified();
        p.status = Status.Registered;
        p.verifiedUntil = 0;
        p.attester = address(0);
        emit VerificationRevoked(payeeId, msg.sender);
    }

    /// @notice Freeze a payee after a fraud report. Attesters and the owner can suspend.
    function suspend(uint256 payeeId, string calldata reason) external {
        if (!isAttester[msg.sender] && msg.sender != owner()) revert NotAttester();
        Payee storage p = _existing(payeeId);
        if (p.status == Status.Suspended) revert IsSuspended();
        p.status = Status.Suspended;
        p.verifiedUntil = 0;
        p.attester = address(0);
        delete pendingWallet[payeeId];
        emit PayeeSuspended(payeeId, msg.sender, reason);
    }

    /// @notice Only the owner can lift a suspension; the payee must be re-verified afterwards.
    function reinstate(uint256 payeeId) external onlyOwner {
        Payee storage p = _existing(payeeId);
        if (p.status != Status.Suspended) revert NotSuspended();
        p.status = Status.Registered;
        emit PayeeReinstated(payeeId);
    }

    // ---------------------------------------------------------------- reporters (InvoiceBook)

    function recordSettlement(uint256 payeeId, bool onTime) external override onlyReporter {
        Payee storage p = _existing(payeeId);
        unchecked {
            p.settledInvoices += 1;
            if (onTime) p.settledOnTime += 1;
        }
        emit SettlementRecorded(payeeId, msg.sender, onTime);
    }

    // ---------------------------------------------------------------- views

    function confirmPayee(address wallet, bytes32 expectedNameHash)
        public
        view
        override
        returns (CopResult result, uint256 payeeId, bool walletRecentlyChanged)
    {
        payeeId = payeeIdOf[wallet];
        if (payeeId == 0) return (CopResult.NoRecord, 0, false);
        Payee storage p = _payees[payeeId];
        walletRecentlyChanged = _recentlyChanged(p);
        if (p.status == Status.Suspended) return (CopResult.Suspended, payeeId, walletRecentlyChanged);
        if (p.status != Status.Verified) return (CopResult.NotVerified, payeeId, walletRecentlyChanged);
        if (p.verifiedUntil < block.timestamp) {
            return (CopResult.VerificationExpired, payeeId, walletRecentlyChanged);
        }
        if (p.nameHash != expectedNameHash) return (CopResult.NameMismatch, payeeId, walletRecentlyChanged);
        return (CopResult.Match, payeeId, walletRecentlyChanged);
    }

    /// @notice Convenience overload that normalises and hashes the typed name on-chain.
    function confirmPayeeByName(address wallet, string calldata expectedName)
        external
        view
        returns (CopResult result, uint256 payeeId, bool walletRecentlyChanged)
    {
        return confirmPayee(wallet, NameHash.hash(expectedName));
    }

    /// @notice True when the wallet belongs to a payee with a live verification.
    function isVerified(address wallet) external view returns (bool) {
        uint256 id = payeeIdOf[wallet];
        if (id == 0) return false;
        Payee storage p = _payees[id];
        return p.status == Status.Verified && p.verifiedUntil >= block.timestamp;
    }

    function payeeCore(uint256 payeeId) external view override returns (PayeeCore memory c) {
        Payee storage p = _payees[payeeId];
        c = PayeeCore(p.wallet, p.status, p.verifiedUntil, p.walletChangedAt);
    }

    function getPayee(uint256 payeeId) external view returns (Payee memory) {
        return _payees[payeeId];
    }

    function hashName(string calldata name) external pure returns (bytes32) {
        return NameHash.hash(name);
    }

    // ---------------------------------------------------------------- internal

    function _checkIdentity(string calldata displayName, bytes32 nameHash) private pure {
        uint256 len = bytes(displayName).length;
        if (len == 0 || len > MAX_DISPLAY_NAME) revert InvalidDisplayName();
        if (nameHash == bytes32(0)) revert InvalidNameHash();
    }

    function _requireOwnId() private view returns (uint256 id) {
        id = payeeIdOf[msg.sender];
        if (id == 0) revert NotRegistered();
    }

    function _existing(uint256 payeeId) private view returns (Payee storage p) {
        p = _payees[payeeId];
        if (p.wallet == address(0)) revert UnknownPayee();
    }

    function _recentlyChanged(Payee storage p) private view returns (bool) {
        return p.walletChangedAt != 0 && block.timestamp < uint256(p.walletChangedAt) + walletChangeCooldown;
    }
}
