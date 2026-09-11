/**
 * Uji integrasi kekekalan volume & kapasitas - BR-06, BR-24, BR-14, T-29
 *
 * Aturan-aturan ini TIDAK dapat diuji sebagai fungsi murni. Kapasitas tersisa
 * dibaca dari VIEW, penguncian baris menentukan hasil saat dua operasi
 * bersamaan, dan kekekalan volume hanya berarti bila transaksinya benar-benar
 * commit. Karena itu uji di berkas ini berjalan di atas basis data sungguhan.
 *
 * Invarian yang dijaga: JUMLAH SELURUH VOLUME sebelum sebuah operasi harus
 * sama dengan jumlah setelahnya. Susu tidak muncul dan tidak menghilang; ia
 * hanya berpindah tempat. Setiap kali invarian ini pernah bocor di sistem
 * lama, akibatnya adalah stok yang salah permanen (M-1).
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let transfer;
let voidSvc;

const SILO = { buffer: 1, satu: 2, dua: 3, tiga: 4, enam: 7 };
const SUPPLIER_PERTAMA = 1;

/** Jam kerja tetap: uji tidak boleh bergantung pada saat ia dijalankan. */
const T = (jam, menit = 0) => new Date(2026, 7, 10, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  transfer = await import('../src/services/transfer.js');
  voidSvc = await import('../src/services/void.js');
});

beforeEach(reset);
after(tutup);

/**
 * Total volume seluruh sistem, dalam liter.
 *
 * Sisa batch penerimaan (yang masih di buffer) ditambah sisa batch prepast
 * (yang sudah di silo). Yang sudah ditransfer keluar tidak lagi dihitung
 * karena memang sudah meninggalkan sistem.
 */
async function totalVolume() {
  const [baris] = await pool.query(`
    SELECT
      (SELECT COALESCE(SUM(qty_remaining_ltr), 0) FROM receiving
        WHERE status_approval NOT IN ('VOIDED', 'REVISED', 'Rejected')) AS di_buffer,
      (SELECT COALESCE(SUM(qty_remaining_ltr), 0) FROM prepast_record
        WHERE status_approval NOT IN ('VOIDED', 'REVISED', 'Rejected')) AS di_silo
  `);
  return {
    buffer: Number(baris[0].di_buffer),
    silo: Number(baris[0].di_silo),
    total: Number(baris[0].di_buffer) + Number(baris[0].di_silo),
  };
}

async function volumeSilo(siloId) {
  const [baris] = await pool.query(
    'SELECT vol_aktual_ltr, vol_tersedia_toleransi_ltr FROM v_silo_volume WHERE silo_id = ?',
    [siloId],
  );
  return {
    aktual: Number(baris[0].vol_aktual_ltr),
    sisaSampaiBatasKeras: Number(baris[0].vol_tersedia_toleransi_ltr),
  };
}

/** Penerimaan yang langsung disetujui, sebagai titik awal yang bersih. */
async function terima(qtyKg, beratJenis = 1.03) {
  const hasil = await receiving.buat(
    {
      supplierId: SUPPLIER_PERTAMA,
      qtyKg,
      beratJenis,
      nilaiTs: 12.4,
      finishTime: T(6),
    },
    AKTOR.operator,
    IP_UJI,
  );
  return hasil;
}

async function prepastKe(receivingId, pecahan) {
  return prepast.buat(
    {
      receivingId,
      pecahan,
      prepastStart: T(8),
      prepastFinish: T(9),
      flowrate: 10000,
      tempAfterHeater: 85,
      tempOutput: 4,
    },
    AKTOR.operator,
    IP_UJI,
  );
}

describe('BR-03 — konversi kg ke liter memakai FLOOR', () => {
  test('volume tercatat adalah kg dibagi berat jenis, dibulatkan ke bawah', async () => {
    const hasil = await terima(3725, 1.026);

    // 3725 / 1,026 = 3630,6...  Form yang ditandatangani mencatat 3630,
    // bukan 3631. Pembulatan ke atas akan mengklaim susu yang tidak ada.
    const [baris] = await pool.query('SELECT qty_ltr FROM receiving WHERE id = ?', [hasil.id]);
    assert.equal(Number(baris[0].qty_ltr), 3630);
  });
});

