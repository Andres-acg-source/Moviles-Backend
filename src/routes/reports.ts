import { Router } from 'express';
import { auth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/http.js';
import { createReport, myReports, reportPhoto, reportSchema } from '../services/reports.js';

export const REPORT_PHOTO_MAX_AGE = 14 * 86_400;

export function reportRoutes() {
  const router = Router();
  router.post('/reports', auth, asyncRoute(async (req, res) => {
    const { created, report } = await createReport(req.userId!, reportSchema.parse(req.body));
    res.status(created ? 201 : 200).json(report);
  }));
  router.get('/reports/mine', auth, asyncRoute(async (req, res) => res.json(await myReports(req.userId!))));
  router.get('/reports/:id/photo', auth, asyncRoute(async (req, res) => {
    const photo = await reportPhoto(req.userId!, String(req.params.id));
    res.set('Cache-Control', `private, max-age=${REPORT_PHOTO_MAX_AGE}`).type('image/jpeg').send(photo);
  }));
  return router;
}
