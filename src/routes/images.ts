import express, { Router } from 'express';
import { IMAGES_DIR, isImageFile } from '../services/lot-images.js';

export function imageRoutes(dir = IMAGES_DIR) {
  const router = Router();
  const files = express.static(dir, { index: false, maxAge: '30d' });
  router.use('/images', (req, res, next) => (isImageFile(req.path) ? files(req, res, next) : next()));
  return router;
}
