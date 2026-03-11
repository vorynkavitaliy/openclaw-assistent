/**
 * Claude Code CLI wrapper — запускает claude в неинтерактивном режиме
 * через пользователя claudebot (не root).
 *
 * Возможности:
 * - Стриминг: stream-json события → обновления в Telegram каждые 3 сек
 * - Сессия: --continue для сохранения контекста между вызовами
 * - Показывает: текст ответа, вызовы инструментов, ошибки
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createLogger } from './logger.js';
import { sendTelegram, sendTelegramWithId, editTelegramMessage } from './telegram.js';

const log = createLogger('claude-cli');

const MAX_TG_LENGTH = 4096; // Telegram message limit
const TIMEOUT_MS = 45 * 60 * 1000; // 45 минут
const DEBOUNCE_MS = 3_000; // обновлять Telegram не чаще чем раз в 3 сек
const PROJECT_DIR = '/root/Projects/openclaw-assistent';
const NODE_PATH = '/root/.nvm/versions/node/v22.22.0/bin';
const FULL_PATH = `${NODE_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

// Разрешённые инструменты (read-only: без Edit, Write, NotebookEdit)
const ALLOWED_TOOLS = 'Bash,Read,Glob,Grep,WebFetch,WebSearch';

// Системный промпт для бота — Claude как read-only ассистент
const BOT_SYSTEM_PROMPT = `Ты — ассистент крипто-трейдера на PROP FIRM (HyroTrader $10k аккаунт). Отвечай на русском, кратко и по делу.

ТВОЯ СИСТЕМА МОТИВАЦИИ (XP):
У торгового бота есть геймификация — система очков XP за качество сделок:
- 🌱 Новичок (0 XP) → 📈 Трейдер (25 XP) → ⭐ Мастер (60 XP) → 👑 Легенда (100 XP)
- Прибыльная сделка: +10 XP за $10 | Целевой профит ($8-20): +5 бонус
- Win streak: +5 за серию | SL дисциплина: +3 | Крупный убыток >$30: -10 штраф
- Дневная цель: +$45 (5 сделок × $9). Достижение цели: +25 XP бонус!
- XP и уровень хранятся в data/state.json (поле daily.xp, daily.xpHistory)

ФИЛЬТРЫ КАЧЕСТВА:
- Торговля только 05:00-21:00 UTC (блок Asia dead zone 21-05 UTC)
- Максимум 6 сделок в день (качество > количество)
- Минимальная уверенность 45% (отсекает мусорные сигналы)
- Cooldown 4ч между сделками на одну пару

ДОСТУПНЫЕ КОМАНДЫ (bash скрипты):
1. bash scripts/crypto_report_full.sh — полный отчёт (баланс, позиции, P&L, сигналы)
2. bash scripts/crypto_market_summary.sh — рыночные сигналы и confluence scores
3. npx tsx src/trading/crypto/report.ts --format text --no-send — отчёт без отправки в TG
4. npx tsx src/trading/crypto/journal-cli.ts --summary — дневник решений (сводка)
5. npx tsx src/trading/crypto/journal-cli.ts --last — последнее решение
6. cat data/state.json — текущее состояние (баланс, позиции, daily stats, XP)
7. cat data/health.json — healthcheck последнего цикла
8. tail -50 data/monitor.log — последние логи мониторинга
9. tail -20 data/sl-guard.log — логи SL-guard
10. bash scripts/trading_control.sh status — статус cron трейдеров
11. bash scripts/trading_control.sh start crypto-trader — запустить крипто cron
12. bash scripts/trading_control.sh stop crypto-trader — остановить крипто cron

СТРОГИЕ ПРАВИЛА:
- НИКОГДА не запускай monitor.ts напрямую (npm run trade:crypto:monitor) — он запускается по cron
- НИКОГДА не редактируй файлы (ты не разработчик, у тебя нет Edit/Write)
- НИКОГДА не делай git commit/push
- НИКОГДА не запускай killswitch.ts — для этого есть /stop_kill
- Запускай ТОЛЬКО скрипты из списка выше
- Для ответа используй данные из скриптов, форматируй красиво для Telegram
- Если пользователь просит новости, аналитику рынка или информацию из интернета — используй WebSearch/WebFetch
- Если пользователь просит что-то за пределами твоих возможностей — скажи что это нужно делать через Claude Code напрямую`;

const ROOT_CREDS = '/root/.claude/.credentials.json';
const BOT_CREDS = '/home/claudebot/.claude/.credentials.json';

/** Проверяет не протух ли токен, пытается обновить через `claude auth status` */
function refreshTokenIfNeeded(): void {
  try {
    if (!existsSync(ROOT_CREDS)) return;
    const creds = JSON.parse(readFileSync(ROOT_CREDS, 'utf-8')) as Record<string, unknown>;
    const oauth = creds?.claudeAiOauth as Record<string, unknown> | undefined;
    const expiresAt = oauth?.expiresAt as number | undefined;
    if (!expiresAt) return;

    const msUntilExpiry = expiresAt - Date.now();
    const REFRESH_THRESHOLD_MS = 30 * 60_000; // 30 минут до истечения

    if (msUntilExpiry > REFRESH_THRESHOLD_MS) return; // Токен ещё свежий

    log.info('Token expiring soon, refreshing', {
      expiresIn: `${Math.round(msUntilExpiry / 60_000)}min`,
    });

    // `claude auth status` обновляет токен через refresh token
    const result = spawnSync(
      '/usr/sbin/runuser',
      ['-u', 'claudebot', '--', 'bash', '-c', 'HOME=/home/claudebot claude auth status'],
      { timeout: 15_000, stdio: 'pipe', env: { HOME: '/home/claudebot', PATH: FULL_PATH } },
    );

    if (result.status === 0) {
      // Копируем обновлённый токен от claudebot обратно к root
      if (existsSync(BOT_CREDS)) {
        copyFileSync(BOT_CREDS, ROOT_CREDS);
        log.info('Token refreshed successfully');
        sendTelegram('🔑 Claude OAuth токен обновлён. Бот работает в штатном режиме.').catch(
          () => {},
        );
      }
    } else {
      log.warn('Token refresh failed', { stderr: result.stderr?.toString().slice(0, 200) });
      sendTelegram('⚠️ Claude OAuth токен НЕ удалось обновить. Требуется ручной вход.').catch(
        () => {},
      );
    }
  } catch (err) {
    log.warn('Token refresh check failed', { error: (err as Error).message });
  }
}

