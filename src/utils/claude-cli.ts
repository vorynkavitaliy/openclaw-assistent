/**
 * Claude Code CLI wrapper — запускает claude в неинтерактивном режиме
 * через пользователя claudebot (не root).
 *
 * Возможности:
 * - Стриминг: промежуточные обновления в Telegram каждые 10 сек
 * - Сессия: --continue для сохранения контекста между вызовами
 * - Полный доступ: Read, Edit, Write, Bash, Grep, Glob
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from './logger.js';
import { sendTelegramWithId, editTelegramMessage } from './telegram.js';

const log = createLogger('claude-cli');

const MAX_OUTPUT_LENGTH = 4096; // Telegram message limit
const TIMEOUT_MS = 45 * 60 * 1000; // 45 минут
const STREAM_INTERVAL_MS = 10_000; // обновлять Telegram каждые 10 сек
const PROJECT_DIR = '/root/Projects/openclaw-assistent';

/** Экранирует строку для безопасной передачи в shell */
function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/** Обрезает текст до лимита Telegram */
function truncate(text: string, max: number = MAX_OUTPUT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 30) + '\n\n... (обрезано)';
}

// Флаг: есть ли активная сессия (для --continue)
let hasActiveSession = false;

/**
 * Запускает claude CLI с промптом от пользователя claudebot.
 * Стримит вывод в Telegram, поддерживает сессию между вызовами.
 */
export interface ClaudeCliOptions {
  /** Максимальная длина ответа. По умолчанию 4096 */
  maxOutput?: number;
  /** Таймаут в мс. По умолчанию 45 мин */
  timeoutMs?: number;
  /** Стримить в Telegram. По умолчанию true */
  stream?: boolean;
  /** Использовать --continue для сессии. По умолчанию true */
  useSession?: boolean;
}

export async function runClaudeCli(prompt: string, options?: ClaudeCliOptions): Promise<string> {
  const maxOutput = options?.maxOutput ?? MAX_OUTPUT_LENGTH;
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;
  const stream = options?.stream ?? true;
  const useSession = options?.useSession ?? true;

  const continueFlag = useSession && hasActiveSession ? '--continue' : '';
  const claudeCmd = [
    `cd ${PROJECT_DIR}`,
    `claude -p ${shellEscape(prompt)} --dangerously-skip-permissions --output-format text ${continueFlag}`.trim(),
  ].join(' && ');

  const fullPath =
    '/root/.nvm/versions/node/v22.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const args = [
    '-i',
    `HOME=/home/claudebot`,
    `PATH=${fullPath}`,
    'LANG=en_US.UTF-8',
    '/usr/sbin/runuser',
    '-u',
    'claudebot',
    '--',
    'bash',
    '-c',
    claudeCmd,
  ];

  log.info('Starting claude CLI', {
    promptLength: prompt.length,
    continue: hasActiveSession,
  });

  // Стриминг в Telegram (только если stream=true)
  const statusMsgId = stream ? await sendTelegramWithId('🧠 Claude Code думает...') : null;

  return new Promise((resolve) => {
    const proc: ChildProcess = spawn('env', args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let lastSentLength = 0;
    let streamTimer: ReturnType<typeof setInterval> | null = null;

    // Стриминг: обновляем сообщение в Telegram каждые 10 сек
    if (stream && statusMsgId) {
      streamTimer = setInterval(() => {
        if (stdout.length > lastSentLength && statusMsgId) {
          const preview = truncate(stdout, maxOutput);
          editTelegramMessage(statusMsgId, `🧠 Работаю...\n\n${preview}`).catch(() => {});
          lastSentLength = stdout.length;
        }
      }, STREAM_INTERVAL_MS);
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const killTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      resolve(`Таймаут: Claude Code не ответил за ${Math.round(timeoutMs / 60_000)} минут.`);
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(killTimer);
      if (streamTimer) clearInterval(streamTimer);
    }

    proc.on('close', (code) => {
      cleanup();

      if (code !== 0 && !stdout.trim()) {
        const errMsg = stderr.slice(0, 500) || `exit code ${code}`;
        log.error('Claude CLI failed', { code, stderr: errMsg });

        // Если --continue не сработал — сбрасываем сессию и пробуем заново
        if (
          hasActiveSession &&
          (errMsg.includes('No previous conversation') || errMsg.includes('session'))
        ) {
          hasActiveSession = false;
          log.info('Session expired, retrying without --continue');
          runClaudeCli(prompt, options).then(resolve, () =>
            resolve('Ошибка повторного запуска Claude Code'),
          );
          return;
        }

        if (statusMsgId) {
          editTelegramMessage(statusMsgId, `Ошибка Claude Code: ${errMsg}`).catch(() => {});
        }
        resolve(`Ошибка Claude Code: ${errMsg}`);
        return;
      }

      // Сессия успешна — запоминаем для --continue
      hasActiveSession = true;

      const result = truncate(stdout.trim(), maxOutput);

      log.info('Claude CLI completed', {
        code,
        outputLength: result.length,
      });

      // Финальное обновление стрим-сообщения
      if (statusMsgId) {
        editTelegramMessage(statusMsgId, result || 'Claude Code завершил работу.').catch(() => {});
      }

      resolve(result || 'Claude Code вернул пустой ответ.');
    });

    proc.on('error', (err) => {
      cleanup();
      log.error('Claude CLI spawn error', { error: err.message });
      resolve(`Ошибка запуска Claude Code: ${err.message}`);
    });
  });
}

/**
 * Сбрасывает сессию Claude Code (для /claude_reset).
 */
export function resetClaudeSession(): void {
  hasActiveSession = false;
  log.info('Claude session reset');
}

/**
 * Оценивает количество токенов по длине текста.
 * Грубая оценка: ~4 символа на токен (смесь English + русский + JSON).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
