//+------------------------------------------------------------------+
//|                                          OpenClaw_Bridge.mq5     |
//|                              Copyright 2026, OpenClaw AI Team    |
//|                   Файловый мост между MT5 и OpenClaw агентом     |
//+------------------------------------------------------------------+
//
// УСТАНОВКА:
//   1. Скопируй этот файл в MT5_DATA/MQL5/Experts/OpenClaw_Bridge.mq5
//   2. Скомпилируй в MetaEditor (F7)
//   3. Прикрепи к любому графику (например EURUSD H1)
//   4. Разреши "Автоторговлю" и "Использование DLL"
//
// КАК РАБОТАЕТ:
//   - Каждые N секунд экспортирует данные в CSV файлы
//   - Читает файлы ордеров из папки orders/
//   - Исполняет торговые команды и пишет результаты в results/
//
// ФАЙЛОВАЯ СТРУКТУРА (в MQL5/Files/):
//   export_positions.csv    — открытые позиции (обновляется каждые 5с)
//   export_account.csv      — состояние счёта
//   export_EURUSD_H1.csv    — OHLC данные (если включено)
//   orders/XXX.json         — входящие торговые команды
//   results/XXX.json        — результаты выполнения
//+------------------------------------------------------------------+

#property copyright "OpenClaw AI Team"
#property link      "https://github.com/openclaw-ai"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>

//--- Входные параметры
input int     ExportIntervalSec = 5;      // Интервал обновления данных (сек)
input bool    ExportOHLC       = false;   // Экспортировать OHLC данные (нагрузка)
input int     OHLCBars         = 200;     // Количество баров для OHLC
input string  OrdersFolder     = "orders"; // Папка с командами ордеров
input string  ResultsFolder    = "results"; // Папка с результатами
input string  AgentComment     = "OpenClaw"; // Комментарий к ордерам агента

//--- Глобальные объекты
CTrade         trade;
CPositionInfo  positionInfo;
CAccountInfo   accountInfo;

datetime lastExportTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization                                             |
//+------------------------------------------------------------------+
int OnInit()
{
    trade.SetExpertMagicNumber(202600);
    trade.SetDeviationInPoints(30);

    // Создаём папки
    FolderCreate(OrdersFolder, 0);
    FolderCreate(ResultsFolder, 0);

    Print("OpenClaw Bridge v1.0 запущен. Экспорт каждые ", ExportIntervalSec, "с");
    Print("Папка ордеров: MQL5/Files/", OrdersFolder);
    Print("Папка результатов: MQL5/Files/", ResultsFolder);

    // Первичный экспорт
    ExportPositions();
    ExportAccount();

    return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
    Print("OpenClaw Bridge остановлен. Причина: ", reason);
}

//+------------------------------------------------------------------+
//| Expert tick function (вызывается на каждом тике)                 |
//+------------------------------------------------------------------+
void OnTick()
{
    datetime now = TimeCurrent();

    // Экспорт данных по таймеру
    if(now - lastExportTime >= ExportIntervalSec)
    {
        ExportPositions();
        ExportAccount();
        if(ExportOHLC) ExportOHLCData();
        lastExportTime = now;
    }

    // Проверяем и исполняем входящие ордера
    ProcessPendingOrders();
}

//+------------------------------------------------------------------+
//| Экспорт открытых позиций в CSV                                   |
//+------------------------------------------------------------------+
void ExportPositions()
{
    int handle = FileOpen("export_positions.csv", FILE_WRITE | FILE_CSV | FILE_ANSI, ',');
    if(handle == INVALID_HANDLE)
    {
        Print("Ошибка открытия export_positions.csv: ", GetLastError());
        return;
    }

    // Заголовок
    FileWrite(handle,
              "ticket", "symbol", "type", "volume", "open_price", "price_current",
              "sl", "tp", "profit", "swap", "time", "comment");

    int total = PositionsTotal();
    for(int i = 0; i < total; i++)
    {
        if(positionInfo.SelectByIndex(i))
        {
            string posType = (positionInfo.PositionType() == POSITION_TYPE_BUY) ? "BUY" : "SELL";
            FileWrite(handle,
                      positionInfo.Ticket(),
                      positionInfo.Symbol(),
                      posType,
                      positionInfo.Volume(),
                      positionInfo.PriceOpen(),
                      positionInfo.PriceCurrent(),
                      positionInfo.StopLoss(),
                      positionInfo.TakeProfit(),
                      positionInfo.Profit(),
                      positionInfo.Swap(),
                      TimeToString(positionInfo.Time(), TIME_DATE | TIME_MINUTES),
                      positionInfo.Comment());
        }
    }

    FileClose(handle);
}

