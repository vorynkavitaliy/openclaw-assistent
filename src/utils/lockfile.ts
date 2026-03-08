import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('lockfile');

interface LockData {
  pid: number;
  timestamp: number;
}

/**
 * Пытается захватить lock файл атомарно (O_EXCL).
 * Если файл уже существует и процесс жив — возвращает false.
 * Если процесс мёртв или файл старше maxAgeMs — удаляет и пробует снова.
 */
export function acquireLock(lockPath: string, maxAgeMs: number = 5 * 60 * 1000): boolean {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Попытка атомарного создания (O_CREAT | O_EXCL | O_WRONLY)
  const lockData = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
  try {
    fs.writeFileSync(lockPath, lockData, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  // Файл существует — проверяем stale
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockData;
    const ageMs = Date.now() - data.timestamp;

    if (ageMs < maxAgeMs) {
      try {
        process.kill(data.pid, 0);
        log.warn('Lock held by running process', { pid: data.pid, ageMs });
        return false;
      } catch {
        log.info('Stale lock (process dead), removing', { pid: data.pid });
      }
    } else {
      log.info('Stale lock (too old), removing', { ageMs, maxAgeMs });
    }
  } catch {
    log.info('Invalid lock file, removing');
  }

  // Удаляем stale lock и пробуем атомарно снова
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // другой процесс мог уже удалить
  }
  try {
    fs.writeFileSync(lockPath, lockData, { flag: 'wx' });
    return true;
  } catch {
    // другой процесс успел создать — проиграли гонку
    log.warn('Lock race lost — another process acquired lock');
    return false;
  }
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
