import { Router } from 'express';
import { z } from 'zod';
import * as prepast from '../services/prepast.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery, angkaDesimalOpsional, teksOpsional, waktu } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const idSiloOpsional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

/** Satu baris silo tujuan beserta volumenya (FR-29.1). */
const skemaPecahan = z.object({
  siloId: idSiloOpsional,
  volumeLtr: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
});

const skemaBuat = z.object({
  receivingId: z.coerce.number().int().positive(),
  // Beberapa silo dalam satu kali kirim — inti FR-29
  pecahan: z.array(skemaPecahan).min(1, 'isi minimal satu baris Prepast').max(9),
  // Variabel proses diisi SATU KALI, berlaku untuk seluruh baris (FR-29.2)
  prepastStart: waktu(),
  prepastFinish: waktu().optional(),
  // Batas max mengikuti kolom database: flowrate_pst DECIMAL(8,2),
  // temp_after_heater & temp_output_prd DECIMAL(6,2).
  flowrate: angkaDesimalOpsional({ min: 0, max: 999999.99, maxDecimals: 2, inclusive: true }),
  tempAfterHeater: angkaDesimalOpsional({ min: 0, max: 9999.99, maxDecimals: 2, inclusive: true }),
  tempOutput: angkaDesimalOpsional({ min: 0, max: 9999.99, maxDecimals: 2, inclusive: true }),
  remarks: teksOpsional(),
  konfirmasiRollover: z.coerce.boolean().default(false),
  konfirmasiOprp: z.coerce.boolean().default(false),
  kontinu: z.coerce.boolean().default(false),
  continuityPreviousId: z.coerce.number().int().positive().optional(),
});

const skemaLengkapi = z.object({
  siloId: idSiloOpsional,
  volumeLtr: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  // Silo tambahan yang dibuat sebagai record BARU sekaligus dengan
  // pelengkapan ini — pecahan batch yang sama ke beberapa silo tujuan,
  // ditemukan operator belakangan, bukan saat pengisian awal.
  pecahanTambahan: z.array(skemaPecahan).max(8).optional(),
  prepastStart: waktu().optional(),
  prepastFinish: waktu().optional(),
  // Batas max mengikuti kolom database: flowrate_pst DECIMAL(8,2),
  // temp_after_heater & temp_output_prd DECIMAL(6,2).
  flowrate: angkaDesimalOpsional({ min: 0, max: 999999.99, maxDecimals: 2, inclusive: true }),
  tempAfterHeater: angkaDesimalOpsional({ min: 0, max: 9999.99, maxDecimals: 2, inclusive: true }),
  tempOutput: angkaDesimalOpsional({ min: 0, max: 9999.99, maxDecimals: 2, inclusive: true }),
  konfirmasiRollover: z.coerce.boolean().default(false),
  konfirmasiOprp: z.coerce.boolean().default(false),
  kontinu: z.coerce.boolean().optional(),
  continuityPreviousId: z.coerce.number().int().positive().optional(),
}).refine(
  (nilai) => ['siloId', 'volumeLtr', 'prepastStart', 'prepastFinish', 'flowrate', 'tempAfterHeater', 'tempOutput']
    .some((key) => nilai[key] !== undefined)
    || (nilai.pecahanTambahan?.length ?? 0) > 0,
  { message: 'isi minimal satu field Prepast yang akan dilengkapi' },
);

const skemaDaftar = z.object({
  halaman: z.coerce.number().int().positive().default(1),
  perHalaman: z.coerce.number().int().positive().max(100).default(25),
  status: z.string().optional(),
  siloId: z.coerce.number().int().positive().optional(),
  draftSaja: z.coerce.boolean().optional(),
});

/** Antrean buffer siap prepast, urut FIFO (FR-5.1). */
router.get(
  ['/continuity', '/continuity/:siloId'],
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await prepast.konteksKontinuitas() });
  }),
);

router.get(
  '/buffer-queue',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await prepast.antreanBuffer() });
  }),
);

router.get(
  '/form-context/:receivingId',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  asyncHandler(async (req, res) => {
    res.json(await prepast.konteksForm(Number(req.params.receivingId)));
  }),
);

router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    res.json(await prepast.daftar(req.query));
  }),
);

router.get(
  '/:id/complete-context',
  wajibWewenang(AKSI.TRANSAKSI_SUNTING_PENDING),
  asyncHandler(async (req, res) => {
    res.json({ data: await prepast.konteksPelengkapan(Number(req.params.id), req.user) });
  }),
);

router.get(
  '/:id/dependencies',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await prepast.dependensi(Number(req.params.id)) });
  }),
);

router.post(
  '/',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  validasiBody(skemaBuat),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await prepast.buat(req.body, req.user, req.ip) });
  }),
);

/** Melengkapi draft — satu-satunya jalur update di tempat (BR-16). */
router.post(
  '/:id/complete',
  wajibWewenang(AKSI.TRANSAKSI_SUNTING_PENDING),
  validasiBody(skemaLengkapi),
  asyncHandler(async (req, res) => {
    const data = await prepast.lengkapiDraft(
      Number(req.params.id), req.body, req.user, req.ip,
    );
    res.json({ data });
  }),
);

export default router;
