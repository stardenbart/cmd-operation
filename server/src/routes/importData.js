import { Router, raw } from 'express';
import JSZip from 'jszip';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler, BusinessError } from '../middleware/errors.js';
import { periksaSumber } from '../migrasi/periksaSumber.js';
import { muatSemua } from '../migrasi/muat.js';
import { verifikasiSemua } from '../migrasi/verifikasi.js';
import { LIST } from '../migrasi/sumberKolom.js';

const router = Router();
const bacaZip = raw({ type: ['application/zip', 'application/x-zip-compressed'], limit: '50mb' });
const EKSTENSI = new Set(['.csv', '.xlsx']);
let importBerjalan = false;

/*
 * Menu import berkala hanya menyentuh empat list transaksi: penerimaan,
 * prepast, transfer, monitoring. Dua list sengaja DILEWATI:
 *
 *  - operator     Dikelola langsung di aplikasi (layar Master). Mengimpornya
 *                 ulang akan menimpa perubahan yang sudah dibuat di aplikasi,
 *                 jadi menu ini tidak pernah menyentuhnya. Transaksi tetap
 *                 menautkan operatornya lewat data operator yang sudah ada.
 *  - stockOpname  Belum dipakai. Berkasnya tidak wajib ada, dan ketiadaannya
 *                 tidak menggagalkan import list lain.
 *
 * Keduanya boleh absen dari export tanpa membuat import "tidak lengkap".
 */
const DILEWATI_IMPORT = ['operator', 'stockOpname'];

router.use(wajibLogin, wajibWewenang(AKSI.MASTER_KELOLA));

async function denganFolderZip(buffer, kerja) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new BusinessError('IMPORT_BERKAS', 'Paket import tidak berisi berkas.');
  }
  const folder = await mkdtemp(join(tmpdir(), 'cmd1-import-'));
  try {
    const zip = await JSZip.loadAsync(buffer);
    const berkas = Object.values(zip.files).filter((f) => !f.dir);
    if (!berkas.length) throw new BusinessError('IMPORT_BERKAS', 'Paket ZIP kosong.');

    for (const item of berkas) {
      const nama = basename(item.name);
      if (!nama || !EKSTENSI.has(extname(nama).toLowerCase())) continue;
      await writeFile(join(folder, nama), await item.async('nodebuffer'));
    }
    return await kerja(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/*
 * Unduh template format import.
 *
 * Yang dibangun dari `LIST` yang sama dengan yang dipakai pemeriksa dan
 * pemuat, sehingga template tidak mungkin menyimpang dari kolom yang benar-
 * benar diharapkan. Header CSV memakai nama kolom PERSIS - itulah yang
 * dicocokkan importer; menaruh tanda bintang di header justru membuat
 * kolomnya tak dikenali. Kolom mana yang wajib dijelaskan terpisah di
 * PETUNJUK_FORMAT.csv agar berkas datanya tetap bersih.
 */
const kutipCsv = (v) => {
  const t = String(v ?? '');
  return /[",\n;]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
};

router.get('/template', asyncHandler(async (req, res) => {
  const zip = new JSZip();

  // Hanya list yang memang diimport menu ini (operator & stockOpname dilewati).
  const listDipakai = Object.entries(LIST).filter(([nama]) => !DILEWATI_IMPORT.includes(nama));

  // Satu CSV header-saja per list, dinamai persis seperti berkas sumbernya.
  for (const [, def] of listDipakai) {
    const header = def.kolom.map((k) => kutipCsv(k.dari)).join(',');
    // BOM di depan supaya Excel membaca UTF-8 dengan benar.
    zip.file(`${def.berkas}.csv`, `﻿${header}\n`);
  }

  // Petunjuk: tiap kolom, wajib atau tidak, dan jenis nilainya.
  const barisPetunjuk = [['list', 'berkas', 'kolom', 'wajib', 'jenis']];
  for (const [nama, def] of listDipakai) {
    for (const k of def.kolom) {
      barisPetunjuk.push([
        nama, def.berkas, k.dari, k.wajib ? 'WAJIB' : 'opsional', k.jenis ?? 'teks',
      ]);
    }
  }
  const petunjuk = barisPetunjuk.map((b) => b.map(kutipCsv).join(',')).join('\n');
  zip.file('PETUNJUK_FORMAT.csv', `﻿${petunjuk}\n`);

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="Template_Import_CMD1.zip"');
  res.send(buffer);
}));

router.post('/preview', bacaZip, asyncHandler(async (req, res) => {
  const hasil = await denganFolderZip(req.body, (folder) => periksaSumber(folder, DILEWATI_IMPORT));
  res.json(hasil);
}));

router.post('/execute', bacaZip, asyncHandler(async (req, res) => {
  if (req.query.konfirmasi !== 'ya') {
    throw new BusinessError('IMPORT_KONFIRMASI', 'Konfirmasi import wajib diberikan.');
  }
  if (importBerjalan) {
    throw new BusinessError('IMPORT_BERJALAN', 'Import lain sedang berjalan. Coba kembali setelah selesai.');
  }

  importBerjalan = true;
  try {
    const hasil = await denganFolderZip(req.body, async (folder) => {
      const pemeriksaan = await periksaSumber(folder, DILEWATI_IMPORT);
      if (!pemeriksaan.siap) {
        throw new BusinessError(
          'IMPORT_SUMBER',
          'Berkas belum siap dimuat. Perbaiki hasil pemeriksaan terlebih dahulu.',
          pemeriksaan,
        );
      }
      const laporan = await muatSemua(folder, DILEWATI_IMPORT);
      const verifikasi = await verifikasiSemua({ laporan });
      return {
        pemeriksaan,
        ringkasan: laporan.ringkasan,
        jumlahPengecualian: laporan.jumlah,
        pengecualian: laporan.pengecualian,
        verifikasi,
      };
    });
    res.json(hasil);
  } finally {
    importBerjalan = false;
  }
}));

export default router;
