/**
 * Claude Code CLI wrapper — запускает claude в неинтерактивном режиме
 * через пользователя claudebot (не root, т.к. --dangerously-skip-permissions запрещён под root).
 *
 * Используется из Telegram бота для команды /claude.
 */

import { spawn } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('claude-cli');

const MAX_OUTPUT_LENGTH = 4000; // Telegram message limit
const TIMEOUT_MS = 300_000; // 5 минут максимум

/** Экранирует строку для безопасной передачи в shell */
function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Запускает claude CLI с промптом от пользователя claudebot.
 * Полный доступ: Read, Edit, Write, Bash, Grep, Glob — может менять код, билдить, перезапускать.
 */
export async function runClaudeCli(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Запускаем через su claudebot (без "-" чтобы не менять HOME),
    // т.к. root не может использовать --dangerously-skip-permissions.
    // cd в проект + явный HOME для Claude credentials.
    const projectDir = '/root/Projects/openclaw-assistent';
    const claudeCmd = `cd ${projectDir} && claude -p ${shellEscape(prompt)} --dangerously-skip-permissions --output-format text`;

    // env -i очищает ВСЕ переменные (включая CLAUDECODE), затем runuser запускает от claudebot
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

    log.info('Starting claude CLI via claudebot', { promptLength: prompt.length });

    const proc = spawn('env', args, {
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve('Таймаут: Claude Code не ответил за 5 минут.');
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code !== 0 && !stdout.trim()) {
        const errMsg = stderr.slice(0, 500) || `exit code ${code}`;
        log.error('Claude CLI failed', { code, stderr: errMsg });
        resolve(`Ошибка Claude Code: ${errMsg}`);
        return;
      }

      let result = stdout.trim();

      // Обрезаем если слишком длинный для Telegram
      if (result.length > MAX_OUTPUT_LENGTH) {
        result = result.slice(0, MAX_OUTPUT_LENGTH - 50) + '\n\n... (обрезано)';
      }

      log.info('Claude CLI completed', {
        code,
        outputLength: result.length,
      });

      resolve(result || 'Claude Code вернул пустой ответ.');
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      log.error('Claude CLI spawn error', { error: err.message });
      resolve(`Ошибка запуска Claude Code: ${err.message}`);
    });
  });
}
