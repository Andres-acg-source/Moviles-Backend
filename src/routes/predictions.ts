import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';
import { leadTime } from '../services/lead-time.js';
import { predictions, recommendLevel } from '../services/predictions.js';

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export function predictionRoutes() {
  const router = Router();
  router.get('/predictions', asyncRoute(async (req, res) => res.json(await predictions(text(req.query.date), text(req.query.level)))));
  router.get('/recommendations/level', asyncRoute(async (req, res) => res.json(await recommendLevel(text(req.query.arrivalAt)))));
  router.get('/recommendations/lead-time', auth, asyncRoute(async (req, res) => res.json(await leadTime(req.userId!))));
  return router;
}
