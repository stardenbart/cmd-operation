/**
 * Prepast — kapasitas nominal tidak lagi memblokir (BR-24).
 *
 * Keputusan operasional (dikonfirmasi pengguna, September 2026, membalik
 * keputusan sebelumnya — lihat riwayat git): Prepast sekarang melunak
 * dengan cara yang sama persis seperti Pindah Silo
 * (transferKapasitasSoftCap.test.js). Volume yang melampaui bahkan batas
 * keras (kapasitas + toleransi) silo tujuan TETAP tersimpan, hanya ditandai
 * `melampaui_kapasitas` untuk ditinjau SPV/QA — di ketiga jalur yang
 * memakai pecahanSilo.js: buat() langsung, melengkapi record utama, dan
 * menambah silo lain saat melengkapi.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let dataList;

// SILO1 (id 2) — kapasitas nominal 5.000 L, toleransi 1.000 L (batas keras
// 6.000 L). SILO6 (id 7) — nominal 3.000 L, batas keras 4.000 L.
const SILO = { satu: 2, enam: 7 };
const T = (jam, menit = 0) => new Date(2026, 8, 9, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  dataList = await import('../src/services/dataList.js');
});

beforeEach(reset);
after(tutup);

async function terima(qtyKg, beratJenis = 1) {
  return receiving.buat(
    { supplierId: 1, qtyKg, beratJenis, nilaiTs: 12.4, finishTime: T(6) },
    AKTOR.operator, IP_UJI,
  );
}

async function volumeSilo(siloId) {
  const [b] = await pool.query('SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?', [siloId]);
  return Number(b[0].vol_aktual_ltr);
}

describe('Prepast buat() — kapasitas nominal jadi soft cap', () => {
  test('volume yang melebihi bahkan batas keras TETAP tersimpan, bukan ditolak', async () => {
    const rcv = await terima(6001);

    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 6001 }],
        prepastStart: T(7), prepastFinish: T(8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.dibuat[0].melampauiKapasitas, true);
    assert.ok(hasil.melampauiNominal[0]);
    assert.equal(hasil.melampauiNominal[0].melebihiBatasKeras, true);
    assert.equal(hasil.melampauiNominal[0].sisaNominalLtr, 5000);
    assert.equal(hasil.melampauiNominal[0].batasKerasLtr, 6000);

    // Volume sungguh masuk apa adanya — tidak dipotong ke batas keras.
    assert.equal(await volumeSilo(SILO.satu), 6001);

    const [[baris]] = await pool.query(
      'SELECT melampaui_kapasitas FROM prepast_record WHERE id = ?', [hasil.dibuat[0].id],
    );
    assert.equal(Boolean(baris.melampaui_kapasitas), true);
  });

  test('volume lewat nominal tapi masih dalam toleransi: ditandai peringatan, bukan batas keras', async () => {
    const rcv = await terima(5500);

    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 5500 }],
        prepastStart: T(7), prepastFinish: T(8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.dibuat[0].melampauiKapasitas, false);
    assert.ok(hasil.melampauiNominal[0]);
    assert.equal(hasil.melampauiNominal[0].melebihiBatasKeras, false);
  });

  test('volume dalam nominal tidak memicu peringatan sama sekali', async () => {
    const rcv = await terima(3000);

    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 3000 }],
        prepastStart: T(7), prepastFinish: T(8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.dibuat[0].melampauiKapasitas, false);
    assert.deepEqual(hasil.melampauiNominal, []);
  });
});

describe('Prepast lengkapiDraft() — kapasitas nominal jadi soft cap', () => {
  async function buatDraftKosong(receivingId) {
    const hasil = await prepast.buat(
      { receivingId, pecahan: [{}], prepastStart: T(7) },
      AKTOR.operator, IP_UJI,
    );
    return hasil.dibuat[0].id;
  }

  test('melengkapi record utama dengan volume melampaui batas keras tetap tersimpan', async () => {
    const rcv = await terima(6001);
    const id = await buatDraftKosong(rcv.id);

    const hasil = await prepast.lengkapiDraft(
      id, { siloId: SILO.satu, volumeLtr: 6001 }, AKTOR.operator, IP_UJI,
    );
    assert.equal(hasil.melampauiKapasitas, true);

    const [[baris]] = await pool.query(
      'SELECT melampaui_kapasitas FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Boolean(baris.melampaui_kapasitas), true);
  });

  test('penanda tidak direset saat pelengkapan berikutnya tidak menyentuh silo/volume', async () => {
    const rcv = await terima(6001);
    const id = await buatDraftKosong(rcv.id);

    await prepast.lengkapiDraft(id, { siloId: SILO.satu, volumeLtr: 6001 }, AKTOR.operator, IP_UJI);

    // Pelengkapan lanjutan hanya mengisi remarks — silo & volume sudah
    // terkunci dari pelengkapan sebelumnya, tidak ikut divalidasi ulang.
    const hasil = await prepast.lengkapiDraft(
      id, { flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4 }, AKTOR.operator, IP_UJI,
    );
    assert.equal(hasil.melampauiKapasitas, true);

    const [[baris]] = await pool.query(
      'SELECT melampaui_kapasitas FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Boolean(baris.melampaui_kapasitas), true);
  });

  test('silo tambahan yang melampaui batas keras tetap tersimpan, ditandai sendiri', async () => {
    const rcv = await terima(10000);
    const id = await buatDraftKosong(rcv.id);

    const hasil = await prepast.lengkapiDraft(
      id,
      {
        siloId: SILO.satu,
        volumeLtr: 1000,
        pecahanTambahan: [{ siloId: SILO.enam, volumeLtr: 4001 }],
      },
      AKTOR.operator, IP_UJI,
    );

    // Record utama sendiri tidak melampaui apa pun.
    assert.equal(hasil.pecahanTambahan.length, 1);
    assert.equal(hasil.pecahanTambahan[0].melampauiKapasitas, true);

    const [[utama]] = await pool.query(
      'SELECT melampaui_kapasitas FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Boolean(utama.melampaui_kapasitas), false);

    const [[tambahan]] = await pool.query(
      'SELECT silo_tujuan_id, vol_prepast_ltr, melampaui_kapasitas FROM prepast_record WHERE id = ?',
      [hasil.pecahanTambahan[0].id],
    );
    assert.equal(Number(tambahan.silo_tujuan_id), SILO.enam);
    assert.equal(Number(tambahan.vol_prepast_ltr), 4001);
    assert.equal(Boolean(tambahan.melampaui_kapasitas), true);
  });
});

describe('Prepast — melampaui_kapasitas di Data List', () => {
  test('tersimpan dan dapat difilter lewat Data List', async () => {
    const rcv = await terima(6001);
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 6001 }],
        prepastStart: T(7), prepastFinish: T(8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    const daftar = await dataList.daftar('prepast', { lewatKapasitas: true }, AKTOR.operator);
    const baris = daftar.data.find((d) => Number(d.id) === id);
    assert.ok(baris);
    // Badge "Melampaui Nominal" di Data List (sama seperti kartu Silo
    // Dashboard) bergantung pada field camelCase ini.
    assert.equal(baris.melampauiKapasitas, true);

    const detail = await dataList.detail('prepast', id);
    assert.ok(detail.field.some((f) => f.label === 'Kapasitas tujuan'));
  });

  test('prepast normal (tidak melebihi) TIDAK muncul di filter lewatKapasitas', async () => {
    const rcv = await terima(3000);
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 3000 }],
        prepastStart: T(7), prepastFinish: T(8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    const daftar = await dataList.daftar('prepast', { lewatKapasitas: true }, AKTOR.operator);
    assert.equal(daftar.data.some((d) => Number(d.id) === id), false);
  });
});
