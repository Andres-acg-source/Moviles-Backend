import express, { Router } from 'express';
import { fileURLToPath } from 'node:url';

// Same relative path from src/routes (tsx) and dist/routes (compiled build).
const dashboardDir = fileURLToPath(new URL('../../public/dashboard/', import.meta.url));

/**
 * Analytics dashboard for the team. The page is static and has no data of its own: after the team signs in it
 * calls GET /api/v1/analytics/summary, so every chart comes from the same PostgreSQL database the apps use.
 */
export function dashboardRoutes() {
  const router = Router();
  router.use('/dashboard', express.static(dashboardDir, { index: 'index.html', maxAge: '5m' }));
  return router;
}
