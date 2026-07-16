// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ДРАФТ ДЛЯ АУДИТА v2 (после внутренней адверсариальной панели 17.07.2026, 6 must-fix внесены).
// НЕ ДЕПЛОИТЬ ДО НЕЗАВИСИМОЙ ПРОВЕРКИ.
// Подписка на сервис пулов cryptocenter.finance: $20/мес в USDC (Base).
//
// Принципы безопасности:
//  1. Контракт НЕ хранит средства: списание идёт напрямую user -> treasury.
//  2. Цена для юзера зафиксирована снапшотом на момент подписки (priceCap):
//     повышение price владельцем НЕ трогает действующих подписчиков до их пере-подписки.
//     MAX_PRICE (иммутабельный) ограничивает цену за период; реальный максимум ущерба
//     юзера в любом сценарии = выданный им allowance (фронт просит кап 12 × price,
//     НИКОГДА unlimited).
//  3. charge() permissionless: вызвать может кто угодно — средства идут ТОЛЬКО в treasury;
//     газовый ключ крона не имеет власти над деньгами.
//  4. Продление разрешено в пред-окне RENEW_WINDOW до истечения — доступ без разрывов.
//  5. Долги за прошлое НЕ начисляются: после простоя дольше grace оплата идёт от «сейчас».
//  6. Смена treasury — только через таймлок 48ч (proposeTreasury -> executeTreasury).
//
// Зависимости (зафиксировать при сборке): OpenZeppelin Contracts v5.x
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Circle FiatTokenV2_2 (USDC на Base): permit с ECDSA-параметрами и с bytes-подписью
/// (вторая форма принимает ERC-1271 — смарт-кошельки, напр. Coinbase Smart Wallet).
interface IFiatTokenV2_2 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature) external;
}

