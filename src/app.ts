import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { errorHandler, notFound, requestLogger } from './middleware/http.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { healthRoutes } from './routes/health.js';
import { predictionRoutes } from './routes/predictions.js';
import { reservationRoutes } from './routes/reservations.js';
import { simRoutes } from './routes/sim.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { StaticOccupancySource, type OccupancySource } from './simulation/occupancy-source.js';

export interface AppOptions {
  occupancy?: OccupancySource;
  authLimitPerMinute?: number;
  telemetryLimitPerMinute?: number;
}

const limiter = (limit: number) => rateLimit({
  windowMs: 60_000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  }
});

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(requestLogger);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use(healthRoutes());
  const api = express.Router();
  api.use(authRoutes(limiter(options.authLimitPerMinute ?? 10)));
  api.use(catalogRoutes());
  api.use(reservationRoutes());
  api.use(predictionRoutes());
  api.use(telemetryRoutes(limiter(options.telemetryLimitPerMinute ?? 120)));
  api.use(analyticsRoutes());
  api.use(simRoutes(options.occupancy ?? new StaticOccupancySource()));
  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