describe('BR-06 & BR-24 — kapasitas silo dan toleransinya', () => {
  test('menerima tapi menandai prepast yang melewati batas keras', async () => {
    // SILO6 berkapasitas 3.000 L dengan toleransi 1.000 L, jadi batas
    // kerasnya 4.000 L. Kapasitas tidak lagi memblokir Prepast (keputusan
    // operasional, sama seperti Pindah Silo) — 4.001 L tetap tersimpan,
    // hanya ditandai untuk ditinjau.
    const rcv = await terima(6000, 1);

    const hasil = await prepastKe(rcv.id, [{ siloId: SILO.enam, volumeLtr: 4001 }]);
    assert.equal(hasil.dibuat[0].melampauiKapasitas, true);
    assert.equal(hasil.melampauiNominal[0].melebihiBatasKeras, true);

    const silo = await volumeSilo(SILO.enam);
    assert.equal(silo.aktual, 4001);
    // Sudah melewati batas keras — GREATEST() meng-clamp sisanya ke 0,
    // bukan minus.
    assert.equal(silo.sisaSampaiBatasKeras, 0);
  });

  test('menerima prepast tepat pada batas keras', async () => {
    const rcv = await terima(6000, 1);
    await prepastKe(rcv.id, [{ siloId: SILO.enam, volumeLtr: 4000 }]);

    const silo = await volumeSilo(SILO.enam);
    assert.equal(silo.aktual, 4000);
    assert.equal(silo.sisaSampaiBatasKeras, 0);
  });

  /**
   * Bug yang pernah nyata: `vol_tersedia_ltr` di-clamp ke 0 oleh GREATEST,
   * sehingga silo yang SUDAH melampaui nominal tampak punya toleransi penuh
   * lagi. SILO3 sempat mencapai 7.200 L, dua ratus liter di atas batas keras.
   */
  test('toleransi tidak dihitung dua kali pada silo yang sudah melampaui nominal', async () => {
    const rcv = await terima(8000, 1);

    // SILO3: nominal 6.000, batas keras 7.000. Isi 6.500 dulu, lewat nominal.
    await prepastKe(rcv.id, [{ siloId: SILO.tiga, volumeLtr: 6500 }]);
    assert.equal((await volumeSilo(SILO.tiga)).sisaSampaiBatasKeras, 500);

    // Sisa 500 saja, bukan 1.000 lagi — 501 L HARUS ditandai melampaui
    // batas keras (bukan diterima mentah-mentah seolah toleransi masih
    // utuh 1.000), tapi tetap tersimpan (kapasitas tidak lagi memblokir).
    const hasil = await prepastKe(rcv.id, [{ siloId: SILO.tiga, volumeLtr: 501 }]);
    assert.equal(hasil.dibuat[0].melampauiKapasitas, true);

    const akhir = await volumeSilo(SILO.tiga);
    assert.equal(akhir.aktual, 7001);
    assert.equal(akhir.sisaSampaiBatasKeras, 0);
  });

  test('menolak prepast melebihi sisa batch induk', async () => {
    const rcv = await terima(1000, 1);

    await assert.rejects(
      () => prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1001 }]),
      (err) => {
        // BR-06 adalah soal total melebihi sisa batch induk, bukan soal
        // kapasitas silo: SILO1 masih kosong sepenuhnya.
        assert.equal(err.code, 'BR-06');
        return true;
      },
    );
  });
});

