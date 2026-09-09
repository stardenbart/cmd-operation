/**
 * Losses Management - FR-35.5.
 *
 * MEMBACA terbuka bagi yang boleh melihat dashboard (konteks laporan losses).
 * MENYUNTING wewenang Admin (master:kelola), ditegakkan juga di lapis service.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as losses from '../services/losses.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const skemaSunting = z.object({
  nama: z.string().max(120).optional(),
  volume_liter: z.coerce.number().min(0).max(999999).optional(),
  satuan: z.enum(['per_penarikan', 'per_transfer']).optional(),
  calculation_type: z.enum(['fixed_per_record', 'fixed_per_frequency_prepast', 'manual_input']).optional(),
  aktif: z.coerce.boolean().optional(),
  catatan: z.string().max(2000).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Tidak ada nilai yang diubah' });

const skemaVersi = z.object({ catatan: z.string().max(255).nullable().optional() });

router.get(
  '/points',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json(await losses.daftar());
  }),
);

router.get(
  '/points/:id',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await losses.detail(Number(req.params.id)) });
  }),
);

router.patch(
  '/points/:id',
  wajibWewenang(AKSI.MASTER_KELOLA),
  validasiBody(skemaSunting),
  asyncHandler(async (req, res) => {
    res.json(await losses.sunting(Number(req.params.id), req.body, req.user, req.ip));
  }),
);

router.post(
  '/versions',
  wajibWewenang(AKSI.MASTER_KELOLA),
  validasiBody(skemaVersi),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await losses.buatVersi(req.user, req.body.catatan, req.ip) });
  }),
);

router.get(
  '/versions',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json(await losses.daftarVersi());
  }),
);

router.get(
  '/versions/:id',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await losses.versi(Number(req.params.id)) });
  }),
);

export default router;
