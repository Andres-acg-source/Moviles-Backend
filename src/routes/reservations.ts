import { Router } from 'express';
import { z } from 'zod';
import { auth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';
import { activeReservation, checkIn, createReservation, myReservations, release, vehicle } from '../services/reservations.js';

const createSchema = z.object({ spotId: z.string().min(1).max(40) });

export function reservationRoutes() {
  const router = Router();
  router.post('/reservations', auth, asyncRoute(async (req, res) => {
    const body = createSchema.parse(req.body);
    res.status(201).json(await createReservation(req.userId!, body.spotId));
  }));
  router.get('/reservations/active', auth, asyncRoute(async (req, res) => res.json(await activeReservation(req.userId!))));
  router.get('/reservations/me', auth, asyncRoute(async (req, res) => res.json(await myReservations(req.userId!))));
  router.post('/reservations/:id/check-in', auth, asyncRoute(async (req, res) => res.json(await checkIn(req.userId!, String(req.params.id)))));
  router.post('/reservations/:id/release', auth, asyncRoute(async (req, res) => res.json(await release(req.userId!, String(req.params.id)))));
  router.get('/vehicle', auth, asyncRoute(async (req, res) => res.json(await vehicle(req.userId!))));
  return router;
}
