import { Router } from 'express';
import { db } from '../db.js';

export function healthRoutes() {
  const router = Router();
  router.get('/health', async (_req, res) => {
    try {
      await db().query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'error', db: 'unavailable' });
    }
  });
  return router;
}
