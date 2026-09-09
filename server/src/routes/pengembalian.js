import { Router } from 'express';
import { z } from 'zod';
import * as pengembalian from '../services/pengembalian.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery, angkaDesimal, teksOpsional, waktu } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const skemaBuat = z.object({
  siloId: z.coerce.number().int().positive(),
  volumeLtr: angkaDesimal({ min: 0, maxDecimals: 2 }),
  waktuKembali: waktu(),
  // Kapan susu ini MENINGGALKAN silo. Operator umumnya tahu ini meski tidak
  // tahu komposisi suppliernya, dan inilah yang menentukan posisi FIFO-nya.
  waktuKeluar: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    waktu().optional(),
  ),
  transferAsalId: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  keteranganAsal: teksOpsional(255),
  // Wajib. Pengembalian adalah kejadian luar biasa yang memutus rantai
  // telusur, sehingga alasannya harus tercatat (BR-25, syarat A-5).
  alasan: z.string().min(3, 'alasan pengembalian wajib diisi').max(1000),
});

const skemaDaftar = z.object({
  halaman: z.coerce.number().int().positive().default(1),
  perHalaman: z.coerce.number().int().positive().max(100).default(25),
  siloId: z.coerce.number().int().positive().optional(),
});

router.get(
  '/form-context',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  asyncHandler(async (req, res) => {
    res.json(await pengembalian.konteksForm());
  }),
);

/** Transfer keluar terkini dari suatu silo, sebagai pilihan asal. */
router.get(
  '/transfer-terkini/:siloId',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await pengembalian.transferTerkini(Number(req.params.siloId)) });
  }),
);

router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    res.json(await pengembalian.daftar(req.query));
  }),
);

router.post(
  '/',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  validasiBody(skemaBuat),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await pengembalian.buat(req.body, req.user, req.ip) });
  }),
);

export default router;
