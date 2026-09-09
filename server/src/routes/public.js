/**
 * Endpoint PUBLIK - tanpa login.
 *
 * Sengaja TIDAK memakai wajibLogin. Gerbangnya token rahasia dashboard. Yang
 * disajikan hanya agregat baca-saja; tidak ada identitas maupun operasi tulis.
 * Rate limit umum `/api` tetap berlaku (dipasang di app.js).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ForbiddenError } from '../middleware/errors.js';
import { validasiQuery } from '../middleware/validasi.js';
import { dataPublik, verifikasiToken } from '../services/publicDashboard.js';

const router = Router();

const skemaToken = z.object({ t: z.string().min(1, 'Token wajib') });

router.get(
  '/dashboard',
  validasiQuery(skemaToken),
  asyncHandler(async (req, res) => {
    if (!(await verifikasiToken(req.query.t))) {
      throw new ForbiddenError('Tautan tidak berlaku atau telah dicabut.');
    }
    res.json({ data: await dataPublik() });
  }),
);

export default router;
