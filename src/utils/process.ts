import { createLogger } from './logger.js';

const log = createLogger('process');

type CleanupFn = () => void | Promise<void>;

export function runMain(main: () => Promise<void>, cleanup?: CleanupFn): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);

    const doCleanup = async () => {
      try {
        await cleanup?.();
      } catch (err) {
        log.error(`Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(0);
    };

    void doCleanup();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  main()
    .then(async () => {
      await cleanup?.();
    })
    .catch(async (err) => {
      log.error(`Critical error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await cleanup?.();
      } catch {
        /* best effort */
      }
      process.exit(1);
    });
}
