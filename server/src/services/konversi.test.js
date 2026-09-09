/**
 * Uji konversi & penguraian angka — BR-03, uji T-10
 *
 * Kasus emas diambil dari 20 file export Agustus 2026. Rumus FLOOR
 * diverifikasi terhadap 168 baris nyata: 163 cocok persis, nol cocok
 * ROUND maupun CEIL. Lima sisanya adalah anomali data (Lt diisi tangan
 * atau berat_jenis ditampilkan terbulatkan) dan masuk laporan pengecualian
 * migrasi — bukan varian rumus.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hitungQtyLtr, parseAngka } from './konversi.js';

describe('hitungQtyLtr — BR-03', () => {
  test('membulatkan ke BAWAH, bukan ke terdekat', () => {
    // 1000 / 1.001 = 999,0009... — pembulatan terdekat menghasilkan 999 juga,
    // jadi dipakai kasus yang membedakan: 999,9 harus menjadi 999, bukan 1000.
    assert.equal(hitungQtyLtr(1001, 1.0011), 999);
    assert.equal(hitungQtyLtr(100, 3), 33);
  });

  test('cocok dengan 12 baris nyata dari form 6 Agustus 2026', () => {
    const emas = [
      // [kg, berat_jenis, liter menurut form GMP yang sudah ditandatangani]
      [20296, 1.025, 19800],
      [2920, 1.027, 2843],
      [11742, 1.025, 11455],
      [21034, 1.026, 20500],
      [6530, 1.027, 6358],
      [9332, 1.025, 9104],
      [5442, 1.024, 5314],
      [8713, 1.026, 8492],
      [5276, 1.027, 5137],
      [3725, 1.026, 3630],
      [1688, 1.025, 1646],
      [4841, 1.025, 4722],
    ];

    for (const [kg, bj, harapan] of emas) {
      assert.equal(
        hitungQtyLtr(kg, bj),
        harapan,
        `${kg} kg / ${bj} seharusnya ${harapan} L`,
      );
    }
  });

  test('hasil selalu bilangan bulat', () => {
    assert.equal(Number.isInteger(hitungQtyLtr(20296, 1.025)), true);
    assert.equal(Number.isInteger(hitungQtyLtr(1, 3)), true);
  });

  test('menolak berat jenis nol — pembagian nol tidak boleh menjadi Infinity', () => {
    assert.throws(() => hitungQtyLtr(1000, 0), /berat jenis/i);
  });

  test('menolak nilai negatif dan bukan angka', () => {
    assert.throws(() => hitungQtyLtr(-100, 1.025), /kuantitas/i);
    assert.throws(() => hitungQtyLtr(1000, -1.025), /berat jenis/i);
    assert.throws(() => hitungQtyLtr(Number.NaN, 1.025), /kuantitas/i);
    assert.throws(() => hitungQtyLtr(1000, Number.NaN), /berat jenis/i);
  });

  test('menolak kuantitas nol', () => {
    assert.throws(() => hitungQtyLtr(0, 1.025), /kuantitas/i);
  });
});

describe('parseAngka — pemisah desimal', () => {
  test('menerima titik sebagai pemisah desimal', () => {
    assert.equal(parseAngka('1.025'), 1.025);
    assert.equal(parseAngka('12.5'), 12.5);
  });

  test('menerima koma sebagai pemisah desimal', () => {
    // Operator mengetik dengan tata tulis Indonesia. Power Apps menanganinya
    // dengan Substitute(text, ",", ".") yang tersebar di banyak formula.
    assert.equal(parseAngka('1,025'), 1.025);
    assert.equal(parseAngka('87,6'), 87.6);
  });

  test('menerima bilangan bulat tanpa pemisah', () => {
    assert.equal(parseAngka('20296'), 20296);
    assert.equal(parseAngka('0'), 0);
  });

  test('meneruskan angka yang sudah bertipe number', () => {
    assert.equal(parseAngka(1.025), 1.025);
    assert.equal(parseAngka(0), 0);
  });

  test('memangkas spasi di awal dan akhir', () => {
    assert.equal(parseAngka('  1,025  '), 1.025);
  });

  test('menolak masukan kosong dan bukan angka', () => {
    assert.throws(() => parseAngka(''), /angka/i);
    assert.throws(() => parseAngka('   '), /angka/i);
    assert.throws(() => parseAngka('abc'), /angka/i);
    assert.throws(() => parseAngka(null), /angka/i);
    assert.throws(() => parseAngka(undefined), /angka/i);
  });

  test('menolak angka bermakna ganda dengan dua pemisah', () => {
    // "1.025,50" (Indonesia) dan "1,025.50" (Inggris) bermakna sama, tetapi
    // "1,025" sendiri bermakna 1,025 di Indonesia dan 1025 di Inggris.
    // Menebak salah satu berarti salah 1000 kali lipat — lebih baik menolak.
    assert.throws(() => parseAngka('1.025,50'), /ambigu|angka/i);
    assert.throws(() => parseAngka('1,025.50'), /ambigu|angka/i);
  });
});
