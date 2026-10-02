import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { auth, signToken } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';
import { login, profile, register } from '../services/auth.js';

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  email: z.string().trim().email(),
  password: z.string().min(6).max(128)
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(128)
});

export function authRoutes(limiter: RequestHandler) {
  const router = Router();
  router.post('/auth/register', limiter, asyncRoute(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const user = await register(body.email, body.password, body.name);
    res.status(201).json({ token: signToken(user.id), user });
  }));
  router.post('/auth/login', limiter, asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await login(body.email, body.password);
    res.json({ token: signToken(user.id), user });
  }));
  router.get('/auth/me', auth, asyncRoute(async (req, res) => res.json(await profile(req.userId!))));
  return router;
}
