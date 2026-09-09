import { Router } from 'express';
import { z } from 'zod';
import * as minta from '../services/permintaanKoreksi.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery, teksOpsional } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const MODUL = z.enum(['receiving', 'prepast', 'pengembalian', 'transfer', 'monitoring']);

const skemaAjukan = z.object({
  modul: MODUL,
  entityId: z.coerce.number().int().positive(),
  // Nilai yang diusulkan, dalam bentuk yang sama dengan payload koreksi.
  // Bentuknya bebas di sini karena tiap modul punya field berbeda; yang
  // memeriksa kesahihannya adalah lapis koreksi saat dijalankan.
  usulan: z.record(z.union([z.string(), z.number()])),
  alasan: z.string().min(3, 'alasan permintaan wajib diisi').max(1000),
});

const skemaTinjau = z.object({
  catatan: teksOpsional(1000),
});

const skemaTolak = z.object({
  catatan: z.string().min(3, 'alasan penolakan wajib diisi').max(1000),
});

const skemaDaftar = z.object({
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING'),
  ),
  modul: z.preprocess((v) => (v === '' ? undefined : v), MODUL.optional()),
});

/** Field yang dapat diusulkan, untuk membangun form permintaan. */
router.get(
  '/fields/:modul',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: minta.fieldTersedia(MODUL.parse(req.params.modul)) });
  }),
);

/** Daftar permintaan. Dapat dilihat semua peran; keputusan tetap milik SPV. */
router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    res.json(await minta.daftar(req.query));
  }),
);

/** Mengajukan. Wewenang Operator (BR-22): SPV mengoreksi langsung. */
router.post(
  '/',
  wajibWewenang(AKSI.KOREKSI_AJUKAN),
  validasiBody(skemaAjukan),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await minta.ajukan(req.body, req.user, req.ip) });
  }),
);

router.post(
  '/:id/approve',
  wajibWewenang(AKSI.KOREKSI_TINJAU),
  validasiBody(skemaTinjau),
  asyncHandler(async (req, res) => {
    res.json({
      data: await minta.setujui(Number(req.params.id), req.body.catatan, req.user, req.ip),
    });
  }),
);

router.post(
  '/:id/reject',
  wajibWewenang(AKSI.KOREKSI_TINJAU),
  validasiBody(skemaTolak),
  asyncHandler(async (req, res) => {
    res.json({
      data: await minta.tolak(Number(req.params.id), req.body.catatan, req.user, req.ip),
    });
  }),
);

export default router;
