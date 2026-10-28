import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { auth, signToken } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';
import { login, profile, register } from '../services/auth.js';

export const EMAIL_PROVIDERS = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'uniandes.edu.co'
];

const nameSchema = z.string().trim()
  .min(2, 'Name must have at least 2 characters')
  .max(30, 'Name can have up to 30 characters')
  .regex(/^\p{L}[\p{L} '.-]*$/u, 'Name can only contain letters, spaces, apostrophes, dots and hyphens')
  .refine(value => !/(\p{L})\1\1/iu.test(value.replace(/ /g, '')), 'Name cannot repeat the same letter three times in a row')
  .refine(value => !value.includes('  '), 'Name cannot contain double spaces');

const emailSchema = z.string().trim().toLowerCase()
  .max(100, 'Email can have up to 100 characters')
  .email()
  .refine(value => EMAIL_PROVIDERS.includes(value.split('@')[1] ?? ''), 'Use a real email provider');

const passwordSchema = z.string()
  .min(8, 'Password must have at least 8 characters')
  .max(64, 'Password can have up to 64 characters')
  .regex(/\p{Lu}/u, 'Password needs an uppercase letter')
  .regex(/\p{Ll}/u, 'Password needs a lowercase letter')
  .regex(/\p{N}/u, 'Password needs a number')
  .regex(/[^\p{L}\p{N}\s]/u, 'Password needs a symbol')
  .regex(/^\S+$/, 'Password cannot contain spaces');

const registerSchema = z.object({
  name: nameSchema.optional(),
  email: emailSchema,
  password: passwordSchema
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
