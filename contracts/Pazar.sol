// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Pazar — tamamen zincir üstü emir defteri (MON / tTRY)
/// @notice Her emir, iptal ve eşleşme zincirde gerçekleşir. Kullanıcı bakiyeleri sözleşmede tutulur;
///         emir verildiğinde ilgili miktar kilitlenir, eşleşmede bakiyeler aynı işlemde el değiştirir.
/// @dev Fiyat: 1 MON karşılığı tTRY, kuruş cinsinden (5150 = 51,50 tTRY).
///      Miktar: MON wei. Lot büyüklüğü 0,0001 MON (1e14 wei) → tutar hesapları her zaman tam bölünür.
///      tTRY bu sözleşmenin içinde basılan, parasal değeri olmayan bir test parasıdır.
contract Pazar {
    // ───────────────────────── Ayarlar ─────────────────────────
    uint128 public constant LOT = 1e14; // 0,0001 MON
    uint128 public constant MIN_AMOUNT = 1e15; // 0,001 MON
    uint64 public constant MAX_PRICE = 1e9; // 10.000.000 tTRY
    uint256 public constant MAX_OPEN = 120; // defterde aynı anda en fazla emir
    uint256 public constant MAX_MATCHES = 12; // bir emrin tek işlemde eşleşebileceği en fazla karşı emir
    uint256 public constant FAUCET_AMOUNT = 10_000e18; // 10.000 tTRY
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    uint256 public constant TRADE_HISTORY = 50;

    // ───────────────────────── Veri ─────────────────────────
    struct Order {
        address owner;
        uint64 price;
        bool isBuy;
        uint128 remaining;
        uint64 createdAt;
    }

    struct OrderView {
        uint256 id;
        address owner;
        bool isBuy;
        uint64 price;
        uint128 remaining;
        uint64 createdAt;
    }

    struct Trade {
        uint64 price;
        uint128 amount;
        uint64 time;
        bool takerBuy;
        address maker;
        address taker;
    }

    mapping(address => uint256) public monBalance; // serbest MON (wei)
    mapping(address => uint256) public tryBalance; // serbest tTRY (wei)
    mapping(address => uint256) public lastFaucet;

    mapping(uint256 => Order) public orders;
    uint256 public nextOrderId = 1;
    uint256[] private _openIds;
    mapping(uint256 => uint256) private _openIndexPlusOne;

    Trade[TRADE_HISTORY] private _trades;
    uint256 public tradeCount;
    uint256 public volumeMon; // toplam işlem gören MON (wei)

    // ───────────────────────── Olaylar / hatalar ─────────────────────────
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Faucet(address indexed user, uint256 amount);
    event OrderPlaced(uint256 indexed id, address indexed owner, bool isBuy, uint64 price, uint128 amount, uint128 rested);
    event OrderCancelled(uint256 indexed id, address indexed owner, uint128 refunded);
    event Traded(
        uint256 indexed makerOrderId,
        address indexed maker,
        address indexed taker,
        bool takerBuy,
        uint64 price,
        uint128 amount
    );

    error BadPrice();
    error BadAmount();
    error InsufficientBalance();
    error NotOwner();
    error NotOpen();
    error FaucetCooldown();
    error TransferFailed();

    // ───────────────────────── Bakiye ─────────────────────────

    receive() external payable {
        _deposit();
    }

    function deposit() external payable {
        _deposit();
    }

    function _deposit() private {
        if (msg.value == 0) revert BadAmount();
        monBalance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (amount == 0 || monBalance[msg.sender] < amount) revert InsufficientBalance();
        monBalance[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Saatte bir 10.000 test-lira (tTRY) verir
    function faucet() external {
        if (lastFaucet[msg.sender] != 0 && block.timestamp < lastFaucet[msg.sender] + FAUCET_COOLDOWN) {
            revert FaucetCooldown();
        }
        lastFaucet[msg.sender] = block.timestamp;
        tryBalance[msg.sender] += FAUCET_AMOUNT;
        emit Faucet(msg.sender, FAUCET_AMOUNT);
    }

    // ───────────────────────── Emirler ─────────────────────────

    /// @notice Limit emir. Karşı taraftaki uygun emirlerle (önce en iyi fiyat, sonra en eski) anında eşleşir;
    ///         kalan kısım deftere yazılır.
    /// @param isBuy true = MON al (tTRY öde), false = MON sat
    /// @param price 1 MON fiyatı, kuruş cinsinden
    /// @param amount MON miktarı (wei), LOT'un katı
    /// @return id Defterde bekleyen emrin kimliği (tamamen eşleştiyse 0)
    function place(bool isBuy, uint64 price, uint128 amount) external returns (uint256 id) {
        if (price == 0 || price > MAX_PRICE) revert BadPrice();
        if (amount < MIN_AMOUNT || amount % LOT != 0) revert BadAmount();

        // Kilitle
        if (isBuy) {
            uint256 cost = _quote(amount, price);
            if (tryBalance[msg.sender] < cost) revert InsufficientBalance();
            tryBalance[msg.sender] -= cost;
        } else {
            if (monBalance[msg.sender] < amount) revert InsufficientBalance();
            monBalance[msg.sender] -= amount;
        }

        uint128 remaining = _match(isBuy, price, amount);

        if (remaining > 0 && _openIds.length < MAX_OPEN) {
            id = nextOrderId++;
            orders[id] = Order({
                owner: msg.sender,
                price: price,
                isBuy: isBuy,
                remaining: remaining,
                createdAt: uint64(block.timestamp)
            });
            _openIds.push(id);
            _openIndexPlusOne[id] = _openIds.length;
        } else if (remaining > 0) {
            // Defter dolu: kalan kısmı iade et
            _refund(msg.sender, isBuy, price, remaining);
            remaining = 0;
        } else {
            nextOrderId++; // tamamen eşleşen emirler de sayılsın
        }

        emit OrderPlaced(id, msg.sender, isBuy, price, amount, remaining);
    }

    function cancel(uint256 id) external {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        if (o.remaining == 0) revert NotOpen();
        uint128 rem = o.remaining;
        o.remaining = 0;
        _removeOpen(id);
        _refund(msg.sender, o.isBuy, o.price, rem);
        emit OrderCancelled(id, msg.sender, rem);
    }

    function _match(bool isBuy, uint64 limitPrice, uint128 amount) private returns (uint128 remaining) {
        remaining = amount;
        for (uint256 n = 0; n < MAX_MATCHES && remaining > 0; n++) {
            uint256 bestId = _bestOpposite(isBuy);
            if (bestId == 0) break;
            Order storage m = orders[bestId];
            if (isBuy ? m.price > limitPrice : m.price < limitPrice) break;

            uint128 fill = remaining < m.remaining ? remaining : m.remaining;
            uint256 quote = _quote(fill, m.price); // işlem yapıcının (maker) fiyatından

            if (isBuy) {
                // Alıcı (taker) limit fiyatından kilitlemişti; fark iade edilir
                tryBalance[msg.sender] += _quote(fill, limitPrice) - quote;
                monBalance[msg.sender] += fill;
                tryBalance[m.owner] += quote; // satıcının MON'u zaten kilitliydi
            } else {
                tryBalance[msg.sender] += quote; // alıcının tTRY'si zaten kilitliydi
                monBalance[m.owner] += fill;
            }

            m.remaining -= fill;
            remaining -= fill;
            volumeMon += fill;
            _recordTrade(m.price, fill, isBuy, m.owner);
            emit Traded(bestId, m.owner, msg.sender, isBuy, m.price, fill);

            if (m.remaining == 0) _removeOpen(bestId);
        }
    }

    // Alış emri için en ucuz satış, satış emri için en pahalı alış; eşit fiyatta en eski emir
    function _bestOpposite(bool takerBuy) private view returns (uint256 bestId) {
        uint64 bestPrice;
        uint256 len = _openIds.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 oid = _openIds[i];
            Order storage o = orders[oid];
            if (o.isBuy == takerBuy) continue;
            bool better;
            if (bestId == 0) better = true;
            else if (takerBuy) better = o.price < bestPrice || (o.price == bestPrice && oid < bestId);
            else better = o.price > bestPrice || (o.price == bestPrice && oid < bestId);
            if (better) {
                bestId = oid;
                bestPrice = o.price;
            }
        }
    }

    function _refund(address user, bool isBuy, uint64 price, uint128 amount) private {
        if (isBuy) tryBalance[user] += _quote(amount, price);
        else monBalance[user] += amount;
    }

    function _removeOpen(uint256 id) private {
        uint256 idx = _openIndexPlusOne[id];
        if (idx == 0) return;
        uint256 last = _openIds[_openIds.length - 1];
        _openIds[idx - 1] = last;
        _openIndexPlusOne[last] = idx;
        _openIds.pop();
        delete _openIndexPlusOne[id];
    }

    function _recordTrade(uint64 price, uint128 amount, bool takerBuy, address maker) private {
        _trades[tradeCount % TRADE_HISTORY] = Trade({
            price: price,
            amount: amount,
            time: uint64(block.timestamp),
            takerBuy: takerBuy,
            maker: maker,
            taker: msg.sender
        });
        tradeCount++;
    }

    function _quote(uint128 amount, uint64 price) private pure returns (uint256) {
        return (uint256(amount) * price) / 100;
    }

    // ───────────────────────── Okuma ─────────────────────────

    /// @notice Defterdeki tüm açık emirler (sıralama arayüzde yapılır)
    function book() external view returns (OrderView[] memory list) {
        uint256 len = _openIds.length;
        list = new OrderView[](len);
        for (uint256 i = 0; i < len; i++) {
            uint256 oid = _openIds[i];
            Order storage o = orders[oid];
            list[i] = OrderView(oid, o.owner, o.isBuy, o.price, o.remaining, o.createdAt);
        }
    }

    /// @notice Son işlemler, en yeni önce
    function recentTrades(uint256 limit) external view returns (Trade[] memory list) {
        uint256 n = tradeCount < TRADE_HISTORY ? tradeCount : TRADE_HISTORY;
        if (limit < n) n = limit;
        list = new Trade[](n);
        for (uint256 i = 0; i < n; i++) {
            list[i] = _trades[(tradeCount - 1 - i) % TRADE_HISTORY];
        }
    }

    /// @notice Kullanıcının serbest ve emirlerde kilitli bakiyeleri
    function balancesOf(address user)
        external
        view
        returns (uint256 monFree, uint256 tryFree, uint256 monLocked, uint256 tryLocked)
    {
        monFree = monBalance[user];
        tryFree = tryBalance[user];
        uint256 len = _openIds.length;
        for (uint256 i = 0; i < len; i++) {
            Order storage o = orders[_openIds[i]];
            if (o.owner != user) continue;
            if (o.isBuy) tryLocked += _quote(o.remaining, o.price);
            else monLocked += o.remaining;
        }
    }

    function stats() external view returns (uint256 orderCount, uint256 trades, uint256 volume, uint256 openCount) {
        return (nextOrderId - 1, tradeCount, volumeMon, _openIds.length);
    }
}
