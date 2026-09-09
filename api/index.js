import pino from 'pino';
import { buatApp } from '../server/src/app.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

export default buatApp(logger);
