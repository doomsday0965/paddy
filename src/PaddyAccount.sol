// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseAccount} from "@account-abstraction/core/BaseAccount.sol";
import {IEntryPoint} from "@account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/interfaces/PackedUserOperation.sol";
import {SIG_VALIDATION_FAILED, _packValidationData} from "@account-abstraction/core/Helpers.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPayeeRegistry} from "./interfaces/IPayeeRegistry.sol";
import {InvoiceBook} from "./InvoiceBook.sol";

/// @title PaddyAccount: ERC-4337 (EntryPoint v0.7) smart account for an SME, with AI session keys
/// @notice The owner (a normal wallet) keeps full control. An AI clerk gets a *session key* that can
///         only pay tUSD8 to the session's approved payees, within a per-payment cap, a daily budget,
///         a total budget and a validity window. Anything over a limit becomes an approval request
///         that only the owner can approve. The owner can revoke a session instantly. Every action,
///         including blocked attempts, leaves an audit event on-chain.
/// @dev Signature format (over the EIP-191 hash of the userOpHash):
///        owner   : 0x00 ‖ sig(65)
///        session : 0x01 ‖ sessionKey(20) ‖ sig(65)
///      A session op may only call `sessionTransfer` or `sessionPayInvoice`, and the first argument of
///      that call must be the signing session key. Validation checks only the signature, the session
///      state and the time window (ERC-4337 storage rules); payee, cap and budget rules are enforced
///      at execution, where a violation is recorded as an event instead of moving funds.
contract PaddyAccount is BaseAccount, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 internal constant MODE_OWNER = 0;
    uint8 internal constant MODE_SESSION = 1;
    uint256 public constant MAX_PENDING_PER_SESSION = 5;
    uint64 public constant REQUEST_TTL = 7 days;

    enum BlockReason {
        SessionInactive,
        PayeeNotAllowed,
        PayeeNotVerified,
        InvoiceNotPayable,
        ZeroAmount,
        TooManyPending
    }

    enum LimitHit {
        None,
        PerPaymentCap,
        DailyBudget,
        TotalBudget
    }

    enum RequestKind {
        Transfer,
        Invoice
    }

    enum RequestStatus {
        None,
        Pending,
        Approved,
        Rejected
    }

    struct Session {
        uint48 validAfter;
        uint48 validUntil;
        bool revoked;
        bool requireVerifiedPayee;
        uint128 perPaymentCap;
        uint128 dailyBudget;
        uint128 totalBudget;
        uint128 spentToday;
        uint128 totalSpent;
        uint32 day;
        uint32 pending;
        string label;
    }

    struct ApprovalRequest {
        RequestKind kind;
        RequestStatus status;
        LimitHit limit;
        address sessionKey;
        address payee;
        uint128 amount;
        uint64 createdAt;
        uint256 invoiceId;
        bytes32 ref;
    }

    IEntryPoint private immutable _entryPoint;
    IERC20 public immutable token;
    InvoiceBook public immutable book;
    IPayeeRegistry public immutable registry;

    address public owner;
    mapping(address => Session) private _sessions;
    mapping(address => mapping(address => bool)) public isSessionPayee;
    uint256 public requestCount;
    mapping(uint256 => ApprovalRequest) private _requests;

    // ---------------------------------------------------------------- audit events
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event SessionCreated(
        address indexed sessionKey,
        string label,
        uint48 validAfter,
        uint48 validUntil,
        uint128 perPaymentCap,
        uint128 dailyBudget,
        uint128 totalBudget,
        bool requireVerifiedPayee
    );
    event SessionPayeeSet(address indexed sessionKey, address indexed payee, bool allowed);
    event SessionRevoked(address indexed sessionKey, address indexed by);
    event SessionPayment(
        address indexed sessionKey, address indexed payee, uint256 amount, uint256 invoiceId, bytes32 ref
    );
    event SessionActionBlocked(
        address indexed sessionKey, BlockReason reason, address payee, uint256 amount, uint256 invoiceId, bytes32 ref
    );
    event ApprovalRequested(
        uint256 indexed requestId,
        address indexed sessionKey,
        LimitHit limit,
        address payee,
        uint256 amount,
        uint256 invoiceId,
        bytes32 ref
    );
    event RequestApproved(uint256 indexed requestId, address indexed payee, uint256 amount);
    event RequestRejected(uint256 indexed requestId);
    event OwnerExecuted(address indexed target, uint256 value, bytes4 selector);

    error NotOwner();
    error NotOwnerOrEntryPoint();
    error InvalidSession();
    error InvalidRequest();
    error RequestExpired();
    error ZeroAddress();
    error CallFailed(bytes result);

    modifier onlyOwnerOrEntryPoint() {
        // Session-signed ops can only reach the two session functions (enforced in validation),
        // so a call from the EntryPoint here was signed by the owner.
        if (msg.sender != owner && msg.sender != address(_entryPoint)) revert NotOwnerOrEntryPoint();
        _;
    }

    modifier onlyEntryPoint() {
        _requireFromEntryPoint();
        _;
    }

    constructor(IEntryPoint entryPoint_, address owner_, IERC20 token_, InvoiceBook book_, IPayeeRegistry registry_) {
        if (owner_ == address(0)) revert ZeroAddress();
        _entryPoint = entryPoint_;
        owner = owner_;
        token = token_;
        book = book_;
        registry = registry_;
        emit OwnerChanged(address(0), owner_);
    }

    receive() external payable {}

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    // ================================================================ ERC-4337 validation

    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256 validationData)
    {
        bytes calldata sig = userOp.signature;
        if (sig.length == 0) return SIG_VALIDATION_FAILED;
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        uint8 mode = uint8(sig[0]);

        if (mode == MODE_OWNER) {
            if (sig.length != 66) return SIG_VALIDATION_FAILED;
            (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig[1:]);
            return (err == ECDSA.RecoverError.NoError && rec == owner) ? 0 : SIG_VALIDATION_FAILED;
        }

        if (mode == MODE_SESSION) {
            if (sig.length != 86) return SIG_VALIDATION_FAILED;
            address key = address(bytes20(sig[1:21]));
            (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig[21:]);
            if (err != ECDSA.RecoverError.NoError || rec != key) return SIG_VALIDATION_FAILED;
            if (!_isSessionCall(userOp.callData, key)) return SIG_VALIDATION_FAILED;
            Session storage s = _sessions[key];
            if (s.validUntil == 0 || s.revoked) return SIG_VALIDATION_FAILED;
            return _packValidationData(false, s.validUntil, s.validAfter);
        }
        return SIG_VALIDATION_FAILED;
    }

    function _isSessionCall(bytes calldata callData, address key) private pure returns (bool) {
        if (callData.length < 36) return false;
        bytes4 sel = bytes4(callData[:4]);
        if (sel != this.sessionTransfer.selector && sel != this.sessionPayInvoice.selector) return false;
        return abi.decode(callData[4:36], (address)) == key;
    }

    // ================================================================ owner: sessions

    function createSession(
        address sessionKey,
        string calldata label,
        uint48 validAfter,
        uint48 validUntil,
        uint128 perPaymentCap,
        uint128 dailyBudget,
        uint128 totalBudget,
        bool requireVerifiedPayee,
        address[] calldata payees
    ) external onlyOwnerOrEntryPoint {
        if (sessionKey == address(0) || sessionKey == owner) revert InvalidSession();
        if (_sessions[sessionKey].validUntil != 0) revert InvalidSession(); // keys are single-use
        if (validUntil <= block.timestamp || validUntil <= validAfter) revert InvalidSession();
        if (perPaymentCap == 0 || dailyBudget < perPaymentCap || totalBudget < dailyBudget) revert InvalidSession();
        Session storage s = _sessions[sessionKey];
        s.validAfter = validAfter;
        s.validUntil = validUntil;
        s.requireVerifiedPayee = requireVerifiedPayee;
        s.perPaymentCap = perPaymentCap;
        s.dailyBudget = dailyBudget;
        s.totalBudget = totalBudget;
        s.label = label;
        emit SessionCreated(
            sessionKey, label, validAfter, validUntil, perPaymentCap, dailyBudget, totalBudget, requireVerifiedPayee
        );
        for (uint256 i; i < payees.length; ++i) {
            _setPayee(sessionKey, payees[i], true);
        }
    }

    function setSessionPayee(address sessionKey, address payee, bool allowed) external onlyOwnerOrEntryPoint {
        if (_sessions[sessionKey].validUntil == 0) revert InvalidSession();
        _setPayee(sessionKey, payee, allowed);
    }

    /// @notice Instant kill switch. Callable straight from the owner's wallet (no bundler needed).
    function revokeSession(address sessionKey) external onlyOwnerOrEntryPoint {
        Session storage s = _sessions[sessionKey];
        if (s.validUntil == 0 || s.revoked) revert InvalidSession();
        s.revoked = true;
        emit SessionRevoked(sessionKey, msg.sender);
    }

    // ================================================================ owner: approvals

    function approveRequest(uint256 requestId) external onlyOwnerOrEntryPoint nonReentrant {
        ApprovalRequest storage r = _pendingRequest(requestId);
        if (block.timestamp > uint256(r.createdAt) + REQUEST_TTL) revert RequestExpired();
        r.status = RequestStatus.Approved;
        _sessions[r.sessionKey].pending -= 1;
        if (r.kind == RequestKind.Transfer) {
            token.safeTransfer(r.payee, r.amount);
        } else {
            _payInvoice(r.invoiceId, r.amount);
        }
        emit RequestApproved(requestId, r.payee, r.amount);
    }

    function rejectRequest(uint256 requestId) external onlyOwnerOrEntryPoint {
        ApprovalRequest storage r = _pendingRequest(requestId);
        r.status = RequestStatus.Rejected;
        _sessions[r.sessionKey].pending -= 1;
        emit RequestRejected(requestId);
    }

    // ================================================================ owner: general

    function execute(address target, uint256 value, bytes calldata data) external onlyOwnerOrEntryPoint {
        _call(target, value, data);
    }

    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
        external
        onlyOwnerOrEntryPoint
    {
        if (targets.length != values.length || targets.length != datas.length) revert InvalidRequest();
        for (uint256 i; i < targets.length; ++i) {
            _call(targets[i], values[i], datas[i]);
        }
    }

    function transferOwnership(address newOwner) external onlyOwnerOrEntryPoint {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Top up this account's gas deposit at the EntryPoint (used when no paymaster sponsors).
    function addDeposit() external payable {
        _entryPoint.depositTo{value: msg.value}(address(this));
    }

    // ================================================================ session actions (EntryPoint only)

    /// @notice AI clerk pays an approved payee directly.
    function sessionTransfer(address sessionKey, address payee, uint128 amount, bytes32 ref)
        external
        onlyEntryPoint
        nonReentrant
    {
        if (!_checkCommon(sessionKey, payee, amount, 0, ref)) return;
        LimitHit hit = _limitHit(_sessions[sessionKey], amount);
        if (hit != LimitHit.None) {
            _queue(RequestKind.Transfer, hit, sessionKey, payee, amount, 0, ref);
            return;
        }
        _spend(_sessions[sessionKey], amount);
        token.safeTransfer(payee, amount);
        emit SessionPayment(sessionKey, payee, amount, 0, ref);
    }

    /// @notice AI clerk settles an InvoiceBook invoice. The pay-to wallet is resolved on-chain from
    ///         the registry; whatever the invoice text says is irrelevant.
    function sessionPayInvoice(address sessionKey, uint256 invoiceId, uint128 amount)
        external
        onlyEntryPoint
        nonReentrant
    {
        InvoiceBook.Invoice memory inv = book.getInvoice(invoiceId);
        address payee = registry.payeeCore(inv.payeeId).wallet;
        bytes32 ref = inv.ref;
        if (book.payability(invoiceId, address(this)) != 0) {
            emit SessionActionBlocked(sessionKey, BlockReason.InvoiceNotPayable, payee, amount, invoiceId, ref);
            return;
        }
        if (!_checkCommon(sessionKey, payee, amount, invoiceId, ref)) return;
        LimitHit hit = _limitHit(_sessions[sessionKey], amount);
        if (hit != LimitHit.None) {
            _queue(RequestKind.Invoice, hit, sessionKey, payee, amount, invoiceId, ref);
            return;
        }
        _spend(_sessions[sessionKey], amount);
        _payInvoice(invoiceId, amount);
        emit SessionPayment(sessionKey, payee, amount, invoiceId, ref);
    }

    // ================================================================ views

    function getSession(address sessionKey) external view returns (Session memory) {
        return _sessions[sessionKey];
    }

    function getRequest(uint256 requestId) external view returns (ApprovalRequest memory) {
        return _requests[requestId];
    }

    /// @notice True if the session could sign right now (not revoked, inside its window).
    function isSessionLive(address sessionKey) public view returns (bool) {
        Session storage s = _sessions[sessionKey];
        return s.validUntil != 0 && !s.revoked && block.timestamp >= s.validAfter && block.timestamp <= s.validUntil;
    }

    /// @notice What a session could still spend today without owner approval.
    function remainingToday(address sessionKey) external view returns (uint256) {
        Session storage s = _sessions[sessionKey];
        uint128 spent = s.day == _today() ? s.spentToday : 0;
        uint256 daily = s.dailyBudget > spent ? s.dailyBudget - spent : 0;
        uint256 total = s.totalBudget > s.totalSpent ? s.totalBudget - s.totalSpent : 0;
        return daily < total ? daily : total;
    }

    // ================================================================ internal

    function _checkCommon(address key, address payee, uint128 amount, uint256 invoiceId, bytes32 ref)
        private
        returns (bool)
    {
        Session storage s = _sessions[key];
        BlockReason reason;
        bool blocked = true;
        if (!isSessionLive(key)) reason = BlockReason.SessionInactive;
        else if (amount == 0) reason = BlockReason.ZeroAmount;
        else if (!isSessionPayee[key][payee]) reason = BlockReason.PayeeNotAllowed;
        else if (s.requireVerifiedPayee && !_isVerified(payee)) reason = BlockReason.PayeeNotVerified;
        else blocked = false;
        if (blocked) emit SessionActionBlocked(key, reason, payee, amount, invoiceId, ref);
        return !blocked;
    }

    function _isVerified(address payee) private view returns (bool) {
        uint256 id = registry.payeeIdOf(payee);
        if (id == 0) return false;
        IPayeeRegistry.PayeeCore memory c = registry.payeeCore(id);
        return c.status == IPayeeRegistry.Status.Verified && c.verifiedUntil >= block.timestamp;
    }

    function _limitHit(Session storage s, uint128 amount) private view returns (LimitHit) {
        if (amount > s.perPaymentCap) return LimitHit.PerPaymentCap;
        uint128 spent = s.day == _today() ? s.spentToday : 0;
        if (uint256(spent) + amount > s.dailyBudget) return LimitHit.DailyBudget;
        if (uint256(s.totalSpent) + amount > s.totalBudget) return LimitHit.TotalBudget;
        return LimitHit.None;
    }

    function _spend(Session storage s, uint128 amount) private {
        uint32 today = _today();
        if (s.day != today) {
            s.day = today;
            s.spentToday = 0;
        }
        s.spentToday += amount;
        s.totalSpent += amount;
    }

    function _queue(
        RequestKind kind,
        LimitHit hit,
        address key,
        address payee,
        uint128 amount,
        uint256 invoiceId,
        bytes32 ref
    ) private {
        Session storage s = _sessions[key];
        if (s.pending >= MAX_PENDING_PER_SESSION) {
            emit SessionActionBlocked(key, BlockReason.TooManyPending, payee, amount, invoiceId, ref);
            return;
        }
        s.pending += 1;
        uint256 id = ++requestCount;
        _requests[id] = ApprovalRequest({
            kind: kind,
            status: RequestStatus.Pending,
            limit: hit,
            sessionKey: key,
            payee: payee,
            amount: amount,
            createdAt: uint64(block.timestamp),
            invoiceId: invoiceId,
            ref: ref
        });
        emit ApprovalRequested(id, key, hit, payee, amount, invoiceId, ref);
    }

    function _payInvoice(uint256 invoiceId, uint128 amount) private {
        token.forceApprove(address(book), amount);
        book.pay(invoiceId, amount);
        token.forceApprove(address(book), 0);
    }

    function _pendingRequest(uint256 requestId) private view returns (ApprovalRequest storage r) {
        r = _requests[requestId];
        if (r.status != RequestStatus.Pending) revert InvalidRequest();
    }

    function _setPayee(address key, address payee, bool allowed) private {
        if (payee == address(0) || payee == address(this)) revert ZeroAddress();
        isSessionPayee[key][payee] = allowed;
        emit SessionPayeeSet(key, payee, allowed);
    }

    function _call(address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory res) = target.call{value: value}(data);
        if (!ok) revert CallFailed(res);
        emit OwnerExecuted(target, value, data.length >= 4 ? bytes4(data[:4]) : bytes4(0));
    }

    function _today() private view returns (uint32) {
        return uint32(block.timestamp / 1 days);
    }
}
