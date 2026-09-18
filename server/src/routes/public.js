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
import { verifikasiTokenHarian, riwayatApprovalHarian } from '../services/approvalShare.js';

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

/**
 * Dituju QR sel "Diperiksa Oleh" di Halaman 2 form GMP - lihat
 * services/approvalShare.js. Berbasis TANGGAL, bukan id record tunggal:
 * satu tanda tangan di form itu mewakili seluruh Monitoring+Transfer hari
 * itu, bukan satu baris tertentu.
 */
router.get(
  '/approval-harian/:tanggal/:token',
  asyncHandler(async (req, res) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.tanggal)) {
      throw new ForbiddenError('Tautan tidak berlaku.');
    }
    if (!verifikasiTokenHarian(req.params.tanggal, req.params.token)) {
      throw new ForbiddenError('Tautan tidak berlaku.');
    }
    res.json({ data: await riwayatApprovalHarian(req.params.tanggal) });
  }),
);

export default router;
