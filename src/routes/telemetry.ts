import { Router, type RequestHandler } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';
import { recordEvent, telemetrySchema } from '../services/telemetry.js';

export function telemetryRoutes(limiter: RequestHandler) {
  const router = Router();
  router.post('/telemetry', limiter, optionalAuth, asyncRoute(async (req, res) => {
    const body = telemetrySchema.parse(req.body);
    await recordEvent(req.userId, body.name, body.properties);
    res.status(202).json({ accepted: true });
  }));
  return router;
}