//+------------------------------------------------------------------+
//| Экспорт данных счёта в CSV                                       |
//+------------------------------------------------------------------+
void ExportAccount()
{
    int handle = FileOpen("export_account.csv", FILE_WRITE | FILE_CSV | FILE_ANSI, ',');
    if(handle == INVALID_HANDLE) return;

    FileWrite(handle, "balance", "equity", "margin", "margin_free", "margin_level", "profit", "currency", "timestamp");
    FileWrite(handle,
              accountInfo.Balance(),
              accountInfo.Equity(),
              accountInfo.Margin(),
              accountInfo.FreeMargin(),
              accountInfo.MarginLevel(),
              accountInfo.Profit(),
              accountInfo.Currency(),
              TimeToString(TimeCurrent(), TIME_DATE | TIME_MINUTES | TIME_SECONDS));

    FileClose(handle);
}

//+------------------------------------------------------------------+
//| Экспорт OHLC данных (опционально, ресурсоёмко)                  |
//+------------------------------------------------------------------+
void ExportOHLCData()
{
    string symbol = Symbol();
    ENUM_TIMEFRAMES tf = Period();
    string tfStr = EnumToString(tf);
    StringReplace(tfStr, "PERIOD_", "");

    string filename = "export_" + symbol + "_" + tfStr + ".csv";
    int handle = FileOpen(filename, FILE_WRITE | FILE_CSV | FILE_ANSI, ',');
    if(handle == INVALID_HANDLE) return;

    FileWrite(handle, "time", "open", "high", "low", "close", "volume");

    MqlRates rates[];
    int copied = CopyRates(symbol, tf, 0, OHLCBars, rates);

    for(int i = 0; i < copied; i++)
    {
        FileWrite(handle,
                  TimeToString(rates[i].time, TIME_DATE | TIME_MINUTES),
                  rates[i].open,
                  rates[i].high,
                  rates[i].low,
                  rates[i].close,
                  rates[i].tick_volume);
    }

    FileClose(handle);
}

//+------------------------------------------------------------------+
//| Обработка входящих ордеров из папки orders/                     |
//+------------------------------------------------------------------+
void ProcessPendingOrders()
{
    // Ищем JSON файлы в папке orders/
    string filename;
    long search = FileFindFirst(OrdersFolder + "\\*.json", filename, 0);
    if(search == INVALID_HANDLE) return;

    do
    {
        string fullPath = OrdersFolder + "\\" + filename;
        ProcessOrderFile(fullPath, filename);
    }
    while(FileFindNext(search, filename));

    FileFindClose(search);
}

//+------------------------------------------------------------------+
//| Обрабатывает один файл ордера                                    |
//+------------------------------------------------------------------+
void ProcessOrderFile(string filepath, string filename)
{
    int handle = FileOpen(filepath, FILE_READ | FILE_ANSI);
    if(handle == INVALID_HANDLE) return;

    // Читаем JSON как текст
    string content = "";
    while(!FileIsEnding(handle))
        content += FileReadString(handle);
    FileClose(handle);

    // Извлекаем order_id из имени файла (без .json)
    string orderId = filename;
    StringReplace(orderId, ".json", "");

    // Парсим ключевые поля (простой текстовый парсинг)
    string action  = ExtractJsonString(content, "action");
    string pair    = ExtractJsonString(content, "pair");
    string direction = ExtractJsonString(content, "direction");
    double lot     = ExtractJsonDouble(content, "lot");
    double sl      = ExtractJsonDouble(content, "sl");
    double tp      = ExtractJsonDouble(content, "tp");
    long   ticket  = (long)ExtractJsonDouble(content, "ticket");
    double newSL   = ExtractJsonDouble(content, "new_sl");
    double newTP   = ExtractJsonDouble(content, "new_tp");

    string resultJson = "";

    if(action == "open")
        resultJson = ExecuteOpen(orderId, pair, direction, lot, sl, tp);
    else if(action == "close")
        resultJson = ExecuteClose(orderId, ticket);
    else if(action == "modify")
        resultJson = ExecuteModify(orderId, ticket, newSL, newTP);
    else if(action == "close_all")
        resultJson = ExecuteCloseAll(orderId);
    else
        resultJson = "{\"status\":\"ERROR\",\"error\":\"Неизвестный action: " + action + "\",\"order_id\":\"" + orderId + "\"}";

    // Пишем результат
    WriteResult(orderId, resultJson);

    // Удаляем обработанный файл ордера
    FileDelete(filepath, 0);
}

