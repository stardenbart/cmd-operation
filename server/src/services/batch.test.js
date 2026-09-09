/**
 * Uji bentuk & normalisasi batch — BR-21, uji T-11
 *
 * Kasus uji diambil dari 139 varian penulisan nyata pada 336 pencatatan batch
 * di 20 file export Agustus 2026. Konvensi resmi (CMD2, HRC+nomor, FC+nomor)
 * hanya menutup sekitar separuh data; sisanya memakai INK, FULLFM, SR,
 * posisi angka terbalik, huruf besar-kecil campur, dan spasi menyusup.
 *
 * Batch adalah SATU-SATUNYA kunci penghubung ke modul traceability (D-1).
 * Selama satu batch dapat ditulis empat cara berbeda, penelusuran mustahil.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bentukBatch, normalisasiBatch, batchPindahSilo, PREFIKS_SAH,
  batchUntukTank,
} from './batch.js';

describe('bentukBatch — input baru (BR-21)', () => {
  test('merakit bentuk kanonik dari prefiks dan nomor', () => {
    assert.equal(bentukBatch('HRC', 1), 'HRC1');
    assert.equal(bentukBatch('HRC', 12), 'HRC12');
    assert.equal(bentukBatch('FC', 2), 'FC2');
    assert.equal(bentukBatch('INK', 13), 'INK13');
  });

  test('menerima prefiks huruf kecil dan membesarkannya otomatis', () => {
    // Huruf besar diterapkan sistem, bukan diandalkan pada kedisiplinan operator.
    assert.equal(bentukBatch('hrc', 1), 'HRC1');
    assert.equal(bentukBatch('Fc', 2), 'FC2');
  });

  test('membuang nol di depan pada nomor', () => {
    assert.equal(bentukBatch('HRC', '01'), 'HRC1');
    assert.equal(bentukBatch('HRC', '007'), 'HRC7');
  });

  test('menolak prefiks yang tidak terdaftar', () => {
    assert.throws(() => bentukBatch('XYZ', 1), /prefiks/i);
    assert.throws(() => bentukBatch('', 1), /prefiks/i);
  });

  test('menolak nomor yang bukan angka positif', () => {
    assert.throws(() => bentukBatch('HRC', 0), /nomor/i);
    assert.throws(() => bentukBatch('HRC', -1), /nomor/i);
    assert.throws(() => bentukBatch('HRC', 'abc'), /nomor/i);
  });

  test('CMD2 adalah batch utuh tanpa nomor', () => {
    assert.equal(bentukBatch('CMD2'), 'CMD2');
  });

  test('CMD2 menolak nomor tambahan', () => {
    assert.throws(() => bentukBatch('CMD2', 1), /tanpa nomor/i);
  });
});

describe('normalisasiBatch — data historis', () => {
  test('angka di depan dibalik menjadi bentuk kanonik', () => {
    // 55 dari 336 pencatatan memakai bentuk ini
    assert.deepEqual(normalisasiBatch('1HRC'), { batch: 'HRC1', keterangan: null });
    assert.deepEqual(normalisasiBatch('10hrc'), { batch: 'HRC10', keterangan: null });
    assert.deepEqual(normalisasiBatch('2FC'), { batch: 'FC2', keterangan: null });
  });

  test('bentuk yang sudah kanonik tidak berubah', () => {
    assert.deepEqual(normalisasiBatch('HRC1'), { batch: 'HRC1', keterangan: null });
    assert.deepEqual(normalisasiBatch('INK13'), { batch: 'INK13', keterangan: null });
  });

  test('huruf besar-kecil campur diseragamkan', () => {
    assert.deepEqual(normalisasiBatch('10HRC'), { batch: 'HRC10', keterangan: null });
    assert.deepEqual(normalisasiBatch('Cmd2'), { batch: 'CMD2', keterangan: null });
    assert.deepEqual(normalisasiBatch('CMD2'), { batch: 'CMD2', keterangan: null });
  });

  test('spasi di awal, akhir, dan tengah dibuang', () => {
    assert.deepEqual(normalisasiBatch('10hrc '), { batch: 'HRC10', keterangan: null });
    assert.deepEqual(normalisasiBatch(' 3 fc'), { batch: 'FC3', keterangan: null });
    assert.deepEqual(normalisasiBatch('Hrc 4'), { batch: 'HRC4', keterangan: null });
  });

  test('nol di depan dibuang', () => {
    assert.deepEqual(normalisasiBatch('01hrc'), { batch: 'HRC1', keterangan: null });
    assert.deepEqual(normalisasiBatch('02hrc'), { batch: 'HRC2', keterangan: null });
  });

  test('awalan B / B. dibuang', () => {
    // B.13INK, B 9 INK, B11INK — awalan yang tidak konsisten di data
    assert.deepEqual(normalisasiBatch('B.13INK'), { batch: 'INK13', keterangan: null });
    assert.deepEqual(normalisasiBatch('B 9 INK'), { batch: 'INK9', keterangan: null });
    assert.deepEqual(normalisasiBatch('B11INK'), { batch: 'INK11', keterangan: null });
  });

  test('keterangan produk dipisahkan ke field tersendiri', () => {
    // 11ink 240ml, 13 ink (FullFm), 10 fullfm, 14ink full fm
    assert.deepEqual(normalisasiBatch('11ink 240ml'), {
      batch: 'INK11', keterangan: '240ml',
    });
    assert.deepEqual(normalisasiBatch('13 ink (FullFm)'), {
      batch: 'INK13', keterangan: 'FullFm',
    });
  });

  test('INKUBASI dipetakan ke prefiks INK', () => {
    assert.deepEqual(normalisasiBatch('INKUBASI'), { batch: 'INK', keterangan: null });
  });

  test('TF TO <silo> dari sistem diteruskan apa adanya', () => {
    assert.deepEqual(normalisasiBatch('TF TO SILO6'), {
      batch: 'TF TO SILO6', keterangan: null,
    });
    assert.deepEqual(normalisasiBatch('TF TO SILO25A'), {
      batch: 'TF TO SILO25A', keterangan: null,
    });
  });

  test('FULLFM sebagai PREFIKS tidak dikira keterangan', () => {
    // Ditemukan saat menguji terhadap 336 nilai nyata: logika pemisah
    // keterangan "full fm" salah memakan prefiks FULLFM yang sah.
    assert.deepEqual(normalisasiBatch('10 fullfm'), { batch: 'FULLFM10', keterangan: null });
    assert.deepEqual(normalisasiBatch('11 fullfm '), { batch: 'FULLFM11', keterangan: null });
  });

  test('ukuran yang menempel pada prefiks tetap terpisah', () => {
    // "10 ink240ml" — tidak ada batas kata antara INK dan 240
    assert.deepEqual(normalisasiBatch('10 ink240ml'), { batch: 'INK10', keterangan: '240ml' });
    assert.deepEqual(normalisasiBatch('11 ink240ml'), { batch: 'INK11', keterangan: '240ml' });
  });

  test('INKUBASI bernomor dipetakan ke INK bernomor', () => {
    assert.deepEqual(normalisasiBatch('Inkubasi1'), { batch: 'INK1', keterangan: null });
    assert.deepEqual(normalisasiBatch('INKUBASI2'), { batch: 'INK2', keterangan: null });
  });

  test('nilai tak terpetakan dikembalikan sebagai tak dikenal, bukan ditebak', () => {
    // "7437" muncul sekali di data — jelas salah input. Menebaknya sebagai
    // batch tertentu justru menyamarkan kesalahan; ia harus masuk laporan
    // pengecualian migrasi untuk ditinjau manusia.
    assert.deepEqual(normalisasiBatch('7437'), { batch: null, keterangan: '7437' });
    assert.deepEqual(normalisasiBatch(''), { batch: null, keterangan: null });
    assert.deepEqual(normalisasiBatch(null), { batch: null, keterangan: null });
  });
});

describe('batchUntukTank — aturan mengikuti tangkinya (BR-21)', () => {
  test('CMD 2 selalu CMD2, prefiks yang dikirim diabaikan', () => {
    assert.equal(batchUntukTank('TETAP_CMD2', 'HRC', '5'), 'CMD2');
    assert.equal(batchUntukTank('TETAP_CMD2', null, null), 'CMD2');
  });

  test('PENGOSONGAN SILO tidak berbatch, dan nilainya NULL bukan string kosong', () => {
    // String kosong akan terbaca sebagai batch bernama "" pada laporan dan
    // ikut terhitung sebagai satu batch tersendiri.
    assert.equal(batchUntukTank('TANPA_BATCH', 'HRC', '5'), null);
    assert.equal(batchUntukTank('TANPA_BATCH', null, null), null);
  });

  test('tangki MT merakit dari prefiks dan nomor', () => {
    assert.equal(batchUntukTank('PILIH', 'HRC', '5'), 'HRC5');
    assert.equal(batchUntukTank('PILIH', 'FC', 7), 'FC7');
  });

  test('tangki MT tanpa prefiks DITOLAK', () => {
    assert.throws(() => batchUntukTank('PILIH', '', ''), /tidak terdaftar/);
  });

  test('aturan yang tidak dikenal DITOLAK, tidak dianggap PILIH', () => {
    // Kolom aturan_batch dapat berisi nilai baru sesudah migrasi berikutnya.
    // Menganggapnya PILIH berarti meminta batch untuk tangki yang mungkin
    // justru tidak boleh berbatch.
    assert.throws(() => batchUntukTank('NGAWUR', 'HRC', '1'), /tidak dikenal/);
  });
});

describe('batchPindahSilo', () => {
  test('dihasilkan sistem dari nama silo tujuan', () => {
    assert.equal(batchPindahSilo('SILO6'), 'TF TO SILO6');
    assert.equal(batchPindahSilo('SILO25A'), 'TF TO SILO25A');
  });

  test('nama silo berspasi dirapatkan agar seragam dengan data lama', () => {
    // Data nyata menulis TF TO SILO6 tanpa spasi
    assert.equal(batchPindahSilo('SILO 6'), 'TF TO SILO6');
  });
});

describe('PREFIKS_SAH', () => {
  test('memuat seluruh prefiks yang muncul di data nyata', () => {
    for (const p of ['HRC', 'FC', 'INK', 'FULLFM', 'SR', 'CMD2']) {
      assert.ok(PREFIKS_SAH.has(p), `prefiks ${p} harus terdaftar`);
    }
  });

  test('TIDAK memuat HC — lapangan memakai HRC (D-13)', () => {
    assert.equal(PREFIKS_SAH.has('HC'), false);
  });
});
