/**
 * Kelola tautan publik dashboard - hanya master:kelola.
 *
 * GET   status + token aktif (untuk menyusun tautan di klien)
 * POST  /putar  terbitkan token baru (nonaktifkan yang lama)
 * POST  /cabut  matikan seluruh tautan yang beredar
 */

import { Router } from 'express';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { tokenAktif, putarToken, cabutToken } from '../services/publicDashboard.js';

const router = Router();
router.use(wajibLogin);

router.get(
  '/',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    res.json({ token: await tokenAktif() });
  }),
);

router.post(
  '/putar',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    res.json({ token: await putarToken(req.user, req.ip) });
  }),
);

router.post(
  '/cabut',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    await cabutToken(req.user, req.ip);
    res.json({ token: null });
  }),
);

export default router;
