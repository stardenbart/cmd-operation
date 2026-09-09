/**
 * Stock Opname - FR-8, FR-24
 *
 * Membaca terbuka untuk siapa pun yang boleh melihat dashboard: angka stok
 * awal bulan adalah konteks yang berguna bagi SPV maupun operator. MENULIS
 * wewenang Admin semata (BR-22, D-5).
 */

import { Router } from 'express';
import { z } from 'zod';
import * as so from '../services/stockOpname.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const PERIODE = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'periode harus berbentuk YYYY-MM');

/**
 * Volume awal boleh NOL, dan itu berbeda dari kosong.
 *
 * Helper `angkaDesimal` yang dipakai modul lain menolak nol karena di sana nol
 * memang tidak berarti apa-apa: penerimaan nol liter bukan penerimaan. Di sini
 * sebaliknya, silo yang benar-benar kosong saat dihitung adalah hasil yang
 * sah, dan membedakannya dari "belum dihitung" justru inti FR-8.5.
 */
const volumeAwal = z.preprocess(
  (v) => (typeof v === 'string' ? v.replace(',', '.') : v),
  z.coerce.number().min(0, 'volume awal tidak boleh negatif'),
);

const skemaBaris = z.object({
  periode: PERIODE,
  siloId: z.coerce.number().int().positive(),
  jumlahAwalLtr: volumeAwal,
});

const skemaFinal = z.object({ periode: PERIODE });

router.get(
  '/periode',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await so.daftarPeriode() });
  }),
);

router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(z.object({ periode: PERIODE })),
  asyncHandler(async (req, res) => {
    res.json({ data: await so.daftar(req.query.periode) });
  }),
);

/** Simpan satu baris. Tidak menuntut seluruh silo terisi (WF-12). */
router.post(
  '/baris',
  wajibWewenang(AKSI.STOCK_OPNAME_KELOLA),
  validasiBody(skemaBaris),
  asyncHandler(async (req, res) => {
    res.json({ data: await so.simpanBaris(req.body, req.user, req.ip) });
  }),
);

/** Kunci periode. DI SINI kelengkapan diwajibkan (FR-8.5, memperbaiki B-3). */
router.post(
  '/finalisasi',
  wajibWewenang(AKSI.STOCK_OPNAME_KELOLA),
  validasiBody(skemaFinal),
  asyncHandler(async (req, res) => {
    res.json({ data: await so.finalisasi(req.body.periode, req.user, req.ip) });
  }),
);

export default router;
