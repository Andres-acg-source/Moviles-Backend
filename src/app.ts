import 'dotenv/config';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthService, ParkingService } from './services.js';
import { IntelligenceService, LifecycleService } from './feature-services.js';
import { Store } from './store.js';
import { lotVm, reservationVm } from './view-models.js';

const secret = process.env.JWT_SECRET ?? 'development-secret';
const auth = (req: Request, res: Response, next: NextFunction) => { try { const token = req.headers.authorization?.replace('Bearer ', ''); if (!token) return res.status(401).json({ error: 'Authentication required' }); req.userId = (jwt.verify(token, secret) as { userId: string }).userId; next(); } catch { res.status(401).json({ error: 'Invalid token' }); } };
const asyncRoute = (handler: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req, res)).catch(next);
const errorText: Record<string, [number, string]> = { EMAIL_EXISTS: [409, 'Email already registered'], INVALID_CREDENTIALS: [401, 'Invalid credentials'], ACTIVE_RESERVATION_EXISTS: [409, 'An active reservation already exists'], SPOT_NOT_FOUND: [404, 'Parking spot not found'], SPOT_UNAVAILABLE: [409, 'Parking spot is not available'], RESERVATION_NOT_FOUND: [404, 'Reservation not found'], VEHICLE_NOT_FOUND: [404, 'No parked vehicle found'], PAYMENT_KEY_REQUIRED: [400, 'Idempotency-Key header is required'], USER_NOT_FOUND: [401, 'User no longer exists'] };

declare global { namespace Express { interface Request { userId?: string } } }

