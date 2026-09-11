import { Router } from 'express';
import { z } from 'zod';
import * as dataList from '../services/dataList.js';
import { riwayatAudit } from '../services/audit.js';
import { pool } from '../db/pool.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiQuery } from '../middleware/validasi.js';
import { batasTanggal } from '../services/waktu.js';

const router = Router();
router.use(wajibLogin);

const MODUL = z.enum(['receiving', 'prepast', 'pengembalian', 'transfer', 'monitoring']);

const opsional = (skema) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), skema.optional());

const skemaDaftar = z.object({
  halaman: z.coerce.number().int().positive().default(1),
  perHalaman: z.coerce.number().int().positive().max(100).default(25),
  status: opsional(z.string()),
  statusIds: opsional(z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.string().min(1).max(40)).max(20),
  )),
  siloId: opsional(z.coerce.number().int().positive()),
  tankId: opsional(z.coerce.number().int().positive()),
  tankIds: opsional(z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.coerce.number().int().positive()).max(50),
  )),
  /*
   * Banyak silo sekaligus, dikirim sebagai daftar berpisah koma.
   *
   * Koma, bukan parameter berulang (`siloIds=1&siloIds=2`): Express menjadikan
   * yang berulang sebagai array HANYA bila muncul lebih dari sekali, sehingga
   * satu pilihan menjadi string dan dua pilihan menjadi array. Bentuk yang
   * berubah-ubah itulah yang paling mudah membuat filter salah diam-diam.
   */
  siloIds: opsional(z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v),
    z.array(z.coerce.number().int().positive()).max(50),
  )),
  draftSaja: opsional(z.coerce.boolean()),
  aktifSaja: opsional(z.coerce.boolean()),
  // Hanya berlaku untuk modul receiving - lihat MODUL.receiving.filter di
  // dataList.js. Dituju langsung dari kartu "Menunggu Berat Jenis" Dashboard.
  bjKosong: opsional(z.coerce.boolean()),
  // Hanya berlaku untuk modul transfer - Pindah Silo yang tercatat melebihi
  // batas keras silo tujuan (BR-24 kini soft cap, lihat transfer.js).
  lewatKapasitas: opsional(z.coerce.boolean()),
  // Tanggal saja ditafsirkan sebagai HARI SETEMPAT, bukan tengah malam UTC.
  // Tanpa ini filter "25 Agustus sampai 25 Agustus" mengembalikan nol baris
  // padahal ada enam (B-7).
  dariTanggal: opsional(z.preprocess((v) => batasTanggal(v, 'mulai'), z.date())),
  sampaiTanggal: opsional(z.preprocess((v) => batasTanggal(v, 'akhir'), z.date())),
  supplierId: opsional(z.coerce.number().int().positive()),
  cari: opsional(z.string().max(80)),
});

/**
 * Input yang masih GANTUNG, seluruh modul sekaligus - BR-23.
 *
 * Proses penerimaan, prepast, dan transfer kerap berjalan PARALEL: satu belum
 * selesai ketika yang berikutnya sudah mulai. Sistem lama memaksa operator
 * menunggu sampai satu proses tuntas sebelum boleh mencatat apa pun, sehingga
 * yang dicatat adalah angka yang diingat belakangan - bukan angka yang diukur.
 *
 * Karena itu input separuh diizinkan. Konsekuensinya juga jelas: yang separuh
 * harus DITAGIH, bukan didiamkan sampai ditemukan berbulan-bulan kemudian saat
 * form GMP-nya tidak dapat dicetak. Endpoint ini yang memasok penagihan itu di
 * halaman Home.
 *
 * Diletakkan SEBELUM rute `/:modul` - kalau tidak, "gantung" akan tertangkap
 * sebagai nama modul dan ditolak sebagai modul yang tidak dikenal.
 */
router.get(
  '/gantung',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json(await dataList.gantung(req.user));
  }),
);

router.get(
  '/:modul',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    const modul = MODUL.parse(req.params.modul);
    res.json(await dataList.daftar(modul, req.query, req.user));
  }),
);

router.get(
  '/:modul/summary',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    const modul = MODUL.parse(req.params.modul);
    res.json({ perStatus: await dataList.ringkasanStatus(modul) });
  }),
);

/**
 * Riwayat perubahan satu record - syarat A-6.
 *
 * Jejak audit yang tidak dapat ditunjukkan sama saja dengan tidak ada.
 * Inilah yang membuat koreksi in-place (FR-14.1) memenuhi
 * 21 CFR Part 11 sec.11.10(e): nilai lama tidak dikaburkan, ia terbaca di sini.
 */
/** Detail lengkap satu record - fitur "Lihat". */
router.get(
  '/:modul/:id/detail',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    const modul = MODUL.parse(req.params.modul);
    res.json({ data: await dataList.detail(modul, Number(req.params.id)) });
  }),
);

router.get(
  '/:modul/:id/history',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    const modul = MODUL.parse(req.params.modul);
    res.json({ data: await riwayatAudit(pool, modul, Number(req.params.id)) });
  }),
);

export default router;
