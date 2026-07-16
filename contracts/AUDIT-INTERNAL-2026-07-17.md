# Внутренний адверсариальный аудит PoolsSubscription (панель из 3 агентов + вердикт)

> Для внешних аудиторов: это НАШ внутренний прогон ДО вас. 19 находок, 6 must-fix — внесены в v2.

# Сводный отчёт аудита PoolsSubscription.sol

Файл: `C:\Users\user\Desktop\SynergysLab\BergMindset\media-center\backend\contracts\PoolsSubscription.sol`
19 находок трёх аудиторов → после дедупликации 12 уникальных. Все проверены по коду построчно. Контракт immutable после деплоя — всё, что требует правки байткода, попадает в MUST-FIX.

## MUST-FIX (до аудита, с правкой кода)

**M1. Smart-кошельки (ERC-1271) не могут подписаться — HIGH** *(находка 9 + контрактная часть находки 14)*
Проверено: строка 87 вызывает только ECDSA-оверлоад `permit(v,r,s)`, ошибка глотается `catch {}`, падение уезжает в невнятный реверт allowance на стр. 156. Coinbase Smart Wallet — массовый на Base.
Правка:
```solidity
error PermitFailed();
function subscribeWithPermit(uint256 value, uint256 deadline, bytes calldata signature)
    external nonReentrant whenNotPaused
{
    try IFiatTokenV2_2(address(token)).permit(msg.sender, address(this), value, deadline, signature) {} catch {}
    if (token.allowance(msg.sender, address(this)) < price) revert PermitFailed();
    _start(msg.sender);
}
```
Тот же `allowance`-чек добавить и в существующий (v,r,s)-оверлоад — честная ошибка вместо загадочного реверта.

**M2. Гарантированный ежемесячный разрыв доступа — HIGH** *(находка 10; попутно закрывает находки 5 и частично 4)*
Проверено: стр. 106 запрещает charge до истечения; крон суточный → до 24ч `isActive=false` у КАЖДОГО подписчика КАЖДЫЙ месяц, при этом grace-продление (стр. 110–111) берёт base из прошлого — юзер оплачивает мёртвое время.
Правка — пред-окно продления:
```solidity
uint256 public constant RENEW_WINDOW = 1 days;
// стр. 106:
if (block.timestamp + RENEW_WINDOW < s.paidUntil) revert NotDue();
```
Ветка base_ уже корректна для раннего вызова (now < paidUntil ≤ paidUntil+grace → base = paidUntil, двойной оплаты нет). Обновить ТЗ п.3.2: инвариант теперь «нельзя списать больше одного PERIOD вперёд», а не «нельзя при активном». Off-by-one на границе `==` (находка 5) при этом становится штатным поведением.

**M3. После cancel() нет пути назад — MEDIUM** *(дубль: находки 8 и 11)*
Проверено: `autoRenew=true` только в `_start` (стр. 154), `subscribe()` ревертит AlreadyActive (стр. 153), `charge()` — RenewOff. Тупик до истечения периода.
```solidity
event Resumed(address indexed user);
function resume() external {
    Sub storage s = subs[msg.sender];
    if (s.paidUntil == 0) revert RenewOff();
    s.autoRenew = true;
    emit Resumed(msg.sender);
}
```
Событие Resumed обязательно — иначе индексатор крона не увидит возврат.

**M4. renounceOwnership не заблокирован — MEDIUM** *(находка 13)*
Проверено: Ownable2Step защищает только transferOwnership; renounce одношаговый. Renounce при паузе = кирпич навсегда (unpause/setTreasury недоступны).
```solidity
function renounceOwnership() public view override onlyOwner { revert("disabled"); }
```

**M5. setTreasury мгновенный, а комментарий стр. 36 врёт про «2-step» — MEDIUM** *(находка 12)*
Проверено: стр. 135–139 — одна транзакция, эффект сразу; казна экосистемы уже была целью address poisoning. Минимум: исправить комментарий (аудитор поймает расхождение). Рекомендуется: `proposeTreasury()` → `executeTreasury()` не раньше +48ч, событие PendingTreasury → алерт в TG.

