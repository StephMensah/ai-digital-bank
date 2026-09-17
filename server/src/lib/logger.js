import pino from 'pino';
import { config } from '../config.js';

const redact = [
  'req.headers.authorization', 'req.headers.cookie', 'req.headers.apikey',
  '*.password', '*.pin', '*.password_hash', '*.pin_hash',
  '*.secretKey', '*.apiKey', '*.card', '*.cvv', '*.otp'
];

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.env === 'production' ? 'info' : 'debug'),
  redact: { paths: redact, censor: '[redacted]' },
  base: { service: 'ai-digital-bank' }
});