contract PoolsSubscription is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// USDC на Base (6 decimals), задаётся в конструкторе и не меняется.
    IERC20 public immutable token;
    /// Абсолютный потолок цены (микро-USDC), выше которого owner поднять цену НЕ может.
    uint256 public immutable MAX_PRICE;
    /// Длительность оплаченного периода.
    uint256 public constant PERIOD = 30 days;
    /// Пред-окно продления: charge разрешён за сутки ДО истечения — без разрывов доступа.
    uint256 public constant RENEW_WINDOW = 1 days;
    /// Окно встык-продления после просрочки (дальше — отсчёт от «сейчас», без долгов).
    uint256 public constant RENEW_GRACE = 3 days;
    /// Таймлок смены казны.
    uint256 public constant TREASURY_DELAY = 48 hours;

    /// Куда уходят все списания. Меняется ТОЛЬКО через propose/execute с таймлоком.
    address public treasury;
    address public pendingTreasury;
    uint256 public pendingTreasuryAt;
    /// Текущая цена периода в микро-USDC (20e6 = $20) — для НОВЫХ подписок.
    uint256 public price;

    struct Sub {
        uint64 paidUntil;   // до какого момента оплачено (unix)
        bool autoRenew;     // false после cancel(); resume() включает обратно
        uint96 priceCap;    // снапшот цены на момент подписки — потолок списания для юзера
    }
    mapping(address => Sub) public subs;

    event Subscribed(address indexed user, uint64 paidUntil, uint256 paid);
    event Charged(address indexed user, uint64 paidUntil, uint256 paid, address indexed caller);
    event Cancelled(address indexed user);
    event Resumed(address indexed user);
    event PriceChanged(uint256 oldPrice, uint256 newPrice);
    event TreasuryProposed(address indexed current, address indexed proposed, uint256 executableAt);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);

    error AlreadyActive();
    error NotDue();
    error RenewOff();
    error PriceTooHigh();
    error ZeroAddress();
    error PermitFailed();
    error TimelockNotReady();

    constructor(IERC20 _token, address _treasury, uint256 _price, uint256 _maxPrice, address _owner)
        Ownable(_owner)
    {
        if (_treasury == address(0) || address(_token) == address(0)) revert ZeroAddress();
        if (_price == 0 || _price > _maxPrice || _maxPrice > type(uint96).max) revert PriceTooHigh();
        token = _token;
        treasury = _treasury;
        price = _price;
        MAX_PRICE = _maxPrice;
    }

    // ---------- Пользователь ----------

    /// Подписаться (нужен заранее выданный approve на этот контракт).
    function subscribe() external nonReentrant whenNotPaused {
        _requireAllowance(msg.sender);
        _start(msg.sender);
    }

    /// Подписка одной транзакцией: EIP-2612 permit с ECDSA-подписью (обычные кошельки).
    /// value = кап разрешения (фронт: строго 12 × price), deadline ≤ 1 час.
    function subscribeWithPermit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        whenNotPaused
    {
        // front-running-безопасно: исполненный кем-то permit не мешает — важен итоговый allowance
        try IFiatTokenV2_2(address(token)).permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
        _requireAllowance(msg.sender);
        _start(msg.sender);
    }

    /// Подписка для смарт-кошельков (ERC-1271, напр. Coinbase Smart Wallet):
    /// bytes-форма permit из FiatTokenV2_2.
    function subscribeWithPermit(uint256 value, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        try IFiatTokenV2_2(address(token)).permit(msg.sender, address(this), value, deadline, signature) {} catch {}
        _requireAllowance(msg.sender);
        _start(msg.sender);
    }

    /// Отключить автопродление (доступно и при паузе). Оплаченный период дослуживается.
    /// Рекомендуется дополнительно отозвать allowance у токена (фронт показывает кнопку).
    function cancel() external {
        subs[msg.sender].autoRenew = false;
        emit Cancelled(msg.sender);
    }

    /// Включить автопродление обратно (после cancel), пока подписка ещё знакома контракту.
    function resume() external {
        Sub storage s = subs[msg.sender];
        if (s.paidUntil == 0) revert RenewOff();
        s.autoRenew = true;
        emit Resumed(msg.sender);
    }

    // ---------- Продление (permissionless) ----------

    /// Продлить подписку юзера. Вызвать может кто угодно (наш крон, сам юзер) — средства
    /// идут ТОЛЬКО в treasury. Разрешено в пред-окне RENEW_WINDOW до истечения и позже.
    /// Инвариант: больше одного PERIOD вперёд оплатить невозможно.
    function charge(address user) external nonReentrant whenNotPaused {
        Sub storage s = subs[user];
        if (!s.autoRenew || s.paidUntil == 0) revert RenewOff();
        if (block.timestamp + RENEW_WINDOW < s.paidUntil) revert NotDue();

        // Пред-окно и малая просрочка (≤ grace) — продление встык (base = paidUntil);
        // просрочка дольше grace — отсчёт от «сейчас», долги не взыскиваются.
        uint64 base_ = (block.timestamp <= uint256(s.paidUntil) + RENEW_GRACE)
            ? s.paidUntil
            : uint64(block.timestamp);
        s.paidUntil = uint64(uint256(base_) + PERIOD);

        // Цена для юзера — не выше его снапшота на момент подписки.
        uint256 p = price;
        if (p > s.priceCap) p = s.priceCap;

        token.safeTransferFrom(user, treasury, p);
        emit Charged(user, s.paidUntil, p, msg.sender);
    }

    // ---------- Гейт для бэкенда ----------

    function isActive(address user) external view returns (bool) {
        return subs[user].paidUntil >= block.timestamp;
    }

    // ---------- Администрирование (owner = мультисиг/кошелёк основателя) ----------

    /// Смена цены: не выше MAX_PRICE. Действует только на НОВЫЕ подписки (snapshot priceCap).
    function setPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0 || newPrice > MAX_PRICE) revert PriceTooHigh();
        emit PriceChanged(price, newPrice);
        price = newPrice;
    }

    /// Смена казны — двухшаговая с таймлоком 48ч (событие = алерт в TG-мониторинг).
    function proposeTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        pendingTreasury = newTreasury;
        pendingTreasuryAt = block.timestamp + TREASURY_DELAY;
        emit TreasuryProposed(treasury, newTreasury, pendingTreasuryAt);
    }

    function executeTreasury() external onlyOwner {
        if (pendingTreasury == address(0)) revert ZeroAddress();
        if (block.timestamp < pendingTreasuryAt) revert TimelockNotReady();
        emit TreasuryChanged(treasury, pendingTreasury);
        treasury = pendingTreasury;
        pendingTreasury = address(0);
        pendingTreasuryAt = 0;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// Отказ от владения ЗАПРЕЩЁН: renounce при паузе означал бы вечный кирпич.
    function renounceOwnership() public view override onlyOwner {
        revert("disabled");
    }

    // ---------- Внутреннее ----------

    function _requireAllowance(address user) internal view {
        if (token.allowance(user, address(this)) < price) revert PermitFailed();
    }

    function _start(address user) internal {
        Sub storage s = subs[user];
        if (s.paidUntil >= block.timestamp) revert AlreadyActive();
        s.autoRenew = true;
        s.paidUntil = uint64(block.timestamp + PERIOD);
        s.priceCap = uint96(price);
        token.safeTransferFrom(user, treasury, price);
        emit Subscribed(user, s.paidUntil, price);
    }
}
