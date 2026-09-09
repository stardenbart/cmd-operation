/**
 * Export form GMP - FR-12, FR-28
 *
 * Tiga endpoint, satu sumber data:
 *
 *   GET /export/preview?tanggal=    model form untuk dirender pratinjau
 *   GET /export/validate?...        temuan pra-export untuk satu rentang
 *   GET /export/download?tanggal=   berkas xlsx, langsung terunduh
 *
 * Pratinjau dan berkas dibangun dari `modelForm()` yang sama, jadi keduanya
 * tidak dapat menampilkan data yang berbeda (FR-28.7).
 */

import { Router } from 'express';
import { z } from 'zod';
import { modelForm, validasiForm } from '../services/formData.js';
import { bangunBerkas, namaBerkas } from '../services/formExcel.js';
import { bangunArsip } from '../services/formZip.js';
import {
  ambilDataTabel,
  bangunBerkasDataTabel,
  jumlahDataTabel,
  namaBerkasDataTabel,
} from '../services/dataTableExcel.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler, BusinessError } from '../middleware/errors.js';
import { validasiQuery } from '../middleware/validasi.js';

const router = Router();
router.use(wajibLogin);

const TANGGAL = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'tanggal harus berbentuk YYYY-MM-DD');

const skemaSatuHari = z.object({ tanggal: TANGGAL });

/** Rentang, dibatasi supaya satu permintaan tidak menggantung berjam-jam. */
const MAKS_HARI = 31;

const skemaRentang = z
  .object({
    tanggal: TANGGAL,
    sampai: z.preprocess((v) => (v === '' || v == null ? undefined : v), TANGGAL.optional()),
  })
  .refine((v) => !v.sampai || v.sampai >= v.tanggal, {
    message: 'tanggal akhir tidak boleh lebih awal daripada tanggal mulai',
  });

const skemaDataTabel = z
  .object({ dari: TANGGAL, sampai: TANGGAL })
  .refine((v) => v.sampai >= v.dari, {
    message: 'tanggal akhir tidak boleh lebih awal daripada tanggal mulai',
  });

/** Daftar tanggal dalam rentang, inklusif di kedua ujungnya. */
function daftarTanggal(dari, sampai) {
  const hasil = [];
  const [t1, b1, h1] = dari.split('-').map(Number);
  const kursor = new Date(t1, b1 - 1, h1);
  const batas = sampai ?? dari;

  while (hasil.length < MAKS_HARI) {
    const iso = [
      kursor.getFullYear(),
      String(kursor.getMonth() + 1).padStart(2, '0'),
      String(kursor.getDate()).padStart(2, '0'),
    ].join('-');
    hasil.push(iso);
    if (iso >= batas) break;
    kursor.setDate(kursor.getDate() + 1);
  }
  return hasil;
}

/**
 * Pratinjau satu hari - FR-28.1, FR-28.2.
 *
 * Mengembalikan model beserta temuan validasinya sekaligus, supaya panel
 * validasi dan pratinjau tidak dapat memperlihatkan keadaan yang berbeda
 * akibat dua permintaan yang terpisah waktunya.
 */
router.get(
  '/preview',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaSatuHari),
  asyncHandler(async (req, res) => {
    const model = await modelForm(req.query.tanggal);
    const validasi = await validasiForm(model);

    res.json({
      data: {
        tanggal: model.tanggal,
        dokumen: model.tataLetak.dokumen,
        kapasitas: {
          barisHalaman1: model.tataLetak.halaman1.kapasitasBaris,
          slotMonitoring: model.tataLetak.halaman2.monitoring.kapasitasSlot,
          transferPerSilo:
            model.tataLetak.halaman2.transfer.barisPerSilo *
            model.tataLetak.halaman2.transfer.slotPerBaris,
        },
        kolomHalaman1: model.tataLetak.halaman1.kolom,
        urutanSilo: model.tataLetak.halaman2.monitoring.urutanSilo,
        halaman1: model.halaman1,
        halaman2: model.halaman2,
        catatan: model.catatan,
        kosong: model.kosong,
        namaBerkas: namaBerkas(model.tanggal),
      },
      validasi,
    });
  }),
);