/** Синхронизирует OAuth credentials root → claudebot перед каждым вызовом (только от root) */
function syncCredentials(): void {
  try {
    if (process.getuid?.() !== 0) return; // только root может копировать
    refreshTokenIfNeeded();
    if (!existsSync(ROOT_CREDS)) return;
    copyFileSync(ROOT_CREDS, BOT_CREDS);
    spawnSync('chown', ['claudebot:claudebot', BOT_CREDS], { stdio: 'ignore' });
  } catch (err) {
    log.warn('Failed to sync credentials', { error: (err as Error).message });
  }
}

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
  systemPrompt?: string; // Кастомный system prompt (по умолчанию BOT_SYSTEM_PROMPT)
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
      '--model claude-opus-4-6',
      '--max-budget-usd 0.50',
      `--tools ${ALLOWED_TOOLS}`,
      continueFlag
        ? continueFlag
        : `--system-prompt ${shellEscape(options?.systemPrompt ?? BOT_SYSTEM_PROMPT)}`,
    ]
      .filter(Boolean)
      .join(' '),
  ].join(' && ');

  // Чистое окружение — без CLAUDECODE и ANTHROPIC_API_KEY (используем OAuth)
  const childEnv: Record<string, string> = {
    HOME: '/home/claudebot',
    PATH: FULL_PATH,
    LANG: 'en_US.UTF-8',
  };

  syncCredentials();

  const isClaudebot = process.getuid?.() !== 0;

  log.info('Starting claude CLI', {
    promptLength: prompt.length,
    continue: hasActiveSession,
    runAs: isClaudebot ? 'direct' : 'runuser',
  });

  const statusMsgId = stream ? await sendTelegramWithId('🧠 Claude Code думает...') : null;

  return new Promise((resolve, reject) => {
    // Если уже claudebot — запускаем напрямую, иначе через runuser
    const proc: ChildProcess = isClaudebot
      ? spawn('bash', ['-c', claudeCmd], {
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
        })
      : spawn('/usr/sbin/runuser', ['-u', 'claudebot', '--', 'bash', '-c', claudeCmd], {
          timeout: timeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv,
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

    let stderrBuf = '';
    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderrBuf += text;
      // stderr тоже может содержать stream-json события
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
      reject(new Error(msg));
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
        const errDisplay = errorMsg.slice(0, 500) || stderrBuf.slice(0, 500) || `exit code ${code}`;
        log.error('Claude CLI failed', {
          code,
          error: errDisplay,
          stderr: stderrBuf.slice(0, 300),
        });
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
