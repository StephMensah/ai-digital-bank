import { Router } from 'express';
import { pool } from '../db/pool.js';
import { isConfigured } from '../config.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: 'v1', uptime: Math.round(process.uptime()) }));

healthRouter.get('/livez', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

healthRouter.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ready',
      integrations: {
        mambu: isConfigured.mambu(),
        mtn_momo: isConfigured.momo(),
        paystack: isConfigured.paystack(),
        identity: isConfigured.kyc(),
        python_models: isConfigured.python()
      }
    });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', reason: 'database unreachable' });
  }
});
