/**
 * Утилиты для работы со временем в часовом поясе Киева (Europe/Kyiv).
 */

/** Форматирует дату в Киевское время: "HH:mm" */
export function formatKyivTime(date: Date = new Date()): string {
  return date.toLocaleTimeString('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Возвращает час по Киеву (0-23) */
export function getKyivHour(date: Date = new Date()): number {
  const kyivStr = date.toLocaleString('en-US', {
    timeZone: 'Europe/Kyiv',
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(kyivStr, 10);
}

/** Форматирует дату в Киевское время: "YYYY-MM-DD HH:mm Kyiv" */
export function formatKyivDateTime(date: Date = new Date()): string {
  return (
    date
      .toLocaleString('uk-UA', {
        timeZone: 'Europe/Kyiv',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
      .replace(',', '') + ' Kyiv'
  );
}