//+------------------------------------------------------------------+
//| Открытие позиции                                                  |
//+------------------------------------------------------------------+
string ExecuteOpen(string orderId, string sym, string dir, double lot, double sl, double tp)
{
    ENUM_ORDER_TYPE orderType = (dir == "BUY") ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
    double price = (orderType == ORDER_TYPE_BUY) ? SymbolInfoDouble(sym, SYMBOL_ASK)
                                                  : SymbolInfoDouble(sym, SYMBOL_BID);

    bool ok = trade.PositionOpen(sym, orderType, lot, price, sl, tp, AgentComment);

    if(ok)
    {
        ulong ticket = trade.ResultOrder();
        double execPrice = trade.ResultPrice();
        return "{\"status\":\"EXECUTED\",\"action\":\"open\",\"ticket\":" + IntegerToString(ticket) +
               ",\"pair\":\"" + sym + "\",\"direction\":\"" + dir + "\",\"lot\":" + DoubleToString(lot, 2) +
               ",\"price\":" + DoubleToString(execPrice, 5) + ",\"sl\":" + DoubleToString(sl, 5) +
               ",\"tp\":" + DoubleToString(tp, 5) + ",\"order_id\":\"" + orderId + "\"}";
    }
    else
    {
        return "{\"status\":\"ERROR\",\"error\":\"" + IntegerToString(trade.ResultRetcode()) +
               "\",\"action\":\"open\",\"order_id\":\"" + orderId + "\"}";
    }
}

//+------------------------------------------------------------------+
//| Закрытие позиции по тикету                                       |
//+------------------------------------------------------------------+
string ExecuteClose(string orderId, long ticket)
{
    bool ok = trade.PositionCloseByTicket((ulong)ticket);
    if(ok)
        return "{\"status\":\"CLOSED\",\"ticket\":" + IntegerToString(ticket) + ",\"order_id\":\"" + orderId + "\"}";
    else
        return "{\"status\":\"ERROR\",\"error\":\"" + IntegerToString(trade.ResultRetcode()) +
               "\",\"ticket\":" + IntegerToString(ticket) + ",\"order_id\":\"" + orderId + "\"}";
}

//+------------------------------------------------------------------+
//| Модификация SL/TP                                                 |
//+------------------------------------------------------------------+
string ExecuteModify(string orderId, long ticket, double newSL, double newTP)
{
    bool ok = trade.PositionModify((ulong)ticket, newSL, newTP);
    if(ok)
        return "{\"status\":\"MODIFIED\",\"ticket\":" + IntegerToString(ticket) +
               ",\"new_sl\":" + DoubleToString(newSL, 5) + ",\"new_tp\":" + DoubleToString(newTP, 5) +
               ",\"order_id\":\"" + orderId + "\"}";
    else
        return "{\"status\":\"ERROR\",\"error\":\"" + IntegerToString(trade.ResultRetcode()) +
               "\",\"ticket\":" + IntegerToString(ticket) + ",\"order_id\":\"" + orderId + "\"}";
}

//+------------------------------------------------------------------+
//| Закрытие всех позиций                                             |
//+------------------------------------------------------------------+
string ExecuteCloseAll(string orderId)
{
    int closed = 0;
    int total = PositionsTotal();
    for(int i = total - 1; i >= 0; i--)
    {
        if(positionInfo.SelectByIndex(i))
        {
            if(trade.PositionClose(positionInfo.Ticket())) closed++;
        }
    }
    return "{\"status\":\"CLOSED_ALL\",\"closed\":" + IntegerToString(closed) + ",\"order_id\":\"" + orderId + "\"}";
}

//+------------------------------------------------------------------+
//| Запись результата в файл                                          |
//+------------------------------------------------------------------+
void WriteResult(string orderId, string content)
{
    string path = ResultsFolder + "\\" + orderId + ".json";
    int handle = FileOpen(path, FILE_WRITE | FILE_ANSI);
    if(handle == INVALID_HANDLE)
    {
        Print("Ошибка записи результата: ", GetLastError());
        return;
    }
    FileWriteString(handle, content);
    FileClose(handle);
}

//+------------------------------------------------------------------+
//| Утилита: извлечь строку из JSON                                  |
//+------------------------------------------------------------------+
string ExtractJsonString(string json, string key)
{
    string search = "\"" + key + "\"";
    int pos = StringFind(json, search);
    if(pos < 0) return "";
    pos = StringFind(json, "\"", pos + StringLen(search) + 1);
    if(pos < 0) return "";
    int end = StringFind(json, "\"", pos + 1);
    if(end < 0) return "";
    return StringSubstr(json, pos + 1, end - pos - 1);
}

//+------------------------------------------------------------------+
//| Утилита: извлечь число из JSON                                   |
//+------------------------------------------------------------------+
double ExtractJsonDouble(string json, string key)
{
    string search = "\"" + key + "\"";
    int pos = StringFind(json, search);
    if(pos < 0) return 0.0;
    pos += StringLen(search);
    while(pos < StringLen(json) && (StringGetCharacter(json, pos) == ' ' || StringGetCharacter(json, pos) == ':'))
        pos++;
    if(pos >= StringLen(json)) return 0.0;
    string numStr = "";
    while(pos < StringLen(json))
    {
        ushort ch = StringGetCharacter(json, pos);
        if(ch == ',' || ch == '}' || ch == '\n' || ch == ' ') break;
        numStr += ShortToString(ch);
        pos++;
    }
    return StringToDouble(numStr);
}
//+------------------------------------------------------------------+
