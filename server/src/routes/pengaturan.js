import { Router } from 'express';
import { z } from 'zod';
import * as pengaturan from '../services/pengaturan.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const skemaPerbarui = z.object({
  tampilkanSisaSilo: z.coerce.boolean().optional(),
}).refine(
  (nilai) => Object.keys(nilai).length > 0,
  { message: 'isi minimal satu pengaturan yang akan diubah' },
);

/**
 * Dibaca siapa pun yang sudah login — dipakai Prepast/Lengkapi Prepast untuk
 * memutuskan menampilkan teks "sisa X L" atau tidak. Bukan data rahasia.
 */
router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await pengaturan.ambil() });
  }),
);

/** Mengubah pengaturan global — khusus Admin, wewenang sesungguhnya ditegakkan di service. */
router.patch(
  '/',
  wajibWewenang(AKSI.MASTER_KELOLA),
  validasiBody(skemaPerbarui),
  asyncHandler(async (req, res) => {
    const { tampilkanSisaSilo } = req.body;
    const perubahan = {};
    if (tampilkanSisaSilo !== undefined) perubahan.tampilkan_sisa_silo = tampilkanSisaSilo;
    res.json({ data: await pengaturan.perbarui(perubahan, req.user, req.ip) });
  }),
);

export default router;
