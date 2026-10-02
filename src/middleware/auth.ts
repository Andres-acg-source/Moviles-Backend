import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { jwtSecret } from '../config.js';
import { db } from '../db.js';

declare global {
  namespace Express {
    interface Request { userId?: string }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const signToken = (userId: string) => jwt.sign({ sub: userId }, jwtSecret(), { algorithm: 'HS256', expiresIn: '7d' });

async function resolveUser(header: string | undefined): Promise<'missing' | 'invalid' | 'deleted' | string> {
  if (!header) return 'missing';
  if (!header.startsWith('Bearer ')) return 'invalid';
  let subject: unknown;
  try {
    subject = (jwt.verify(header.slice(7).trim(), jwtSecret(), { algorithms: ['HS256'] }) as jwt.JwtPayload).sub;
  } catch {
    return 'invalid';
  }
  if (typeof subject !== 'string' || !UUID.test(subject)) return 'invalid';
  const { rowCount } = await db().query('SELECT 1 FROM users WHERE id = $1', [subject]);
  return rowCount ? subject : 'deleted';
}

const failures: Record<string, string> = { missing: 'AUTH_REQUIRED', invalid: 'INVALID_TOKEN', deleted: 'USER_NOT_FOUND' };

export function auth(req: Request, _res: Response, next: NextFunction) {
  resolveUser(req.headers.authorization).then(result => {
    if (failures[result]) return next(new Error(failures[result]));
    req.userId = result;
    next();
  }, next);
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  resolveUser(req.headers.authorization).then(result => {
    if (!failures[result]) req.userId = result;
    next();
  }, next);
}
