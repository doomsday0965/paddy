// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPayeeRegistry} from "./interfaces/IPayeeRegistry.sol";
import {IEIP3009} from "./interfaces/IEIP3009.sol";

/// @title InvoiceBook: stablecoin invoices with Confirmation-of-Payee protection
/// @notice Registered payees issue invoices in tUSD8. Payers settle directly (approve + pay) or
///         gaslessly with an EIP-3009 `receiveWithAuthorization` signature that is bound to one
///         invoice, so a relayer can't redirect it. Every payment produces an on-chain receipt.
/// @dev Safety rules:
///      - funds go to the payee's *current* registry wallet, never to an address in invoice text;
///      - payment is blocked if the payee is suspended;
///      - if the payee changed wallet after issuing, the invoice is frozen until the payee
///        re-confirms it from the new wallet after the registry cooldown (anti invoice-redirection);
///      - external refs are unique per payee, so agents can retry `createInvoice` idempotently;
///      - the fee rate is snapshotted at issue time and hard-capped at 1%.
contract InvoiceBook is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Paid,
        Cancelled
    }

    enum Method {
        Direct,
        Authorization
    }

    struct Invoice {
        uint256 payeeId;
        address payer; // address(0) = anyone may pay
        uint128 amount;
        uint128 paid;
        uint64 issuedAt;
        uint64 dueDate;
        uint64 confirmedAt; // last time the payee confirmed the pay-to wallet
        uint16 feeBps;
        bool allowPartial;
        Status status;
        bytes32 ref; // hash of the payee's own invoice number
        bytes32 metadataHash; // hash of the off-chain invoice document (line items, PDF)
    }

    struct Receipt {
        uint256 invoiceId;
        address payer;
        address paidTo;
        uint128 amount;
        uint128 fee;
        uint64 paidAt;
        Method method;
    }

    uint16 public constant MAX_FEE_BPS = 100; // 1%
    uint16 private constant BPS = 10_000;

    IERC20 public immutable token;
    IPayeeRegistry public immutable registry;

    uint16 public feeBps;
    address public feeRecipient;

    uint256 public invoiceCount;
    mapping(uint256 => Invoice) private _invoices;
    mapping(uint256 => mapping(bytes32 => uint256)) public invoiceIdByRef; // payeeId => ref => id
    Receipt[] private _receipts;

    event FeeUpdated(uint16 feeBps, address feeRecipient);
    event InvoiceCreated(
        uint256 indexed invoiceId,
        uint256 indexed payeeId,
        address indexed payer,
        uint256 amount,
        uint64 dueDate,
        bytes32 ref,
        bytes32 metadataHash,
        bool allowPartial
    );
    event InvoiceCancelled(uint256 indexed invoiceId);
    event InvoiceReconfirmed(uint256 indexed invoiceId, address wallet);
    event PaymentReceived(
        uint256 indexed invoiceId,
        uint256 indexed receiptId,
        address indexed payer,
        address paidTo,
        uint256 amount,
        uint256 fee,
        uint256 totalPaid,
        Method method
    );
    event InvoicePaid(uint256 indexed invoiceId, bool onTime);
    event ReputationUpdateFailed(uint256 indexed invoiceId);

    error NotRegisteredPayee();
    error PayeeIsSuspended();
    error InvalidAmount();
    error InvalidDueDate();
    error InvalidRef();
    error DuplicateRef(uint256 existingInvoiceId);
    error UnknownInvoice();
    error NotOpen();
    error NotIssuer();
    error NotAuthorizedPayer();
    error AlreadyPartiallyPaid();
    error Overpayment(uint256 remaining);
    error PartialNotAllowed();
    error WalletChangedSinceIssue();
    error CooldownActive(uint256 until);
    error FeeTooHigh();
    error ZeroAddress();

    constructor(IERC20 token_, IPayeeRegistry registry_, address initialOwner) Ownable(initialOwner) {
        if (address(token_) == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        token = token_;
        registry = registry_;
    }

    // ---------------------------------------------------------------- admin

    function setFee(uint16 newFeeBps, address recipient) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (newFeeBps > 0 && recipient == address(0)) revert ZeroAddress();
        feeBps = newFeeBps;
        feeRecipient = recipient;
        emit FeeUpdated(newFeeBps, recipient);
    }

    // ---------------------------------------------------------------- payee actions

    function createInvoice(
        address payer,
        uint128 amount,
        uint64 dueDate,
        bytes32 ref,
        bytes32 metadataHash,
        bool allowPartial
    ) external returns (uint256 invoiceId) {
        uint256 payeeId = registry.payeeIdOf(msg.sender);
        if (payeeId == 0) revert NotRegisteredPayee();
        if (registry.payeeCore(payeeId).status == IPayeeRegistry.Status.Suspended) revert PayeeIsSuspended();
        if (amount == 0) revert InvalidAmount();
        if (dueDate <= block.timestamp) revert InvalidDueDate();
        if (ref == bytes32(0)) revert InvalidRef();
        uint256 existing = invoiceIdByRef[payeeId][ref];
        if (existing != 0) revert DuplicateRef(existing);

        invoiceId = ++invoiceCount;
        _invoices[invoiceId] = Invoice({
            payeeId: payeeId,
            payer: payer,
            amount: amount,
            paid: 0,
            issuedAt: uint64(block.timestamp),
            dueDate: dueDate,
            confirmedAt: uint64(block.timestamp),
            feeBps: feeBps,
            allowPartial: allowPartial,
            status: Status.Open,
            ref: ref,
            metadataHash: metadataHash
        });
        invoiceIdByRef[payeeId][ref] = invoiceId;
        emit InvoiceCreated(invoiceId, payeeId, payer, amount, dueDate, ref, metadataHash, allowPartial);
    }

    function cancelInvoice(uint256 invoiceId) external {
        Invoice storage inv = _open(invoiceId);
        if (registry.payeeIdOf(msg.sender) != inv.payeeId) revert NotIssuer();
        if (inv.paid != 0) revert AlreadyPartiallyPaid();
        inv.status = Status.Cancelled;
        emit InvoiceCancelled(invoiceId);
    }

    /// @notice After a wallet change, the payee unfreezes an invoice from the new wallet once the
    ///         registry cooldown has passed, giving payers time to notice a hijack.
    function reconfirmInvoice(uint256 invoiceId) external {
        Invoice storage inv = _open(invoiceId);
        if (registry.payeeIdOf(msg.sender) != inv.payeeId) revert NotIssuer();
        IPayeeRegistry.PayeeCore memory c = registry.payeeCore(inv.payeeId);
        uint256 until = uint256(c.walletChangedAt) + registry.walletChangeCooldown();
        if (block.timestamp < until) revert CooldownActive(until);
        inv.confirmedAt = uint64(block.timestamp);
        emit InvoiceReconfirmed(invoiceId, msg.sender);
    }

    // ---------------------------------------------------------------- payments

    /// @notice Pay from msg.sender (requires prior `approve` of this contract on tUSD8).
    function pay(uint256 invoiceId, uint128 amount) external nonReentrant returns (uint256 receiptId) {
        (Invoice storage inv, address payTo) = _preparePayment(invoiceId, msg.sender, amount);
        uint128 fee = _fee(inv, amount);
        token.safeTransferFrom(msg.sender, payTo, amount - fee);
        if (fee != 0) token.safeTransferFrom(msg.sender, feeRecipient, fee);
        receiptId = _record(invoiceId, inv, msg.sender, payTo, amount, fee, Method.Direct);
    }

    /// @notice Gasless payment: anyone (e.g. the Paddy relayer) submits the payer's EIP-3009
    ///         signature. The signed nonce must equal `authorizationNonce(invoiceId, from, amount, salt)`,
    ///         which binds the signature to this invoice and amount.
    function payWithAuthorization(
        uint256 invoiceId,
        address from,
        uint128 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 receiptId) {
        (Invoice storage inv, address payTo) = _preparePayment(invoiceId, from, amount);
        bytes32 nonce = authorizationNonce(invoiceId, from, amount, salt);
        IEIP3009(address(token))
            .receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        uint128 fee = _fee(inv, amount);
        token.safeTransfer(payTo, amount - fee);
        if (fee != 0) token.safeTransfer(feeRecipient, fee);
        receiptId = _record(invoiceId, inv, from, payTo, amount, fee, Method.Authorization);
    }

    // ---------------------------------------------------------------- views

    function authorizationNonce(uint256 invoiceId, address from, uint128 amount, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), invoiceId, from, amount, salt));
    }

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    function remaining(uint256 invoiceId) external view returns (uint256) {
        Invoice storage inv = _invoices[invoiceId];
        return inv.amount - inv.paid;
    }

    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    /// @param receiptId 1-based id as emitted in `PaymentReceived`.
    function getReceipt(uint256 receiptId) external view returns (Receipt memory) {
        return _receipts[receiptId - 1];
    }

    /// @notice Why a payment would fail right now, for agents and UIs (0 = payable).
    ///         1 unknown/not open, 2 payee suspended, 3 frozen by wallet change, 4 wrong payer.
    function payability(uint256 invoiceId, address payer) external view returns (uint8 code) {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status != Status.Open) return 1;
        IPayeeRegistry.PayeeCore memory c = registry.payeeCore(inv.payeeId);
        if (c.status == IPayeeRegistry.Status.Suspended) return 2;
        if (c.walletChangedAt > inv.confirmedAt) return 3;
        if (inv.payer != address(0) && inv.payer != payer) return 4;
        return 0;
    }

    // ---------------------------------------------------------------- internal

    function _open(uint256 invoiceId) private view returns (Invoice storage inv) {
        inv = _invoices[invoiceId];
        if (inv.status == Status.None) revert UnknownInvoice();
        if (inv.status != Status.Open) revert NotOpen();
    }

    function _preparePayment(uint256 invoiceId, address payer, uint128 amount)
        private
        view
        returns (Invoice storage inv, address payTo)
    {
        inv = _open(invoiceId);
        if (inv.payer != address(0) && inv.payer != payer) revert NotAuthorizedPayer();
        if (amount == 0) revert InvalidAmount();
        uint128 left = inv.amount - inv.paid;
        if (amount > left) revert Overpayment(left);
        if (!inv.allowPartial && amount != left) revert PartialNotAllowed();
        IPayeeRegistry.PayeeCore memory c = registry.payeeCore(inv.payeeId);
        if (c.status == IPayeeRegistry.Status.Suspended) revert PayeeIsSuspended();
        if (c.walletChangedAt > inv.confirmedAt) revert WalletChangedSinceIssue();
        payTo = c.wallet;
    }

    function _fee(Invoice storage inv, uint128 amount) private view returns (uint128) {
        return uint128((uint256(amount) * inv.feeBps) / BPS);
    }

    function _record(
        uint256 invoiceId,
        Invoice storage inv,
        address payer,
        address payTo,
        uint128 amount,
        uint128 fee,
        Method method
    ) private returns (uint256 receiptId) {
        inv.paid += amount;
        _receipts.push(Receipt(invoiceId, payer, payTo, amount, fee, uint64(block.timestamp), method));
        receiptId = _receipts.length;
        emit PaymentReceived(invoiceId, receiptId, payer, payTo, amount, fee, inv.paid, method);
        if (inv.paid == inv.amount) {
            inv.status = Status.Paid;
            bool onTime = block.timestamp <= inv.dueDate;
            emit InvoicePaid(invoiceId, onTime);
            try registry.recordSettlement(inv.payeeId, onTime) {}
            catch {
                emit ReputationUpdateFailed(invoiceId);
            }
        }
    }
}
