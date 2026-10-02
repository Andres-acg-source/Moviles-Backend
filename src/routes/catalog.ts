import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';
import { buildings, DEFAULT_DESTINATION, levelSpots, levelSummary, nearbyLots } from '../services/catalog.js';
import { recordAvailabilityQuery } from '../services/unmet-demand.js';

const flag = (value: unknown) => value === 'true';

export function catalogRoutes() {
  const router = Router();
  router.get('/buildings', asyncRoute(async (_req, res) => res.json(await buildings())));
  router.get('/levels', optionalAuth, asyncRoute(async (req, res) => {
    const summary = await levelSummary();
    await recordAvailabilityQuery(req, summary.campusFull);
    res.json(summary);
  }));
  router.get('/levels/:code/spots', optionalAuth, asyncRoute(async (req, res) => {
    const destination = typeof req.query.destination === 'string' && req.query.destination ? req.query.destination : DEFAULT_DESTINATION;
    const filters = { available: flag(req.query.available), accessible: flag(req.query.accessible), ev: flag(req.query.ev), vip: flag(req.query.vip) };
    res.json(await levelSpots(String(req.params.code), destination, filters, req.userId));
  }));
  router.get('/nearby-lots', asyncRoute(async (_req, res) => res.json(await nearbyLots())));
  return router;
}