/** Temuan validasi untuk satu rentang, tanpa membangun berkas apa pun. */
router.get(
  '/validate',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaRentang),
  asyncHandler(async (req, res) => {
    const tanggal = daftarTanggal(req.query.tanggal, req.query.sampai);
    const perHari = [];

    for (const t of tanggal) {
      const model = await modelForm(t);
      const validasi = await validasiForm(model);
      perHari.push({
        tanggal: t,
        jumlahBaris: model.halaman1.length,
        kosong: model.kosong,
        namaBerkas: namaBerkas(t),
        ...validasi,
      });
    }

    res.json({
      data: perHari,
      ringkasan: {
        jumlahHari: perHari.length,
        // Hari kosong tidak menghasilkan berkas, sama seperti flow lama
        jumlahBerkas: perHari.filter((h) => !h.kosong).length,
        jumlahPemblokir: perHari.reduce((s, h) => s + h.jumlahPemblokir, 0),
        jumlahPeringatan: perHari.reduce((s, h) => s + h.jumlahPeringatan, 0),
      },
    });
  }),
);

/**
 * Unduh berkas satu hari - FR-12.3.
 *
 * Pemblokir menghentikan unduhan, peringatan tidak (FR-28.5). Membiarkan
 * berkas terbit padahal barisnya terpotong berarti menerbitkan catatan mutu
 * yang tidak lengkap tanpa ada yang tahu.
 */
router.get(
  '/download',
  wajibWewenang(AKSI.EXPORT_JALANKAN),
  validasiQuery(skemaSatuHari),
  asyncHandler(async (req, res) => {
    const model = await modelForm(req.query.tanggal);

    if (model.kosong) {
      throw new BusinessError(
        'B-27',
        `Tidak ada data pada ${req.query.tanggal}, jadi tidak ada yang dapat diterbitkan.`,
      );
    }

    const validasi = await validasiForm(model);
    if (validasi.adaPemblokir) {
      throw new BusinessError(
        'FR-28.5',
        'Masih ada temuan yang menghalangi export. Periksa panel validasi.',
        { temuan: validasi.temuan.filter((t) => t.jenis === 'pemblokir') },
      );
    }

    const buffer = await bangunBerkas(model);
    const nama = namaBerkas(model.tanggal);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nama}"`);
    res.setHeader('Content-Length', buffer.length);
    // Nama berkas perlu terbaca klien untuk menamai unduhannya
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(buffer);
  }),
);

/**
 * Unduh satu rentang sebagai arsip - FR-12.12.
 *
 * Pemblokir di SATU hari tidak menghentikan seluruh rentang; hari itu yang
 * dilewati, dan alasannya tercatat di indeks arsip. Menghentikan export
 * sebulan karena satu hari bermasalah akan memaksa Admin mengunduh dua puluh
 * sembilan hari sisanya satu per satu.
 */
router.get(
  '/download-zip',
  wajibWewenang(AKSI.EXPORT_JALANKAN),
  validasiQuery(skemaRentang),
  asyncHandler(async (req, res) => {
    const tanggal = daftarTanggal(req.query.tanggal, req.query.sampai);
    const arsip = await bangunArsip(tanggal);

    if (arsip.ringkasan.jumlahBerkas === 0) {
      throw new BusinessError(
        'FR-12.12',
        'Tidak ada satu pun hari yang dapat diterbitkan pada rentang ini. ' +
          'Periksa pemeriksaan rentang untuk melihat sebabnya.',
        { rincian: arsip.rincian },
      );
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${arsip.nama}"`);
    res.setHeader('Content-Length', arsip.buffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(arsip.buffer);
  }),
);

/**
 * Satu workbook tabel datar: Receiving-Prepast, Transfer, dan Monitoring.
 * Seluruh status ikut karena ini export data raw, bukan dokumen GMP terbitan.
 */
router.get(
  '/download-table',
  wajibWewenang(AKSI.EXPORT_JALANKAN),
  validasiQuery(skemaDataTabel),
  asyncHandler(async (req, res) => {
    const data = await ambilDataTabel(req.query.dari, req.query.sampai);

    if (jumlahDataTabel(data) === 0) {
      throw new BusinessError(
        'EXPORT_TABLE_EMPTY',
        `Tidak ada data Receiving-Prepast, Transfer, atau Monitoring pada ` +
          `${req.query.dari} sampai ${req.query.sampai}.`,
      );
    }

    const buffer = await bangunBerkasDataTabel(data);
    const nama = namaBerkasDataTabel(req.query.dari, req.query.sampai);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nama}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(buffer);
  }),
);

export default router;
