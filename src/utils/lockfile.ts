import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('lockfile');

interface LockData {
  pid: number;
  timestamp: number;
}

/**
 * Пытается захватить lock файл. Возвращает true если удалось.
 * Если файл уже существует и моложе maxAgeMs — возвращает false (другой процесс работает).
 * Если файл старше maxAgeMs — считает его stale и перезаписывает.
 */
export function acquireLock(lockPath: string, maxAgeMs: number = 5 * 60 * 1000): boolean {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(lockPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockData;
      const ageMs = Date.now() - data.timestamp;

      if (ageMs < maxAgeMs) {
        // Проверяем жив ли процесс
        try {
          process.kill(data.pid, 0); // signal 0 = проверка существования
          log.warn('Lock held by running process', { pid: data.pid, ageMs });
          return false;
        } catch {
          // Процесс мёртв — stale lock
          log.info('Stale lock (process dead), overwriting', { pid: data.pid });
        }
      } else {
        log.info('Stale lock (too old), overwriting', { ageMs, maxAgeMs });
      }
    } catch {
      // Невалидный файл — перезаписать
    }
  }

  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), 'utf8');
  return true;
}

export function releaseLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      // Удаляем только если это НАШ lock
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockData;
      if (data.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // best effort
  }
}
