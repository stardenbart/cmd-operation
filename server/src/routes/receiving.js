import { Router } from 'express';
import { z } from 'zod';
import * as receiving from '../services/receiving.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery, angkaDesimal, angkaDesimalOpsional, teksOpsional, waktu } from '../middleware/validasi.js';

const router = Router();

router.use(wajibLogin);

const skemaBuat = z.object({
  supplierId: z.coerce.number().int().positive(),
  qtyKg: angkaDesimal({ min: 0, maxDecimals: 2 }),
  beratJenis: angkaDesimal({ min: 0, maxDecimals: 4 }),
  nilaiTs: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  finishTime: waktu(),
  remarks: teksOpsional(),
});

const skemaKoreksi = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  qtyKg: angkaDesimal({ min: 0, maxDecimals: 2 }).optional(),
  beratJenis: angkaDesimal({ min: 0, maxDecimals: 4 }).optional(),
  nilaiTs: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  finishTime: waktu().optional(),
  remarks: teksOpsional(),
  alasan: z.string().min(3, 'alasan koreksi wajib diisi').max(1000),
});

const skemaDaftar = z.object({
  halaman: z.coerce.number().int().positive().default(1),
  perHalaman: z.coerce.number().int().positive().max(100).default(25),
  status: z.string().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  dariTanggal: z.coerce.date().optional(),
  sampaiTanggal: z.coerce.date().optional(),
});

/** Konteks form: buffer + kapasitas tersisa + daftar supplier aktif. */
router.get(
  '/form-context',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  asyncHandler(async (req, res) => {
    res.json(await receiving.konteksForm());
  }),
);

router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    res.json(await receiving.daftar(req.query));
  }),
);

router.get(
  '/:id',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await receiving.ambil(Number(req.params.id)) });
  }),
);

/** Turunan aktif — dipakai dialog peringatan dependensi (FR-17.1). */
router.get(
  '/:id/dependencies',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await receiving.dependensi(Number(req.params.id)) });
  }),
);

router.post(
  '/',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  validasiBody(skemaBuat),
  asyncHandler(async (req, res) => {
    const data = await receiving.buat(req.body, req.user, req.ip);
    res.status(201).json({ data });
  }),
);

router.post(
  '/:id/correct',
  // Wewenang minimum: menyunting record pending. Untuk record yang sudah
  // disetujui, lapis service menuntut peran SPV (BR-19).
  wajibWewenang(AKSI.TRANSAKSI_SUNTING_PENDING),
  validasiBody(skemaKoreksi),
  asyncHandler(async (req, res) => {
    const { alasan, ...perubahan } = req.body;
    const data = await receiving.koreksi(
      Number(req.params.id), perubahan, alasan, req.user, req.ip,
    );
    res.json({ data });
  }),
);

export default router;
