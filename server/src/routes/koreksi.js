import { Router } from 'express';
import { z } from 'zod';
import { koreksi } from '../services/koreksi.js';
import { pool } from '../db/pool.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler, NotFoundError, BusinessError } from '../middleware/errors.js';
import { validasiBody } from '../middleware/validasi.js';
import { skemaPerubahanKoreksi } from '../schemas/koreksi.js';

const router = Router();
router.use(wajibLogin);

const MODUL = z.enum(['receiving', 'prepast', 'pengembalian', 'transfer', 'monitoring']);
const skemaKoreksi = skemaPerubahanKoreksi.extend({
  alasan: z.string().min(3, 'alasan koreksi wajib diisi').max(1000),
});

/** Nilai record apa adanya, untuk mengisi form koreksi. */
router.get(
  '/:modul/:id',
  wajibWewenang(AKSI.TRANSAKSI_SUNTING_PENDING),
  asyncHandler(async (req, res) => {
    const modul = MODUL.parse(req.params.modul);
    const tabel = {
      receiving: 'receiving',
      prepast: 'prepast_record', pengembalian: 'prepast_record',
      transfer: 'transfer', monitoring: 'monitoring',
    }[modul];

    const [baris] = await pool.query(`SELECT * FROM ${tabel} WHERE id = ?`, [
      Number(req.params.id),
    ]);
    if (!baris[0]) throw new NotFoundError('Record');

    // Konteks tambahan yang dibutuhkan form
    const tambahan = {};
    if (modul === 'receiving') {
      const [suppliers] = await pool.query(
        'SELECT id, supplier_name FROM supplier WHERE is_active = TRUE ORDER BY supplier_name',
      );
      tambahan.suppliers = suppliers;
    }
    if (modul === 'transfer') {
      const [tanks] = await pool.query(
        'SELECT id, tank_name FROM tank_master WHERE is_active = TRUE ORDER BY urutan',
      );
      const [prefiks] = await pool.query(
        'SELECT kode, is_standar FROM batch_prefix WHERE is_active = TRUE ORDER BY urutan',
      );
      tambahan.tanks = tanks;
      tambahan.prefiksBatch = prefiks;
    }

    res.json({ data: baris[0], ...tambahan });
  }),
);

router.post(
  '/:modul/:id',
  // Wewenang minimum: menyunting record pending. Untuk record yang sudah
  // disetujui, lapis service menuntut peran SPV (BR-19).
  wajibWewenang(AKSI.TRANSAKSI_SUNTING_PENDING),
  validasiBody(skemaKoreksi),
  asyncHandler(async (req, res) => {
    const parsed = MODUL.safeParse(req.params.modul);
    if (!parsed.success) {
      throw new BusinessError(
        'VALIDATION_ERROR',
        `Modul tidak dapat dikoreksi: ${req.params.modul}`,
      );
    }
    const { alasan, ...ubah } = req.body;
    res.json({
      data: await koreksi(parsed.data, Number(req.params.id), ubah, alasan, req.user, req.ip),
    });
  }),
);

export default router;
