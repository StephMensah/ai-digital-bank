import { Router } from 'express';
import { pool } from '../db/pool.js';
import { config, isConfigured } from '../config.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: 'v1', uptime: Math.round(process.uptime()) }));

/**
 * What this deployment has switched on. The front ends read this at boot so a
 * flagged feature is absent from the screen, not merely refused when tapped.
 * Public and deliberately thin: flag names only, no configuration, no secrets.
 */
healthRouter.get('/config', (_req, res) =>
  res.json({ features: config.features }));

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
