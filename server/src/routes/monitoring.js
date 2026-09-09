import { Router } from 'express';
import { z } from 'zod';
import * as monitoring from '../services/monitoring.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery, angkaDesimal, waktu } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

/** Satu baris hasil pengecekan dalam ronde. */
const skemaHasil = z.object({
  siloId: z.coerce.number().int().positive(),
  ph: angkaDesimal({ min: 0, maxDecimals: 2 }),
  temp: angkaDesimal({ min: -50, maxDecimals: 2 }),
});

const skemaRonde = z.object({
  // Satu waktu cek berlaku untuk seluruh baris (FR-30.1)
  timeCheck: waktu(),
  hasil: z.array(skemaHasil).min(1, 'isi minimal satu silo').max(20),
});

const skemaDaftar = z.object({
  halaman: z.coerce.number().int().positive().default(1),
  perHalaman: z.coerce.number().int().positive().max(100).default(25),
  siloId: z.coerce.number().int().positive().optional(),
  status: z.string().optional(),
});

router.get(
  '/round-context',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  asyncHandler(async (req, res) => {
    res.json({
      data: await monitoring.konteksRonde(),
      rentangPh: { min: monitoring.PH_MIN, maks: monitoring.PH_MAKS },
    });
  }),
);

router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    res.json(await monitoring.daftar(req.query));
  }),
);

/** Menyimpan satu ronde: N silo, satu transaksi. */
router.post(
  '/round',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  validasiBody(skemaRonde),
  asyncHandler(async (req, res) => {
    const data = await monitoring.simpanRonde(req.body, req.user, req.ip);
    res.status(201).json({ data });
  }),
);

export default router;
