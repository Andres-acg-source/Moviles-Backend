import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { simKey } from '../config.js';
import { db } from '../db.js';
import { asyncRoute } from '../middleware/http.js';
import type { OccupancySource } from '../simulation/occupancy-source.js';
import { clearScenarios, setScenario } from '../simulation/scenarios.js';

const scenarioSchema = z.object({
  level: z.string().min(1).max(10).optional(),
  occupancy: z.number().min(0).max(100),
  minutes: z.number().int().min(1).max(120).default(10)
});

function requireSimKey(req: Request, _res: Response, next: NextFunction) {
  const expected = simKey();
  if (!expected) return next(new Error('SIM_DISABLED'));
  const provided = Buffer.from(req.header('x-sim-key') ?? '');
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return next(new Error('SIM_FORBIDDEN'));
  next();
}

export function simRoutes(occupancy: OccupancySource) {
  const router = Router();
  router.post('/sim/scenario', requireSimKey, asyncRoute(async (req, res) => {
    const body = scenarioSchema.parse(req.body);
    if (body.level) {
      const { rowCount } = await db().query('SELECT 1 FROM levels WHERE code = $1', [body.level]);
      if (!rowCount) throw new Error('LEVEL_NOT_FOUND');
    }
    const until = setScenario(body.occupancy, body.minutes, body.level);
    await occupancy.tick({ force: true });
    res.json({ applied: true, until: until.toISOString() });
  }));
  router.post('/sim/reset', requireSimKey, asyncRoute(async (_req, res) => {
    clearScenarios();
    await occupancy.tick({ force: true });
    res.json({ reset: true });
  }));
  return router;
}
