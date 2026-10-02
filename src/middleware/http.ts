import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { isTest } from '../config.js';
import { toHttpError } from '../errors.js';

export const asyncRoute = (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (isTest()) return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}

const statusOf = (err: unknown) => {
  const candidate = err as { status?: unknown; statusCode?: unknown };
  const status = Number(candidate?.status ?? candidate?.statusCode);
  return Number.isInteger(status) && status >= 400 && status < 600 ? status : undefined;
};

const statusMessages: Record<number, string> = { 400: 'Bad request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found', 413: 'Payload too large', 415: 'Unsupported media type', 429: 'Too many requests' };

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid request', details: err.flatten() });
  const type = (err as { type?: string })?.type;
  if (type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  if (type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  const known = err instanceof Error ? toHttpError(err.message) : undefined;
  if (known) return res.status(known[0]).json({ error: known[1] });
  const status = statusOf(err);
  if (status && status < 500) return res.status(status).json({ error: statusMessages[status] ?? 'Request error' });
  console.error(`[error] ${req.method} ${req.originalUrl.split('?')[0]}:`, err instanceof Error ? err.stack ?? err.message : String(err));
  res.status(status ?? 500).json({ error: 'Internal server error' });
}