describe('Kekekalan volume', () => {
  test('prepast memindahkan volume, tidak menambah maupun mengurangi', async () => {
    const rcv = await terima(2000, 1);
    const sebelum = await totalVolume();
    assert.equal(sebelum.buffer, 2000);
    assert.equal(sebelum.silo, 0);

    await prepastKe(rcv.id, [
      { siloId: SILO.satu, volumeLtr: 700 },
      { siloId: SILO.dua, volumeLtr: 300 },
    ]);

    const sesudah = await totalVolume();
    assert.equal(sesudah.total, sebelum.total, 'total tidak boleh berubah');
    assert.equal(sesudah.buffer, 1000, 'sisa di buffer berkurang sebesar yang diprepast');
    assert.equal(sesudah.silo, 1000, 'yang masuk silo sama dengan yang keluar buffer');
  });

  test('prepast multi-silo dalam satu input memakai satu sisa batch — FR-29', async () => {
    const rcv = await terima(3000, 1);

    const hasil = await prepastKe(rcv.id, [
      { siloId: SILO.satu, volumeLtr: 1000 },
      { siloId: SILO.dua, volumeLtr: 900 },
      { siloId: SILO.tiga, volumeLtr: 600 },
    ]);

    assert.equal(hasil.dibuat.length, 3);
    assert.equal((await volumeSilo(SILO.satu)).aktual, 1000);
    assert.equal((await volumeSilo(SILO.dua)).aktual, 900);
    assert.equal((await volumeSilo(SILO.tiga)).aktual, 600);

    const [baris] = await pool.query('SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [
      rcv.id,
    ]);
    assert.equal(Number(baris[0].qty_remaining_ltr), 500);
  });

  test('pembatalan berjenjang memulihkan volume ke keadaan semula — BR-14, T-29', async () => {
    const rcv = await terima(1000, 1);
    const awal = await totalVolume();

    const hasilPrepast = await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }]);
    const idPrepast = hasilPrepast.dibuat[0].id;

    await transfer.buat(
      {
        siloAsalId: SILO.satu,
        jenis: 'PEMAKAIAN PRODUKSI',
        volumeLtr: 400,
        trfTime: T(12),
        tankId: 1,
        batchPrefix: 'HRC',
        batchNomor: 1,
      },
      AKTOR.operator,
      IP_UJI,
    );

    const setelahTransfer = await totalVolume();
    assert.equal(setelahTransfer.total, awal.total - 400, '400 L memang keluar sistem');

    // Membatalkan prepast berarti membatalkan transfer yang memakainya.
    // Inilah yang tidak dilakukan Power Apps, dan satu-satunya hal yang
    // menjaga kekekalan volume.
    await voidSvc.batalkanBerjenjang('prepast', idPrepast, 'uji pembatalan berjenjang', AKTOR.spv, IP_UJI);

    const akhir = await totalVolume();
    assert.equal(akhir.total, awal.total, 'volume kembali persis seperti sebelum prepast');
    assert.equal(akhir.buffer, 1000, 'sisa batch induk dipulihkan');
    assert.equal(akhir.silo, 0);
    assert.equal((await volumeSilo(SILO.satu)).aktual, 0, 'silo kembali kosong');
  });

  test('pembatalan satuan DITOLAK bila masih ada turunan aktif — BR-15', async () => {
    const rcv = await terima(1000, 1);
    const hasilPrepast = await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }]);
    const idPrepast = hasilPrepast.dibuat[0].id;

    await transfer.buat(
      {
        siloAsalId: SILO.satu,
        jenis: 'PEMAKAIAN PRODUKSI',
        volumeLtr: 400,
        trfTime: T(12),
        tankId: 1,
        batchPrefix: 'HRC',
        batchNomor: 2,
      },
      AKTOR.operator,
      IP_UJI,
    );

    await assert.rejects(
      () => voidSvc.batalkan('prepast', idPrepast, 'uji guard dependensi', AKTOR.spv, IP_UJI),
      (err) => {
        assert.equal(err.code, 'BR-15');
        // Galat harus MENUNJUKKAN apa yang menghalangi, bukan sekadar menolak:
        // dialog buntu adalah salah satu keluhan utama pada sistem lama.
        assert.ok(err.details?.pohon?.length > 0, 'pohon dependensi harus disertakan');
        return true;
      },
    );

    // Dan tidak ada yang berubah akibat penolakan itu
    assert.equal((await volumeSilo(SILO.satu)).aktual, 600);
  });
});
