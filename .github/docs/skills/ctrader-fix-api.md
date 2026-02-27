# cTrader FIX 4.4 API — Полная спецификация

## Оглавление

1. [Архитектура сессий](#архитектура-сессий)
2. [Поддерживаемые сообщения по сессиям](#поддерживаемые-сообщения-по-сессиям)
3. [Logon (A)](#logon-a)
4. [NewOrderSingle (D)](#newordersingle-d)
5. [OrderCancelRequest (F)](#ordercancelrequest-f)
6. [OrderCancelReplaceRequest (G)](#ordercancelreplacerequest-g)
7. [RequestForPositions (AN)](#requestforpositions-an)
8. [SecurityListRequest (x)](#securitylistrequest-x)
9. [MarketDataRequest (V)](#marketdatarequest-v)
10. [Баланс и Equity](#баланс-и-equity)
11. [cTrader-специфичные особенности](#ctrader-специфичные-особенности)
12. [Ошибки и диагностика](#ошибки-и-диагностика)
13. [Полный список FIX-тегов](#полный-список-fix-тегов)

---

## Архитектура сессий

cTrader FIX разделяет функционал на **две** независимые TCP/TLS-сессии:

| Сессия    | Порт (SSL) | Порт (Plain) | SenderSubID | Назначение                             |
| --------- | ---------- | ------------ | ----------- | -------------------------------------- |
| **TRADE** | 5212       | 5202         | `TRADE`     | Ордера, позиции, модификации           |
| **QUOTE** | 5211       | 5201         | `QUOTE`     | Котировки, подписка на рыночные данные |

> **ВАЖНО**: Каждая сессия имеет собственный Logon и sequence numbers.
> Нельзя отправлять торговые сообщения в QUOTE-сессию и наоборот.

### Подключение

```
Host: live-uk-eqx-02.p.c-trader.com (FTMO Live)
TRADE: TLS порт 5212
QUOTE: TLS порт 5211
TargetCompID: cServer
```

---

## Поддерживаемые сообщения по сессиям

### TRADE сессия (порт 5212)

| MsgType                       | Код | Направление | Описание                          |
| ----------------------------- | --- | ----------- | --------------------------------- |
| Logon                         | A   | →/←         | Аутентификация                    |
| Logout                        | 5   | →/←         | Завершение сессии                 |
| Heartbeat                     | 0   | →/←         | Поддержание соединения            |
| TestRequest                   | 1   | →/←         | Проверка соединения               |
| ResendRequest                 | 2   | →/←         | Запрос пересылки                  |
| SequenceReset                 | 4   | →/←         | Сброс seq numbers                 |
| Reject                        | 3   | ←           | Отклонение сообщения              |
| **NewOrderSingle**            | D   | →           | Новый ордер                       |
| **ExecutionReport**           | 8   | ←           | Отчёт об исполнении               |
| **OrderCancelRequest**        | F   | →           | Отмена ордера                     |
| **OrderCancelReplaceRequest** | G   | →           | Модификация ордера (SL/TP/Volume) |
| **OrderCancelReject**         | 9   | ←           | Отклонение отмены                 |
| OrderStatusRequest            | H   | →           | Запрос статуса ордера             |
| **RequestForPositions**       | AN  | →           | Запрос позиций                    |
| **PositionReport**            | AP  | ←           | Отчёт о позиции                   |
| SecurityListRequest           | x   | →           | Запрос списка символов            |
| SecurityList                  | y   | ←           | Список символов                   |

### ⛔ НЕ поддерживаются в TRADE сессии

| MsgType            | Код | Причина                                                                              |
| ------------------ | --- | ------------------------------------------------------------------------------------ |
| CollateralInquiry  | BB  | **"Invalid MsgType"** — cTrader НЕ реализует FIX Collateral (мы получили этот отказ) |
| CollateralReport   | BA  | Нет, т.к. BB не поддерживается                                                       |
| MarketDataRequest  | V   | Только через QUOTE сессию                                                            |
| MarketDataSnapshot | W   | Только через QUOTE сессию                                                            |

### QUOTE сессия (порт 5211)

| MsgType                  | Код | Направление | Описание                        |
| ------------------------ | --- | ----------- | ------------------------------- |
| Logon                    | A   | →/←         | Аутентификация                  |
| Logout                   | 5   | →/←         | Завершение сессии               |
| Heartbeat                | 0   | →/←         | Поддержание соединения          |
| TestRequest              | 1   | →/←         | Проверка соединения             |
| Reject                   | 3   | ←           | Отклонение сообщения            |
| **MarketDataRequest**    | V   | →           | Подписка на котировки (Bid/Ask) |
| **MarketDataSnapshot**   | W   | ←           | Снапшот котировок               |
| **MarketDataIncRefresh** | X   | ←           | Инкрементальное обновление      |
| SecurityListRequest      | x   | →           | Запрос списка символов          |
| SecurityList             | y   | ←           | Список символов                 |

### ⛔ НЕ поддерживаются в QUOTE сессии

Все торговые сообщения (D, F, G, H, AN) — только через TRADE.

---

## Logon (A)

### Отправка (→ cServer)

```
8=FIX.4.4|9=XXX|35=A|49={SenderCompID}|56=cServer|
34=1|52={YYYYMMDD-HH:MM:SS.mmm}|50={TRADE|QUOTE}|57={TRADE|QUOTE}|
98=0|108=30|141=Y|553={login}|554={password}|10=XXX|
```

| Tag | Имя             | Обязателен | Значение                                    |
| --- | --------------- | ---------- | ------------------------------------------- |
| 35  | MsgType         | ✅         | `A`                                         |
| 49  | SenderCompID    | ✅         | Формат: `live.{broker}.{accountNumber}`     |
| 56  | TargetCompID    | ✅         | `cServer`                                   |
| 50  | SenderSubID     | ✅         | `TRADE` или `QUOTE`                         |
| 57  | TargetSubID     | ✅         | `TRADE` или `QUOTE` (должен совпадать с 50) |
| 98  | EncryptMethod   | ✅         | `0` (none)                                  |
| 108 | HeartBtInt      | ✅         | `30` (секунд)                               |
| 141 | ResetSeqNumFlag | ✅         | `Y` (сбросить sequence)                     |
| 553 | Username        | ✅         | Account number (числовой login)             |
| 554 | Password        | ✅         | FIX API password из cTrader ID настроек     |

### Ответ (← cServer)

Успех: Logon (A) обратно. Ошибка: Logout (5) с tag 58 (Text) содержащим причину.

### Важно (cTrader-специфика)

- **SenderCompID** для live FTMO: `live.ftmo.{accountNumber}` (например `live.ftmo.17062885`)
- **Username (553)** — числовой account ID, НЕ email
- **Password (554)** — это **FIX-пароль** (не пароль от cTrader ID!), генерируется в настройках cTrader ID → Open API → FIX API password
- **SenderSubID (50)** и **TargetSubID (57)** ОБЯЗАТЕЛЬНЫ — определяют тип сессии

---

## NewOrderSingle (D)

### Формат (→ cServer)

```
35=D|49={SenderCompID}|56=cServer|50=TRADE|57=TRADE|
11={ClOrdID}|55={Symbol}|54={Side}|38={OrderQty}|
40={OrdType}|44={Price}|99={StopPx}|59={TimeInForce}|
60={TransactTime}|
```

| Tag | Имя          | Обязателен | Значение                                       |
| --- | ------------ | ---------- | ---------------------------------------------- |
| 11  | ClOrdID      | ✅         | Уникальный client ID ордера (строка)           |
| 55  | Symbol       | ✅         | cTrader symbol ID (числовой! НЕ "EURUSD")      |
| 54  | Side         | ✅         | `1`=Buy, `2`=Sell                              |
| 38  | OrderQty     | ✅         | Объём **в единицах** (100000 = 1 лот forex)    |
| 40  | OrdType      | ✅         | `1`=Market, `2`=Limit, `3`=Stop, `4`=StopLimit |
| 44  | Price        | при Limit  | Цена лимита                                    |
| 99  | StopPx       | при Stop   | Стоп-цена                                      |
| 59  | TimeInForce  | ✅         | `1`=GTC, `3`=IOC, `4`=FOK, `6`=GTD             |
| 60  | TransactTime | ✅         | `YYYYMMDD-HH:MM:SS`                            |

### ⚠️ КРИТИЧНО: Symbol (tag 55) — числовой ID!

cTrader FIX **НЕ** принимает текстовые символы типа "EURUSD".
Нужен числовой Symbol ID из SecurityList:

```
55=1     (EURUSD)
55=2     (GBPUSD)
55=3     (USDJPY)
...
```

Чтобы узнать ID → отправить SecurityListRequest (x).

### Опциональные теги

| Tag  | Имя                 | Значение                                                |
| ---- | ------------------- | ------------------------------------------------------- |
| 1    | Account             | ❌ **НЕ обязателен** в cTrader FIX (уже в SenderCompID) |
| 77   | PositionEffect      | `O`=Open, `C`=Close (для хеджированных аккаунтов)       |
| 15   | Currency            | Не обязателен                                           |
| 9025 | StopLoss (custom)   | cTrader custom tag для SL                               |
| 9026 | TakeProfit (custom) | cTrader custom tag для TP                               |

### Ответ: ExecutionReport (8)

| Tag | Имя       | Описание                                                      |
| --- | --------- | ------------------------------------------------------------- |
| 150 | ExecType  | `0`=New, `F`=Fill, `4`=Canceled, `8`=Rejected                 |
| 39  | OrdStatus | `0`=New, `1`=PartFill, `2`=Filled, `4`=Canceled, `8`=Rejected |
| 37  | OrderID   | Серверный ID ордера                                           |
| 17  | ExecID    | ID исполнения                                                 |
| 6   | AvgPx     | Средняя цена исполнения                                       |
| 14  | CumQty    | Суммарный исполненный объём                                   |
| 151 | LeavesQty | Оставшийся объём                                              |
| 58  | Text      | Текст ошибки при отказе                                       |

---

## OrderCancelRequest (F)

Отмена **pending** ордера (Limit/Stop, не исполненного).

```
35=F|11={ClOrdID}|41={OrigClOrdID}|55={Symbol}|54={Side}|60={TransactTime}|
```

| Tag | Имя          | Обязателен | Значение                                |
| --- | ------------ | ---------- | --------------------------------------- |
| 11  | ClOrdID      | ✅         | Новый уникальный ID для запроса         |
| 41  | OrigClOrdID  | ✅         | Оригинальный ClOrdID отменяемого ордера |
| 55  | Symbol       | ✅         | Symbol ID                               |
| 54  | Side         | ✅         | `1`=Buy, `2`=Sell                       |
| 60  | TransactTime | ✅         | Текущее время                           |

### Ответ

- Успех: ExecutionReport (8) с ExecType=4 (Canceled)
- Отказ: OrderCancelReject (9) с причиной в tag 58

---

## OrderCancelReplaceRequest (G)

Модификация ордера (цена, объём, SL/TP).

```
35=G|11={ClOrdID}|41={OrigClOrdID}|55={Symbol}|54={Side}|
40={OrdType}|38={OrderQty}|44={NewPrice}|59={TimeInForce}|60={TransactTime}|
```

| Tag | Имя          | Обязателен | Значение                                 |
| --- | ------------ | ---------- | ---------------------------------------- |
| 11  | ClOrdID      | ✅         | Новый уникальный ID                      |
| 41  | OrigClOrdID  | ✅         | Оригинальный ClOrdID                     |
| 55  | Symbol       | ✅         | Symbol ID (числовой)                     |
| 54  | Side         | ✅         | Сторона                                  |
| 40  | OrdType      | ✅         | Тип (должен совпадать или быть новым)    |
| 38  | OrderQty     | ✅         | Новый объём (или текущий если не меняем) |
| 44  | Price        | при Limit  | Новая цена                               |
| 99  | StopPx       | при Stop   | Новая стоп-цена                          |
| 59  | TimeInForce  | ✅         | TimeInForce                              |
| 60  | TransactTime | ✅         | Текущее время                            |

---

## RequestForPositions (AN)

### ⚠️ Ваша ошибка: "Invalid tag number, field=1"

Это значит, что **tag 1 (Account) НЕ поддерживается** в cTrader FIX для RequestForPositions.
Аккаунт уже идентифицирован через SenderCompID при Logon.

### Правильный формат (→ cServer)

```
35=AN|49={SenderCompID}|56=cServer|50=TRADE|57=TRADE|
710={PosReqID}|724=0|263=1|60={TransactTime}|
```

| Tag | Имя                     | Обязателен  | Значение                    |
| --- | ----------------------- | ----------- | --------------------------- |
| 710 | PosReqID                | ✅          | Уникальный ID запроса       |
| 724 | PosReqType              | ✅          | `0`=Positions (open)        |
| 263 | SubscriptionRequestType | Опционально | `0`=Snapshot, `1`=Subscribe |
| 60  | TransactTime            | ✅          | `YYYYMMDD-HH:MM:SS`         |

### ❌ НЕ включайте эти теги

| Tag | Имя         | Причина                                      |
| --- | ----------- | -------------------------------------------- |
| 1   | Account     | **"Invalid tag number"** — не поддерживается |
| 581 | AccountType | Не нужен                                     |
| 15  | Currency    | Не нужен                                     |

### Ответ: PositionReport (AP)

Если есть позиции — по одному PositionReport на каждую позицию:

| Tag | Имя                | Описание                                   |
| --- | ------------------ | ------------------------------------------ |
| 710 | PosReqID           | Совпадает с запросом                       |
| 721 | PosMaintRptID      | Position ID (можно использовать для close) |
| 727 | TotalNumPosReports | Общее кол-во отчётов                       |
| 728 | PosReqResult       | `0`=Valid, `2`=No positions                |
| 55  | Symbol             | Symbol ID (числовой)                       |
| 704 | LongQty            | Long объём                                 |
| 705 | ShortQty           | Short объём                                |
| 730 | SettlPrice         | Текущая цена                               |
| 6   | AvgPx              | Средняя цена входа                         |

Если позиций нет: PositionReport с `728=2` (PosReqResult=NoPositionsFound).

---

## SecurityListRequest (x)

Запрос доступных символов и их числовых ID.

```
35=x|320={SecurityReqID}|559=4|
```

| Tag | Имя                     | Обязателен | Значение              |
| --- | ----------------------- | ---------- | --------------------- |
| 320 | SecurityReqID           | ✅         | Уникальный ID запроса |
| 559 | SecurityListRequestType | ✅         | `4`=All Securities    |

### Ответ: SecurityList (y)

Содержит повторяющуюся группу с:

| Tag  | Имя          | Описание                                        |
| ---- | ------------ | ----------------------------------------------- |
| 55   | Symbol       | **Числовой ID символа** (это ключ для ордеров!) |
| 15   | Currency     | Базовая валюта                                  |
| 9013 | SymbolName   | **Текстовое имя** (например "EURUSD")           |
| 9014 | SymbolDigits | Кол-во знаков после запятой                     |

> **ВАЖНО**: именно значение из tag 9013 = текстовое имя, а tag 55 = числовой ID.
> При отправке ордера нужно использовать числовой ID из tag 55.

---

## MarketDataRequest (V)

**Только QUOTE сессия!**

```
35=V|262={MDReqID}|263=1|264=1|
267=2|269=0|269=1|
146=1|55={SymbolID}|
```

| Tag | Имя                     | Обязателен | Значение                                     |
| --- | ----------------------- | ---------- | -------------------------------------------- |
| 262 | MDReqID                 | ✅         | Уникальный ID подписки                       |
| 263 | SubscriptionRequestType | ✅         | `0`=Snapshot, `1`=Subscribe, `2`=Unsubscribe |
| 264 | MarketDepth             | ✅         | `1`=Top of book                              |
| 267 | NoMDEntryTypes          | ✅         | `2` (Bid + Ask)                              |
| 269 | MDEntryType             | ✅ (x2)    | `0`=Bid, `1`=Ask                             |
| 146 | NoRelatedSym            | ✅         | `1` (один символ)                            |
| 55  | Symbol                  | ✅         | **Числовой** Symbol ID                       |

### Ответ: MarketDataSnapshot (W) / MarketDataIncRefresh (X)

| Tag | Имя         | Описание         |
| --- | ----------- | ---------------- |
| 268 | NoMDEntries | Кол-во записей   |
| 269 | MDEntryType | `0`=Bid, `1`=Ask |
| 270 | MDEntryPx   | Цена             |
| 271 | MDEntrySize | Объём            |

---

## Баланс и Equity

### ⛔ CollateralInquiry (BB) — НЕ работает

Как вы обнаружили, cTrader возвращает **"Invalid MsgType"** на CollateralInquiry (BB).
Это стандартное сообщение FIX 4.4, но **cTrader его НЕ реализует**.

### Как получить баланс?

**Вариант 1: cTrader Open API (Protobuf/WebSocket)** — рекомендуемый

cTrader Open API поддерживает ProtoOATraderReq → ProtoOATraderRes, который возвращает:

- balance
- equity
- margin
- freeMargin
- unrealisedPnl

Но это отдельный API (порт 5035, Protobuf через WebSocket), не FIX.

**Вариант 2: Вычислить из позиций**

1. Получите SecurityList (x) → маппинг symbolId → symbolName
2. Подпишитесь на котировки через QUOTE сессию (V)
3. Получите позиции через TRADE сессию (AN/AP)
4. Рассчитайте P&L на основе текущих цен и AvgPx

```
unrealisedPnl = sum(positions: (currentPrice - entryPrice) * volume * pipValue)
equity ≈ balance + unrealisedPnl
```

**Вариант 3: Periodic check через внешний API**

Многие используют cTrader ID REST API или web scraping для получения баланса.

> **Вывод**: FIX API cTrader не имеет встроенного способа получить баланс.
> Либо используйте cTrader Open API (Protobuf), либо рассчитывайте из позиций.

---

## cTrader-специфичные особенности

### 1. Symbol ID — числовой

В стандартном FIX символы обычно текстовые. В cTrader tag 55 содержит **числовой ID**.
Для получения маппинга: SecurityListRequest (x) → ответ содержит tag 9013 с текстовым именем.

### 2. Account НЕ нужен в большинстве сообщений

Аккаунт идентифицируется через **SenderCompID** (формат: `live.{broker}.{accountNumber}`).
Tag 1 (Account) НЕ поддерживается в cTrader FIX для RequestForPositions — вызывает ошибку.

### 3. SenderSubID/TargetSubID обязательны

cTrader требует tag 50 и 57 в каждом сообщении для маршрутизации между TRADE/QUOTE.

### 4. SL/TP через отдельные ордера

FIX 4.4 стандарт не имеет встроенных тегов для SL/TP.
В cTrader FIX SL/TP реализованы через **custom теги**:

| Tag  | Имя        | Описание                          |
| ---- | ---------- | --------------------------------- |
| 9025 | StopLoss   | Цена стоп-лосса (кастомный тег)   |
| 9026 | TakeProfit | Цена тейк-профита (кастомный тег) |

Альтернативно — через отдельные protection orders (Stop/Limit ордера с PositionEffect=C).

### 5. Закрытие позиций

Для закрытия позиции на **хеджированном** аккаунте:

- Отправить NewOrderSingle (D) с **обратным Side** и **PositionEffect=C** (tag 77=C)
- Указать тот же символ и нужный объём

Для **неттинг** аккаунтов — просто обратный ордер.

### 6. Volume в единицах, НЕ лотах

cTrader FIX ожидает объём в **units** (единицах базовой валюты):

- 1 лот EURUSD = 100,000 units
- 0.01 лот = 1,000 units
- 1 лот XAUUSD = 100 oz

### 7. TransactTime в формате UTC

Формат: `YYYYMMDD-HH:MM:SS` или `YYYYMMDD-HH:MM:SS.mmm`

### 8. ResetSeqNumFlag=Y при Logon

cTrader требует `141=Y` при каждом Logon для сброса sequence numbers.

### 9. Heartbeat = 30 секунд стандарт

Рекомендуется 30 секунд. При пропуске heartbeat сервер отправит TestRequest, затем разорвёт соединение.

---

## Ошибки и диагностика

### Типичные ошибки

| Ошибка                        | Причина                                   | Решение                                  |
| ----------------------------- | ----------------------------------------- | ---------------------------------------- |
| "Invalid MsgType"             | Отправлен неподдерживаемый тип (BB, etc.) | Не использовать CollateralInquiry        |
| "Invalid tag number, field=1" | Tag Account (1) не ожидается              | Убрать tag 1 из RequestForPositions      |
| "Logon rejected"              | Неверный пароль или SenderCompID          | Проверить credentials                    |
| ExecType=8, Text="..."        | Ордер отклонён                            | Проверить символ ID, объём, тип          |
| "Unknown symbol"              | Текстовый символ вместо числового ID      | Использовать числовой ID из SecurityList |

### Debugging

Для диагностики FIX-сообщений — заменить SOH (`\x01`) на `|` для читаемости:

```
8=FIX.4.4|9=123|35=A|49=live.ftmo.17062885|56=cServer|34=1|52=20260227-10:30:00.000|50=TRADE|57=TRADE|98=0|108=30|141=Y|553=17062885|554=****|10=123|
```

---

## Полный список FIX-тегов

### Стандартные (используемые cTrader)

| Tag | Имя                 | Тип     | Контекст                      |
| --- | ------------------- | ------- | ----------------------------- |
| 1   | Account             | String  | ⛔ НЕ для AN                  |
| 6   | AvgPx               | Float   | ExecutionReport               |
| 8   | BeginString         | String  | Header (FIX.4.4)              |
| 9   | BodyLength          | Int     | Header                        |
| 10  | CheckSum            | String  | Trailer                       |
| 11  | ClOrdID             | String  | Orders                        |
| 14  | CumQty              | Float   | ExecutionReport               |
| 15  | Currency            | String  | Опционально                   |
| 17  | ExecID              | String  | ExecutionReport               |
| 34  | MsgSeqNum           | Int     | Header                        |
| 35  | MsgType             | String  | Header                        |
| 37  | OrderID             | String  | ExecutionReport               |
| 38  | OrderQty            | Float   | Orders (units!)               |
| 39  | OrdStatus           | Char    | ExecutionReport               |
| 40  | OrdType             | Char    | Orders                        |
| 41  | OrigClOrdID         | String  | Cancel/Replace                |
| 44  | Price               | Float   | Limit orders                  |
| 49  | SenderCompID        | String  | Header                        |
| 50  | SenderSubID         | String  | Header (TRADE/QUOTE)          |
| 52  | SendingTime         | UTCTime | Header                        |
| 54  | Side                | Char    | Orders (1/2)                  |
| 55  | Symbol              | String  | **ЧИСЛОВОЙ ID!**              |
| 56  | TargetCompID        | String  | Header (cServer)              |
| 57  | TargetSubID         | String  | Header (TRADE/QUOTE)          |
| 58  | Text                | String  | Error messages                |
| 59  | TimeInForce         | Char    | Orders                        |
| 60  | TransactTime        | UTCTime | Orders/Positions              |
| 77  | PositionEffect      | Char    | O=Open, C=Close               |
| 98  | EncryptMethod       | Int     | Logon (0)                     |
| 99  | StopPx              | Float   | Stop orders                   |
| 108 | HeartBtInt          | Int     | Logon (30)                    |
| 112 | TestReqID           | String  | TestRequest                   |
| 141 | ResetSeqNumFlag     | Bool    | Logon (Y)                     |
| 146 | NoRelatedSym        | Int     | Market Data                   |
| 150 | ExecType            | Char    | ExecutionReport               |
| 151 | LeavesQty           | Float   | ExecutionReport               |
| 262 | MDReqID             | String  | Market Data                   |
| 263 | SubscriptionReqType | Char    | Подписка                      |
| 264 | MarketDepth         | Int     | Market Data                   |
| 267 | NoMDEntryTypes      | Int     | Market Data                   |
| 268 | NoMDEntries         | Int     | Market Data                   |
| 269 | MDEntryType         | Char    | 0=Bid, 1=Ask                  |
| 270 | MDEntryPx           | Float   | Market Data                   |
| 271 | MDEntrySize         | Float   | Market Data                   |
| 320 | SecurityReqID       | String  | SecurityList                  |
| 553 | Username            | String  | Logon                         |
| 554 | Password            | String  | Logon                         |
| 559 | SecurityListReqType | Int     | SecurityList                  |
| 581 | AccountType         | Int     | Опционально                   |
| 702 | NoPositions         | Int     | PositionReport                |
| 703 | PosType             | String  | PositionReport                |
| 704 | LongQty             | Float   | PositionReport                |
| 705 | ShortQty            | Float   | PositionReport                |
| 710 | PosReqID            | String  | RequestForPositions           |
| 721 | PosMaintRptID       | String  | PositionReport (=Position ID) |
| 724 | PosReqType          | Int     | 0=Positions                   |
| 727 | TotalNumPosReports  | Int     | PositionReport                |
| 728 | PosReqResult        | Int     | 0=OK, 2=None                  |
| 730 | SettlPrice          | Float   | PositionReport                |

### cTrader Custom Tags

| Tag  | Имя          | Описание                           |
| ---- | ------------ | ---------------------------------- |
| 9013 | SymbolName   | Текстовое имя символа (EURUSD)     |
| 9014 | SymbolDigits | Digits (5 для forex, 2 для metals) |
| 9025 | StopLoss     | SL цена на ордере/позиции          |
| 9026 | TakeProfit   | TP цена на ордере/позиции          |
| 9027 | TrailingStop | Trailing stop в пипсах             |

---

## Рекомендуемые изменения в коде

### 1. Исправить `getBalance()` — убрать CollateralInquiry

```typescript
// БЫЛО: CollateralInquiry (BB) → "Invalid MsgType"
// НУЖНО: Рассчитать из позиций или использовать cTrader Open API
```

### 2. Исправить `getPositions()` — убрать tag 1 (Account)

```typescript
// БЫЛО:
[Tag.PosReqID, reqId],
[Tag.PosReqType, 0],
[Tag.Account, creds.login],      // ← ОШИБКА: "Invalid tag number, field=1"
[Tag.AccountType, 1],            // ← тоже не нужен
[Tag.Currency, 'USD'],           // ← не нужен
[Tag.TransactTime, fixTransactTime()],

// НУЖНО:
[Tag.PosReqID, reqId],
[Tag.PosReqType, 0],
[Tag.TransactTime, fixTransactTime()],
```

### 3. Исправить `submitOrder()` — Symbol ID

```typescript
// БЫЛО:
[Tag.Symbol, params.symbol],     // "EURUSD" — возможно ошибка

// НУЖНО: маппинг текстового имени → числовой ID
// Сначала SecurityListRequest (x) → получить ID
// Потом: [Tag.Symbol, symbolIdMap['EURUSD']]  // числовой ID
```

### 4. Также убрать tag 1 из `submitOrder()` и `closePosition()`

Account уже в SenderCompID. Может вызывать проблемы.

---

## Порядок инициализации (рекомендуемый)

1. **Logon TRADE** → дождаться Logon ответа
2. **SecurityListRequest (x)** → построить маппинг symbolName ↔ symbolId
3. **(Опционально) Logon QUOTE** → для котировок
4. **RequestForPositions (AN)** → проверить открытые позиции
5. Теперь можно торговать через NewOrderSingle (D)
