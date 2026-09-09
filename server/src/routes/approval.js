import { Router } from 'express';
import { z } from 'zod';
import * as approval from '../services/approval.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const MODUL = z.enum(['receiving', 'prepast', 'pengembalian', 'transfer', 'monitoring']);

const skemaAntrean = z.object({
  modul: z.preprocess((v) => (v === '' ? undefined : v), MODUL.optional()),
});

const skemaMassal = z.object({
  daftar: z.array(z.object({ modul: MODUL, id: z.coerce.number().int().positive() }))
    .min(1, 'pilih minimal satu record')
    .max(200),
});

const skemaTolak = z.object({
  alasan: z.string().min(3, 'alasan penolakan wajib diisi').max(1000),
});

/** Antrean terpadu lintas modul. Dapat melihat: semua peran. */
router.get(
  '/queue',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaAntrean),
  asyncHandler(async (req, res) => {
    res.json(await approval.antrean(req.query));
  }),
);

/** Pohon dependensi, untuk dialog peringatan sebelum reject atau void. */
router.get(
  '/:modul/:id/dependencies',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json(await approval.dependensi(req.params.modul, Number(req.params.id)));
  }),
);

/** Approve massal. SPV semata (BR-22). Satu transaksi (FR-16.2). */
router.post(
  '/bulk-approve',
  wajibWewenang(AKSI.APPROVAL_MASSAL),
  validasiBody(skemaMassal),
  asyncHandler(async (req, res) => {
    res.json({ data: await approval.setujuiMassal(req.body.daftar, req.user, req.ip) });
  }),
);

router.post(
  '/:modul/:id/approve',
  wajibWewenang(AKSI.APPROVAL_PUTUSKAN),
  asyncHandler(async (req, res) => {
    res.json({
      data: await approval.setujui(req.params.modul, Number(req.params.id), req.user, req.ip),
    });
  }),
);

/** Reject selalu satu per satu: penolakan menuntut alasan khusus (FR-16.4). */
router.post(
  '/:modul/:id/reject',
  wajibWewenang(AKSI.APPROVAL_PUTUSKAN),
  validasiBody(skemaTolak),
  asyncHandler(async (req, res) => {
    res.json({
      data: await approval.tolak(
        req.params.modul, Number(req.params.id), req.body.alasan, req.user, req.ip,
      ),
    });
  }),
);

export default router;
