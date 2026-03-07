/**
 * Claude Code CLI wrapper — запускает claude в неинтерактивном режиме
 * через пользователя claudebot (не root).
 *
 * Возможности:
 * - Стриминг: stream-json события → обновления в Telegram каждые 3 сек
 * - Сессия: --continue для сохранения контекста между вызовами
 * - Показывает: текст ответа, вызовы инструментов, ошибки
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from './logger.js';
import { sendTelegramWithId, editTelegramMessage } from './telegram.js';

const log = createLogger('claude-cli');

const MAX_TG_LENGTH = 4096; // Telegram message limit
const TIMEOUT_MS = 45 * 60 * 1000; // 45 минут
const DEBOUNCE_MS = 3_000; // обновлять Telegram не чаще чем раз в 3 сек
const PROJECT_DIR = '/root/Projects/openclaw-assistent';
const NODE_PATH = '/root/.nvm/versions/node/v22.22.0/bin';
const FULL_PATH = `${NODE_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Экранирует строку для безопасной передачи в shell */
function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/** Обрезает текст до лимита Telegram */
function truncate(text: string, max: number = MAX_TG_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 30) + '\n\n... (обрезано)';
}

// Флаг: есть ли активная сессия (для --continue)
let hasActiveSession = false;

// ── Stream-JSON event types ──

interface StreamEvent {
  type: 'system' | 'assistant' | 'result';
  subtype?: string;
  // system.init
  session_id?: string;
  // assistant
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string; // tool_use name
      input?: Record<string, unknown>;
    }>;
  };
  // result
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  error?: string;
}

/** Форматирует текущее состояние для показа в Telegram */
function formatProgress(text: string, tools: string[], done: boolean): string {
  const parts: string[] = [];

  if (tools.length > 0) {
    parts.push(`🔧 ${tools.join(' → ')}`);
  }

  if (text) {
    parts.push(text);
  }

  if (!done && !text && tools.length === 0) {
    return '🧠 Claude Code думает...';
  }

  return parts.join('\n\n') || (done ? 'Claude Code завершил работу.' : '🧠 Думаю...');
}

export interface ClaudeCliOptions {
  maxOutput?: number;
  timeoutMs?: number;
  stream?: boolean;
  useSession?: boolean;
}