export async function createApp(file = process.env.DATA_FILE ?? './data/parkwise.json') {
  const store = await Store.open(file); const authService = new AuthService(store); const parking = new ParkingService(store); const intelligence = new IntelligenceService(store); const lifecycle = new LifecycleService(store); const app = express();
  app.use(helmet()); app.use(cors()); app.use(express.json());
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'parkwise-api' }));
  app.post('/api/v1/auth/register', asyncRoute(async (req, res) => { const body = z.object({ name: z.string().trim().min(1).max(80).optional(), email: z.string().trim().email(), password: z.string().min(6) }).parse(req.body); const user = await authService.register(body.email, body.password, body.name); res.status(201).json({ token: jwt.sign({ userId: user.id }, secret, { expiresIn: '7d' }), user: authService.profile(user.id) }); }));
  app.post('/api/v1/auth/login', asyncRoute((req, res) => { const body = z.object({ email: z.string().trim().email(), password: z.string() }).parse(req.body); const user = authService.login(body.email, body.password); res.json({ token: jwt.sign({ userId: user.id }, secret, { expiresIn: '7d' }), user: authService.profile(user.id) }); }));
  app.get('/api/v1/auth/me', auth, (req, res) => res.json(authService.profile(req.userId!)));
  app.get('/api/v1/lots', (_req, res) => res.json(parking.lots().map(lotVm)));
  app.get('/api/v1/lots/:lotId', (req, res) => { const lot = parking.lot(req.params.lotId); if (!lot) return res.status(404).json({ error: 'Parking lot not found' }); res.json(lotVm(lot)); });
  app.get('/api/v1/lots/:lotId/forecast', (req, res) => res.json(intelligence.forecast(String(req.params.lotId), typeof req.query.arrivalAt === 'string' ? req.query.arrivalAt : undefined)));
  app.get('/api/v1/spots/search', (req, res) => res.json(intelligence.search(typeof req.query.q === 'string' ? req.query.q : undefined, { available: req.query.available === 'true', accessible: req.query.accessible === 'true', ev: req.query.ev === 'true', vip: req.query.vip === 'true', lotId: typeof req.query.lotId === 'string' ? req.query.lotId : undefined })));
  app.get('/api/v1/nearby-lots', (_req, res) => res.json(intelligence.nearbyLots()));
  app.get('/api/v1/lots/:lotId/queue', (req, res) => res.json(intelligence.queue(String(req.params.lotId))));
  app.post('/api/v1/spots/:lotId/:spotId/report-stale', auth, asyncRoute(async (req, res) => res.json(await intelligence.reportStale(String(req.params.lotId), String(req.params.spotId)))));
  app.get('/api/v1/lots/:lotId/patterns', (req, res) => res.json({ lotId: String(req.params.lotId), dayOfWeek: req.query.dayOfWeek ?? new Date().getDay(), intervalMinutes: 15, points: intelligence.forecast(String(req.params.lotId)).levels }));
  app.post('/api/v1/departure-recommendation', auth, (req, res) => { const body = z.object({ lotId: z.string(), arrivalAt: z.string().datetime(), travelMinutes: z.number().int().min(1).max(240) }).parse(req.body); const forecast = intelligence.forecast(body.lotId, body.arrivalAt); const arrival = new Date(body.arrivalAt); const predicted = forecast.points.find(point => point.hour === arrival.getHours())?.occupancy ?? 1; const buffer = predicted >= 0.85 ? 20 : predicted >= 0.7 ? 10 : 5; res.json({ leaveAt: new Date(arrival.getTime() - (body.travelMinutes + buffer) * 60000).toISOString(), travelMinutes: body.travelMinutes, parkingBufferMinutes: buffer, predictedOccupancy: predicted, confidence: forecast.points.length ? 0.7 : 0 }); });
  app.get('/api/v1/reservations/active', auth, (req, res) => { const reservation = parking.activeReservation(req.userId!); res.json(reservation ? reservationVm(reservation) : null); });
  app.post('/api/v1/reservations', auth, asyncRoute(async (req, res) => { const body = z.object({ lotId: z.string(), spotId: z.string(), durationMinutes: z.number().int().min(15).max(720) }).parse(req.body); res.status(201).json(reservationVm(await parking.reserve(req.userId!, body.lotId, body.spotId, body.durationMinutes))); }));
  app.delete('/api/v1/reservations/:reservationId', auth, asyncRoute(async (req, res) => { await parking.cancel(req.userId!, String(req.params.reservationId)); res.status(204).send(); }));
  app.post('/api/v1/reservations/:reservationId/check-in', auth, asyncRoute(async (req, res) => { const result = await lifecycle.checkIn(req.userId!, String(req.params.reservationId)); res.json({ reservation: reservationVm(result.reservation), vehicle: result.vehicle }); }));
  app.post('/api/v1/check-out', auth, asyncRoute(async (req, res) => res.json(await lifecycle.checkOut(req.userId!))));
  app.get('/api/v1/vehicle', auth, (req, res) => res.json(parking.vehicle(req.userId!)));
  app.put('/api/v1/vehicle', auth, asyncRoute(async (req, res) => { const body = z.object({ lotId: z.string(), lotName: z.string(), levelName: z.string(), spotCode: z.string(), parkedAt: z.string().datetime().optional() }).parse(req.body); res.json(await parking.saveVehicle(req.userId!, { ...body, parkedAt: body.parkedAt ?? new Date().toISOString() })); }));
  app.delete('/api/v1/vehicle', auth, asyncRoute(async (req, res) => { await parking.clearVehicle(req.userId!); res.status(204).send(); }));
  app.get('/api/v1/permit', auth, (req, res) => res.json(lifecycle.permit(req.userId!)));
  app.put('/api/v1/permit', auth, asyncRoute(async (req, res) => { const body = z.object({ type: z.enum(['standard', 'accessible', 'ev']), expiresAt: z.string().datetime(), verified: z.boolean().default(false) }).parse(req.body); res.json(await lifecycle.savePermit({ userId: req.userId!, ...body })); }));
  app.post('/api/v1/payments', auth, asyncRoute(async (req, res) => { const key = req.header('Idempotency-Key'); if (!key) throw new Error('PAYMENT_KEY_REQUIRED'); const body = z.object({ amount: z.number().positive(), purpose: z.enum(['reservation', 'extension']), reservationId: z.string().optional() }).parse(req.body); res.status(201).json(await lifecycle.payment(req.userId!, body.amount, body.purpose, key, body.reservationId)); }));
  app.post('/api/v1/telemetry', asyncRoute(async (req, res) => { const body = z.object({ name: z.string().min(1).max(100), properties: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}) }).parse(req.body); await lifecycle.event(req.userId, body.name, body.properties); res.status(202).json({ accepted: true }); }));
  app.get('/api/v1/analytics/summary', auth, (_req, res) => res.json(lifecycle.analytics()));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: err.flatten() }); const key = err instanceof Error ? err.message : ''; const [status, message] = errorText[key] ?? [500, 'Internal server error']; res.status(status).json({ error: message }); });
  return app;
}