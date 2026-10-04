import { createApp } from './app';
import { loadConfig } from './config';
import { Logger } from './logger';

const logger = new Logger('Bootstrap');

/** `node dist/main.js -healthcheck` probes the running server (used by container health checks that have no wget). */
async function healthcheck(port: string): Promise<never> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    process.exit(res.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  if (process.argv.includes('-healthcheck')) await healthcheck(process.env['PORT'] ?? '3333');
  // Fails fast with a readable list when required settings are missing (never starts half-configured).
  const config = loadConfig();
  const app = createApp(config);
  await app.listen();
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    app.close().then(
      () => process.exit(0),
      (error) => {
        logger.error(`shutdown failed: ${(error as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
