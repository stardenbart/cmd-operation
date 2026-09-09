import pino from 'pino';
import { config } from './config.js';
import { buatApp } from './app.js';
import { tutupPool } from './db/pool.js';

const logger = pino({
  level: config.log.level,
  transport: config.isProd
    ? undefined
    : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});

const app = buatApp(logger);

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, env: config.env, tz: config.time.timezone },
    'CMD 1 Operation API berjalan',
  );
});

/** Mematikan server dengan rapi agar transaksi berjalan tidak terpotong. */
async function matikan(sinyal) {
  logger.info({ sinyal }, 'Mematikan server...');
  server.close(async () => {
    await tutupPool();
    logger.info('Selesai.');
    process.exit(0);
  });
  // Jaring pengaman bila ada koneksi yang menggantung
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => matikan('SIGTERM'));
process.on('SIGINT', () => matikan('SIGINT'));
