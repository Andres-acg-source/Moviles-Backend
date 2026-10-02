import { Router } from 'express';
import { analyticsSummary } from '../analytics/index.js';
import { auth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';

export function analyticsRoutes() {
  const router = Router();
  router.get('/analytics/summary', auth, asyncRoute(async (_req, res) => res.json(await analyticsSummary())));
  return router;
}
