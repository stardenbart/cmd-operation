import { Router } from 'express';
import { z } from 'zod';
import * as batal from '../services/void.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const skemaBatal = z.object({
  alasan: z.string().min(3, 'alasan pembatalan wajib diisi').max(1000),
});

/**
 * Pratinjau dampak, untuk konfirmasi sebelum pembatalan.
 *
 * Operator ikut boleh melihatnya: ia perlu tahu apakah inputnya masih dapat
 * dibatalkan sendiri, dan pratinjau hanya MEMBACA.
 */
router.get(
  '/:modul/:id/preview',
  wajibWewenang(AKSI.RECORD_VOID_SENDIRI),
  asyncHandler(async (req, res) => {
    res.json(await batal.pratinjauBerjenjang(req.params.modul, Number(req.params.id)));
  }),
);

/*
 * Penjaga di rute ini SENGAJA yang paling longgar dari keduanya.
 *
 * Syarat sebenarnya - hanya record sendiri, hanya yang belum disetujui -
 * bergantung pada ISI barisnya, dan middleware tidak membaca baris. Yang
 * menegakkannya `pastikanBolehVoid()` di services/void.js, di dalam transaksi
 * yang sama dengan pembatalannya. Rute ini hanya menyaring peran yang sama
 * sekali tidak berkepentingan.
 */
router.post(
  '/:modul/:id',
  wajibWewenang(AKSI.RECORD_VOID_SENDIRI),
  validasiBody(skemaBatal),
  asyncHandler(async (req, res) => {
    res.json({
      data: await batal.batalkan(
        req.params.modul, Number(req.params.id), req.body.alasan, req.user, req.ip,
      ),
    });
  }),
);

/**
 * Pembatalan berjenjang.
 *
 * Endpoint terpisah dari pembatalan tunggal supaya tindakan yang jauh lebih
 * merusak tidak terpanggil karena kesalahan parameter.
 *
 * Penjaga di sini yang paling longgar dari keduanya, seperti pada pembatalan
 * tunggal: syarat sebenarnya berlaku ke SELURUH rantai yang akan terbatalkan,
 * dan itu hanya dapat diperiksa setelah pohon dependensinya dibaca. Yang
 * menegakkannya `pastikanBolehVoidRantai()` di services/void.js.
 */
router.post(
  '/:modul/:id/cascade',
  wajibWewenang(AKSI.RECORD_VOID_SENDIRI),
  validasiBody(skemaBatal),
  asyncHandler(async (req, res) => {
    res.json({
      data: await batal.batalkanBerjenjang(
        req.params.modul, Number(req.params.id), req.body.alasan, req.user, req.ip,
      ),
    });
  }),
);

export default router;