**M6. charge списывает по ТЕКУЩЕЙ price — снапшота согласия нет — MEDIUM** *(дубль: находки 1 и 16)*
Проверено: стр. 115 читает глобальный `price`; MAX_PRICE=$50 ограничивает лишь темп, а не сумму — скомпрометированный owner монетизирует весь allowance по 2.5x за ~5 месяцев. Комментарии стр. 12–13 обещают больше, чем код даёт.
Правка (влезает в тот же слот: uint64+bool+uint96 = 21 байт):
```solidity
struct Sub { uint64 paidUntil; bool autoRenew; uint96 priceCap; }
// в _start: s.priceCap = uint96(price);
// в charge: uint256 p = price; if (p > s.priceCap) p = s.priceCap;
// и переводить/эмитить p, а не price
```
Легитимное повышение цены = применяется при повторной подписке. Плюс переписать комментарии 12–13: MAX_PRICE ограничивает цену за период, реальный максимум ущерба = подписанный allowance. И закрепить инвариант фронта: кап permit строго 12×price, НИКОГДА unlimited.

## NICE (не блокирует аудит; ops/фронт/ранбук)

- **Домен permit в рантайме** *(находка 14, фронт-часть)*: Base USDC = FiatTokenV2_2, EIP-712 version **"2"**; фронт берёт домен только через `eip712Domain()` (ERC-5267), никаких хардкодов.
- **Гонка cancel vs charge у истечения** *(дубль: находки 3 и 17)*: реальна (charge permissionless), ущерб = одно обслуженное продление в казну. Лечится фронтом: cancel+revoke заранее, напоминания за 5 дней уже в ТЗ; регламент ручного возврата в суппорте.
- **Висящая permit-подпись** *(находка 15)*: любой может исполнить её напрямую в USDC → allowance без подписки. Средства не под угрозой; deadline ≤1ч как инвариант фронта + баннер «отозвать разрешение» при `allowance>0 && paidUntil==0`.
- **Блэклист/мисконфиг treasury = DoS всех subscribe/charge** *(находка 2)*: реально (стр. 115, 156), лечится setTreasury; мониторинг + сверка адреса из Центра побайтово.
- **Немонотонность на границе grace** *(находка 4)*: скачок +3 дня на границе подтверждён по коду (стр. 110–112), но см. FALSE-POSITIVE ниже про «утечку выручки». После M2 значимость падает; опционально сократить grace.
- **Крон: pre-check и backfill** *(находка 18)*: multicall `allowance+balanceOf` перед charge, `lastProcessedBlock` + getLogs-backfill, суточная сверка с чейном, игнор Cancelled от неизвестных адресов. Не забыть добавить Resumed (M3) в индексацию.
- **Ранбук pause/блэклиста контракта** *(находка 19)*: pause не останавливает «часы» paidUntil — компенсация дней офф-чейн; процедура миграции при блэклисте самого контракта — записать заранее.

## FALSE-POSITIVE / без действий

- **«Утечка выручки ~9% через задержку продления за grace»** *(часть находки 4)* — не эксплуатируемо: charge permissionless, суточный крон вызовет его в первые 24ч после истечения (внутри 3-дневного grace, base=paidUntil, интервал ровно 30 дней). Юзер не контролирует задержку. Сама немонотонность — правда (оставлена в NICE), «скидка» — нет.
- **Находка 6 (double-charge)** — подтверждение корректности: стекинг периодов и двойное списание в блоке невозможны (NotDue после сдвига paidUntil). Действий нет.
- **Находка 7 (uint64-касты)** — переполнение недостижимо (~год 584 млрд), упаковка слота оправдана. Действий нет.
- **Находка 5 как отдельный фикс** — off-by-one `==` реален (стр. 106 vs 122), но поглощается M2 (пред-окно делает пересечение «активен и подлежит списанию» намеренным); отдельная правка не нужна.

**Итог**: 6 MUST-FIX (2 high, 4 medium — все дешёвые, контракт ещё не задеплоен), 7 NICE, ложных атак среди high/medium нет. После правок обновить ТЗ (п.3.2 инвариант, п.3.4 формулировка про MAX_PRICE) — расхождения код↔ТЗ аудитор подсветит первым делом.