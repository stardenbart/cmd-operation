/**
 * Manajemen master data - FR-26
 *
 * MEMBACA terbuka bagi siapa pun yang boleh melihat dashboard: daftar supplier
 * dan silo adalah konteks yang dipakai layar input. MENULIS wewenang Admin
 * semata (BR-22), dan ditegakkan juga di lapis service.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as master from '../services/masterData.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiQuery } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const MASTER = z.enum(Object.keys(master.MASTER));

const skemaDaftar = z.object({
  cari: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(80).optional()),
  status: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['aktif', 'nonaktif', 'semua']).default('semua'),
  ),
});

/**
 * Isi payload TIDAK divalidasi bentuknya di sini.
 *
 * Kolom tiap master berbeda, dan yang mengetahui bentuknya adalah definisi di
 * `masterData.js`. Menyusun skema zod per master di lapis rute berarti bentuk
 * yang sama ditulis dua kali, dan pelajaran hari ini sudah jelas: yang ditulis
 * dua kali akan menyimpang. Rute hanya memastikan payloadnya objek.
 */
const skemaIsi = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await master.ringkasan() });
  }),
);

router.get(
  '/:master',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    res.json(await master.daftar(MASTER.parse(req.params.master), req.query));
  }),
);

router.get(
  '/:master/csv',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    const nama = MASTER.parse(req.params.master);
    const csv = await master.keCsv(nama);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="master_${nama}.csv"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(csv);
  }),
);

router.get(
  '/:master/:id/history',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({
      data: await master.riwayat(MASTER.parse(req.params.master), Number(req.params.id)),
    });
  }),
);

router.post(
  '/:master',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    const nama = MASTER.parse(req.params.master);
    const isi = skemaIsi.parse(req.body);
    res.status(201).json(await master.buat(nama, isi, req.user, req.ip));
  }),
);

router.patch(
  '/:master/:id',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    const nama = MASTER.parse(req.params.master);
    const isi = skemaIsi.parse(req.body);
    res.json(await master.perbarui(nama, Number(req.params.id), isi, req.user, req.ip));
  }),
);

/** Reset PIN. Hanya berlaku pada master user. */
router.post(
  '/users/:id/reset-password',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    res.json({ data: await master.resetPassword(Number(req.params.id), req.user, req.ip) });
  }),
);

/** Konteks hak akses custom satu user (peran, custom aktif, aksi tersedia). */
router.get(
  '/users/:id/permissions',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    res.json({ data: await master.hakAksesUser(Number(req.params.id)) });
  }),
);

/** Mengatur hak akses custom seorang user - FR-34.2, FR-34.3. */
const skemaHakAkses = z.object({ permissions: z.array(z.string()).max(20) });
router.patch(
  '/users/:id/permissions',
  wajibWewenang(AKSI.MASTER_KELOLA),
  asyncHandler(async (req, res) => {
    const { permissions } = skemaHakAkses.parse(req.body);
    res.json({ data: await master.aturHakAkses(Number(req.params.id), permissions, req.user, req.ip) });
  }),
);

export default router;