export async function runClaudeCli(prompt: string, options?: ClaudeCliOptions): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;
  const stream = options?.stream ?? true;
  const useSession = options?.useSession ?? true;

  const continueFlag = useSession && hasActiveSession ? '--continue' : '';
  const claudeCmd = [
    `cd ${PROJECT_DIR}`,
    [
      'claude -p',
      shellEscape(prompt),
      '--dangerously-skip-permissions',
      '--output-format stream-json',
      '--verbose',
      '--model sonnet',
      continueFlag,
    ]
      .filter(Boolean)
      .join(' '),
  ].join(' && ');

  // Убираем CLAUDECODE (nested session) и ANTHROPIC_API_KEY (используем OAuth)
  const EXCLUDE_ENV = new Set(['CLAUDECODE', 'ANTHROPIC_API_KEY']);
  const envVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!EXCLUDE_ENV.has(k) && v !== undefined) {
      envVars[k] = v;
    }
  }

  const args = [
    '-i',
    `HOME=/home/claudebot`,
    `PATH=${FULL_PATH}`,
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

  const statusMsgId = stream ? await sendTelegramWithId('🧠 Claude Code думает...') : null;

  return new Promise((resolve) => {
    const proc: ChildProcess = spawn('env', args, {
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envVars,
    });

    let fullText = ''; // Накопленный текст ответа
    const toolsCalled: string[] = []; // Список вызванных инструментов
    let lastEditAt = 0;
    let editPending = false;
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    let isError = false;
    let errorMsg = '';
    let lineBuf = ''; // Буфер для парсинга строк

    function scheduleEdit(): void {
      if (!stream || !statusMsgId) return;
      const now = Date.now();
      const elapsed = now - lastEditAt;

      if (elapsed >= DEBOUNCE_MS && !editPending) {
        doEdit();
      } else if (!editTimer) {
        editPending = true;
        editTimer = setTimeout(() => {
          editTimer = null;
          editPending = false;
          doEdit();
        }, DEBOUNCE_MS - elapsed);
      }
    }

    function doEdit(): void {
      lastEditAt = Date.now();
      if (!statusMsgId) return;
      const display = truncate(formatProgress(fullText, toolsCalled, false));
      editTelegramMessage(statusMsgId, display).catch(() => {});
    }

    function processLine(line: string): void {
      if (!line.trim()) return;
      let event: StreamEvent;
      try {
        event = JSON.parse(line) as StreamEvent;
      } catch {
        return; // не JSON — пропускаем
      }

      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            fullText = block.text;
            scheduleEdit();
          } else if (block.type === 'tool_use' && block.name) {
            const toolLabel = formatToolLabel(block.name, block.input);
            if (!toolsCalled.includes(toolLabel)) {
              toolsCalled.push(toolLabel);
              if (toolsCalled.length > 5) toolsCalled.shift();
              scheduleEdit();
            }
          }
        }
      }

      if (event.type === 'result') {
        if (event.is_error || event.error) {
          isError = true;
          errorMsg = event.result ?? event.error ?? 'Unknown error';
        } else if (event.result) {
          fullText = event.result;
        }
        log.info('Claude CLI result', {
          isError,
          durationMs: event.duration_ms,
          costUsd: event.total_cost_usd,
        });
      }
    }

    function formatToolLabel(name: string, input?: Record<string, unknown>): string {
      switch (name) {
        case 'Read':
          return `Read(${shortPath(input?.['file_path'])})`;
        case 'Edit':
        case 'Write':
          return `${name}(${shortPath(input?.['file_path'])})`;
        case 'Bash':
          return `Bash(${shortCmd(input?.['command'])})`;
        case 'Glob':
          return `Glob(${shortPath(input?.['pattern'])})`;
        case 'Grep':
          return `Grep(${shortPath(input?.['pattern'])})`;
        default:
          return name;
      }
    }

    function shortPath(p: unknown): string {
      if (typeof p !== 'string') return '...';
      return p.replace(PROJECT_DIR + '/', '').slice(0, 40);
    }

    function shortCmd(cmd: unknown): string {
      if (typeof cmd !== 'string') return '...';
      return cmd.slice(0, 30).replace(/\n/g, ' ');
    }

    proc.stdout?.on('data', (data: Buffer) => {
      lineBuf += data.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      // stderr тоже может содержать stream-json события
      const text = data.toString();
      const lines = text.split('\n');
      for (const line of lines) {
        processLine(line);
      }
    });

    const killTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      cleanup();
      const msg = `Таймаут: Claude Code не ответил за ${Math.round(timeoutMs / 60_000)} минут.`;
      if (statusMsgId) editTelegramMessage(statusMsgId, msg).catch(() => {});
      resolve(msg);
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(killTimer);
      if (editTimer) clearTimeout(editTimer);
    }

    proc.on('close', (code) => {
      cleanup();
      // Обработать остаток буфера
      if (lineBuf.trim()) processLine(lineBuf);

      // Проверить ошибку аутентификации
      if (isError && errorMsg.includes('expired')) {
        log.error('Claude auth expired', { error: errorMsg.slice(0, 200) });
        const msg =
          '⚠️ Токен Claude Code истёк. Нужна переавторизация:\nrunuser -u claudebot -- claude auth login';
        if (statusMsgId) editTelegramMessage(statusMsgId, msg).catch(() => {});
        resolve(msg);
        return;
      }

      // Если --continue не сработал — сбрасываем сессию и пробуем заново
      if (
        hasActiveSession &&
        code !== 0 &&
        (errorMsg.includes('No previous conversation') || errorMsg.includes('session'))
      ) {
        hasActiveSession = false;
        log.info('Session expired, retrying without --continue');
        runClaudeCli(prompt, options).then(resolve, () =>
          resolve('Ошибка повторного запуска Claude Code'),
        );
        return;
      }

      if (isError || (code !== 0 && !fullText.trim())) {
        const errDisplay = errorMsg.slice(0, 500) || `exit code ${code}`;
        log.error('Claude CLI failed', { code, error: errDisplay });
        const msg = `⚠️ Ошибка Claude Code:\n${errDisplay}`;
        if (statusMsgId) editTelegramMessage(statusMsgId, msg).catch(() => {});
        resolve(msg);
        return;
      }

      // Успех
      hasActiveSession = true;
      const result = truncate(fullText.trim());
      log.info('Claude CLI completed', { code, outputLength: result.length });

      if (statusMsgId) {
        const final = result || 'Claude Code завершил работу.';
        editTelegramMessage(statusMsgId, final).catch(() => {});
      }
      resolve(result || 'Claude Code вернул пустой ответ.');
    });

    proc.on('error', (err) => {
      cleanup();
      log.error('Claude CLI spawn error', { error: err.message });
      const msg = `⚠️ Ошибка запуска: ${err.message}`;
      if (statusMsgId) editTelegramMessage(statusMsgId, msg).catch(() => {});
      resolve(msg);
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
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
