/**
 * Export rentang sebagai satu arsip - F3-8, FR-12.12
 *
 * Satu berkas per hari DIPERTAHANKAN di dalam arsipnya, bukan digabung menjadi
 * satu workbook berisi banyak sheet. Alasannya bukan teknis: `CMD1/FRM/PRD/01`
 * adalah form harian yang ditandatangani per hari. Menggabung tiga puluh hari
 * ke satu berkas mengubah dokumen terkendali menjadi laporan, dan itu bukan
 * kewenangan sistem ini.
 *
 * Yang digabung hanyalah cara mengantarkannya: satu unduhan alih-alih tiga
 * puluh klik.
 */

import JSZip from 'jszip';
import { modelForm, validasiForm } from './formData.js';
import { bangunBerkas, namaBerkas } from './formExcel.js';

/**
 * Indeks arsip sebagai CSV.
 *
 * Sengaja CSV, bukan sheet Excel: indeks ini dibaca manusia yang mencari satu
 * tanggal, dan kadang dibaca skrip. Ia juga harus dapat dibuka tanpa membuka
 * salah satu formnya, sehingga tidak boleh menjadi bagian dari workbook mana
 * pun.
 *
 * Baris untuk hari yang TIDAK menghasilkan berkas tetap ada, dengan alasannya.
 * Arsip yang hanya memuat hari berisi membuat penerimanya harus menebak apakah
 * suatu tanggal memang tidak ada datanya atau proses exportnya gagal.
 */
function indeksCsv(baris) {
  const kolom = [
    'tanggal', 'berkas', 'jumlah_baris', 'pemblokir', 'peringatan', 'keterangan',
  ];
  const kutip = (v) => {
    const t = String(v ?? '');
    return /[",\n;]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };

  const isi = baris.map((b) =>
    [b.tanggal, b.berkas ?? '', b.jumlahBaris, b.jumlahPemblokir, b.jumlahPeringatan, b.keterangan]
      .map(kutip)
      .join(';'),
  );

  // Pemisah titik koma dan BOM: Excel berbahasa Indonesia membuka CSV
  // berkoma sebagai satu kolom, dan tanpa BOM nama supplier beraksen rusak.
  return `﻿${kolom.join(';')}\n${isi.join('\n')}\n`;
}

/**
 * Membangun arsip untuk sederet tanggal.
 *
 * Hari yang kosong dilewati, sama seperti perilaku lama, tetapi TERCATAT di
 * indeks. Hari yang punya pemblokir juga dilewati berkasnya: menerbitkan form
 * yang barisnya terpotong berarti menerbitkan catatan mutu yang tidak lengkap
 * tanpa ada yang tahu.
 *
 * @param {string[]} daftarTanggal
 * @returns {Promise<{buffer: Buffer, nama: string, ringkasan: object, rincian: object[]}>}
 */
export async function bangunArsip(daftarTanggal) {
  if (daftarTanggal.length === 0) {
    throw new Error('Rentang tanggal kosong');
  }

  const zip = new JSZip();
  const rincian = [];

  for (const tanggal of daftarTanggal) {
    const model = await modelForm(tanggal);
    const validasi = await validasiForm(model);

    const dasar = {
      tanggal,
      jumlahBaris: model.halaman1.length,
      jumlahPemblokir: validasi.jumlahPemblokir,
      jumlahPeringatan: validasi.jumlahPeringatan,
    };

    if (model.kosong) {
      rincian.push({ ...dasar, berkas: null, keterangan: 'tidak ada data' });
      continue;
    }

    if (validasi.adaPemblokir) {
      rincian.push({
        ...dasar,
        berkas: null,
        keterangan: `dilewati, ${validasi.jumlahPemblokir} temuan pemblokir`,
      });
      continue;
    }

    const nama = namaBerkas(tanggal);
    zip.file(nama, await bangunBerkas(model));
    rincian.push({
      ...dasar,
      berkas: nama,
      keterangan: validasi.jumlahPeringatan > 0 ? 'terbit dengan peringatan' : 'terbit',
    });
  }

  zip.file('_indeks.csv', indeksCsv(rincian));

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    // Berkas xlsx sudah terkompresi di dalamnya, jadi kompresi ulang hanya
    // membakar CPU untuk hasil beberapa persen. Level rendah sudah memadai.
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  });

  const awal = daftarTanggal[0].replaceAll('-', '');
  const akhir = daftarTanggal.at(-1).replaceAll('-', '');
  const nama = awal === akhir
    ? `Rekap_FM_${awal}.zip`
    : `Rekap_FM_${awal}_sd_${akhir}.zip`;

  return {
    buffer: Buffer.from(buffer),
    nama,
    rincian,
    ringkasan: {
      jumlahHari: rincian.length,
      jumlahBerkas: rincian.filter((r) => r.berkas).length,
      jumlahDilewati: rincian.filter((r) => !r.berkas).length,
      jumlahPemblokir: rincian.reduce((s, r) => s + r.jumlahPemblokir, 0),
      jumlahPeringatan: rincian.reduce((s, r) => s + r.jumlahPeringatan, 0),
    },
  };
}
