/**
 * Uji keutuhan pemetaan kolom - Fase 4
 *
 * SATU BUG YANG MELAHIRKAN BERKAS INI.
 *
 * `prepast.nilai_ts` terpetakan dengan benar di `sumberKolom.js`, terbaca
 * dengan benar oleh `parseNilai.js`, lalu HILANG - kolomnya tidak pernah ikut
 * disebut di pernyataan INSERT. Akibatnya 985 dari 986 baris prepast masuk
 * dengan nilai TS kosong, dan tidak ada satu pun galat, laporan pengecualian,
 * maupun verifikasi V-1..V-6 yang menyebutnya. Yang menemukannya adalah tabel
 * di Dashboard yang menampilkan kolom itu, berbulan-bulan setelah faktanya.
 *
 * Pemetaan yang tidak ikut ditulis adalah kegagalan yang SENYAP: baris tetap
 * masuk, jumlahnya tetap cocok, hanya isinya yang kurang. Uji ini membaca
 * kedua sisi - daftar pemetaan dan pernyataan INSERT - lalu membandingkannya,
 * sehingga kolom baru yang lupa ditulis gagal di sini, bukan di produksi.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIST } from './sumberKolom.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Tabel tujuan tiap list. */
const TABEL = {
  receiving: 'receiving',
  prepast: 'prepast_record',
  transfer: 'transfer',
  monitoring: 'monitoring',
  stockOpname: 'stock_opname',
};

/**
 * Kolom yang SENGAJA tidak ditulis dari pemetaan, beserta alasannya.
 *
 * Daftar ini harus tetap pendek dan tiap barisnya harus punya alasan. Kalau ia
 * menjadi tempat membuang kolom yang lupa ditulis, uji ini berhenti berguna.
 */
const SENGAJA_TIDAK_DITULIS = {
  receiving: [],
  prepast: [],
  transfer: [],
  monitoring: [],
  stockOpname: [],
};

/*
 * Kosong, dan itu bukan kebetulan.
 *
 * `qty_ltr` sempat ditaruh di sini dengan alasan "dihitung ulang dari kg dan
 * berat jenis (BR-03)". Uji di bawah menolaknya: `qty_ltr` bukan kolom
 * TERPETAKAN sama sekali - ia memang tidak pernah dibaca dari sumber - jadi
 * mengecualikannya tidak menjaga apa pun, hanya melemahkan daftar ini.
 */

describe('Pemetaan kolom ikut ditulis ke basis data', () => {
  for (const [nama, def] of Object.entries(LIST)) {
    test(`${nama}: seluruh kolom terpetakan disebut di INSERT`, async () => {
      const src = await readFile(join(__dirname, 'muat.js'), 'utf8');

      const pola = new RegExp(`INSERT INTO ${TABEL[nama]}\\s*\\(([^)]*)\\)`, 'm');
      const cocok = pola.exec(src);
      assert.ok(cocok, `pernyataan INSERT untuk ${TABEL[nama]} tidak ditemukan`);

      const ditulis = new Set(
        cocok[1].split(',').map((s) => s.trim()).filter(Boolean),
      );

      const dikecualikan = new Set(SENGAJA_TIDAK_DITULIS[nama] ?? []);

      const hilang = def.kolom
        .map((k) => k.ke)
        // Nama berawalan garis bawah adalah nilai bantu untuk resolusi relasi
        // (mis. _supplier_kode), bukan kolom basis data.
        .filter((k) => k && !k.startsWith('_'))
        .filter((k) => !ditulis.has(k) && !dikecualikan.has(k));

      assert.deepEqual(
        hilang, [],
        `kolom ini terpetakan tetapi TIDAK ikut ditulis: ${hilang.join(', ')}. `
        + 'Tambahkan ke pernyataan INSERT, atau daftarkan di '
        + 'SENGAJA_TIDAK_DITULIS beserta alasannya.',
      );
    });
  }

  test('daftar pengecualian tidak menyembunyikan kolom yang tidak dikenal', () => {
    /*
     * Pengecualian yang nama kolomnya sudah tidak ada lagi berarti daftar itu
     * pernah dipakai untuk membungkam kegagalan, lalu tertinggal. Ia harus
     * ikut gagal supaya dibersihkan.
     */
    for (const [nama, kolom] of Object.entries(SENGAJA_TIDAK_DITULIS)) {
      const dikenal = new Set(LIST[nama].kolom.map((k) => k.ke));
      for (const k of kolom) {
        assert.ok(
          dikenal.has(k),
          `${nama}: "${k}" ada di SENGAJA_TIDAK_DITULIS tetapi bukan kolom terpetakan`,
        );
      }
    }
  });
});
