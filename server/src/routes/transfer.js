import { Router } from 'express';
import { z } from 'zod';
import * as transfer from '../services/transfer.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiBody, validasiQuery, angkaDesimal, angkaDesimalOpsional, teksOpsional, waktu } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

/*
 * Tujuan yang tidak dipakai dikirim form sebagai string kosong, bukan
 * dihilangkan: PEMAKAIAN PRODUKSI tetap membawa siloTujuanId='' dan PINDAH SILO
 * tetap membawa tankId=''. Tanpa praproses ini, z.coerce mengubah '' menjadi 0
 * lalu .positive() menolaknya dengan "Number must be greater than 0" - padahal
 * field itu memang tidak relevan untuk jenis tersebut. Kosong = tidak diisi.
 */
const idTujuanOpsional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

const nomorBatchOpsional = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.union([z.string(), z.number()]).optional(),
);

const skemaBatchBersama = z.object({
  batchPrefix: teksOpsional(10),
  batchNomor: nomorBatchOpsional,
});

const skemaBuat = z
  .object({
    siloAsalId: z.coerce.number().int().positive(),
    jenis: z.enum(['PEMAKAIAN PRODUKSI', 'PINDAH SILO']),
    volumeLtr: angkaDesimal({ min: 0, maxDecimals: 2 }),
    trfTime: waktu().optional(),
    tankId: idTujuanOpsional,
    siloTujuanId: idTujuanOpsional,
    batchPrefix: teksOpsional(10),
    batchNomor: nomorBatchOpsional,
    isDraft: z.coerce.boolean().default(false),
  })
  // Tujuan dan batch bergantung pada jenis transfernya. Diperiksa di lapis
  // skema supaya kesalahan bentuk permintaan tidak sampai menyentuh basis data.
  .superRefine((v, ctx) => {
    if (v.jenis === 'PEMAKAIAN PRODUKSI') {
      if (!v.tankId) {
        ctx.addIssue({ code: 'custom', path: ['tankId'], message: 'wajib untuk PEMAKAIAN PRODUKSI' });
      }
      /*
       * batchPrefix TIDAK diperiksa di sini.
       *
       * Wajib atau tidaknya bergantung pada ATURAN TANGKINYA - CMD 2 selalu
       * CMD2 dan PENGOSONGAN SILO tidak berbatch - dan lapis skema tidak
       * mengenal tangkinya. Menuntutnya di sini membuat kedua tangki itu
       * mustahil dipakai tanpa mengirim prefiks palsu. Penjagaannya ada di
       * services/transfer.js, tempat aturan tangkinya sudah terbaca.
       */
    } else if (!v.siloTujuanId) {
      ctx.addIssue({ code: 'custom', path: ['siloTujuanId'], message: 'wajib untuk PINDAH SILO' });
    }
  });

/*
 * Beberapa baris transfer sekaligus (multi-MT dari multi-silo, satu waktu).
 * Tiap baris divalidasi dengan aturan yang sama seperti transfer tunggal;
 * trfTime dan isDraft berlaku untuk seluruh baris.
 */
const skemaBaris = z
  .object({
    siloAsalId: z.coerce.number().int().positive(),
    jenis: z.enum(['PEMAKAIAN PRODUKSI', 'PINDAH SILO']),
    volumeLtr: angkaDesimal({ min: 0, maxDecimals: 2 }),
    tankId: idTujuanOpsional,
    siloTujuanId: idTujuanOpsional,
    batchPrefix: teksOpsional(10),
    batchNomor: nomorBatchOpsional,
  })
  .superRefine((v, ctx) => {
    if (v.jenis === 'PEMAKAIAN PRODUKSI') {
      if (!v.tankId) ctx.addIssue({ code: 'custom', path: ['tankId'], message: 'wajib untuk PEMAKAIAN PRODUKSI' });
    } else if (!v.siloTujuanId) {
      ctx.addIssue({ code: 'custom', path: ['siloTujuanId'], message: 'wajib untuk PINDAH SILO' });
    }
  });

const skemaBatch = z.object({
  // Waktu transfer WAJIB pada input multi-baris - transfer batch selalu punya
  // waktu, tidak menggantung.
  trfTime: waktu(),
  // Default MANUAL menjaga kompatibilitas klien lama yang mengirim batch pada
  // setiap baris. Mode SAMA memakai satu sumber batch di tingkat request.
  modeBatch: z.enum(['SAMA', 'MANUAL']).default('MANUAL'),
  batchBersama: skemaBatchBersama.optional(),
  baris: z.array(skemaBaris).min(1).max(20),
});

const skemaPratinjau = z.object({
  siloId: z.coerce.number().int().positive(),
  volume: angkaDesimal({ min: 0, maxDecimals: 2 }).optional(),
});

const skemaDaftar = z.object({
  halaman: z.coerce.number().int().positive().default(1),
  perHalaman: z.coerce.number().int().positive().max(100).default(25),
  status: z.string().optional(),
  siloAsalId: z.coerce.number().int().positive().optional(),
  jenis: z.enum(['PEMAKAIAN PRODUKSI', 'PINDAH SILO']).optional(),
});

/**
 * Pratinjau alokasi FIFO — FR-6.3.
 * Hanya membaca; alokasi sesungguhnya dihitung ulang di dalam transaksi
 * bersama kunci baris saat submit.
 */
router.get(
  '/fifo-preview',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaPratinjau),
  asyncHandler(async (req, res) => {
    res.json(await transfer.pratinjauFifo(req.query.siloId, req.query.volume));
  }),
);

/** Daftar tank aktif - untuk filter Data dan pemilih tujuan. */
router.get(
  '/tanks',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await transfer.daftarTank() });
  }),
);

router.get(
  '/form-context/:siloAsalId',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  asyncHandler(async (req, res) => {
    res.json(await transfer.konteksForm(Number(req.params.siloAsalId)));
  }),
);

router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaDaftar),
  asyncHandler(async (req, res) => {
    res.json(await transfer.daftar(req.query));
  }),
);

router.get(
  '/:id',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    res.json({ data: await transfer.ambil(Number(req.params.id)) });
  }),
);

router.post(
  '/',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  validasiBody(skemaBuat),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await transfer.buat(req.body, req.user, req.ip) });
  }),
);

router.post(
  '/batch',
  wajibWewenang(AKSI.TRANSAKSI_BUAT),
  validasiBody(skemaBatch),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await transfer.buatBanyak(req.body, req.user, req.ip) });
  }),
);

export default router;
