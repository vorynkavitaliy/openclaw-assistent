/**
 * Структурированное логирование.
 * Поддерживает уровни: debug, info, warn, error.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

/**
 * Установить минимальный уровень логирования.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Получить текущий уровень логирования.
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function formatTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function log(
  level: LogLevel,
  module: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;

  const color = LOG_COLORS[level];
  const timestamp = formatTimestamp();
  const levelStr = level.toUpperCase().padEnd(5);

  let line = `${color}${timestamp} [${levelStr}]${RESET} [${module}] ${message}`;

  if (data) {
    line += ` ${JSON.stringify(data)}`;
  }

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Создать логгер для модуля.
 */
export function createLogger(module: string): {
  debug: (message: string, data?: Record<string, unknown>) => void;
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
  error: (message: string, data?: Record<string, unknown>) => void;
} {
  return {
    debug: (message: string, data?: Record<string, unknown>) => log('debug', module, message, data),
    info: (message: string, data?: Record<string, unknown>) => log('info', module, message, data),
    warn: (message: string, data?: Record<string, unknown>) => log('warn', module, message, data),
    error: (message: string, data?: Record<string, unknown>) => log('error', module, message, data),
  };
}
