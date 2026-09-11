/**
 * "Lengkapi Prepast" — silo tambahan (pecahanTambahan).
 *
 * Operator kadang baru menyadari saat melengkapi bahwa batch yang sama perlu
 * dipecah ke lebih dari satu silo — sebelumnya cuma bisa satu silo per
 * record karena "Lengkapi" beroperasi pada satu prepast_record. Sekarang
 * baris tambahan membuat record BARU sekaligus, dalam transaksi yang sama.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;

const SILO = { satu: 2, dua: 3, tiga: 4 };
const T = (jam, menit = 0) => new Date(2026, 8, 8, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
});

beforeEach(reset);
after(tutup);

async function buatReceiving(qtyKg = 5000) {
  return receiving.buat(
    { supplierId: 1, qtyKg, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
    AKTOR.operator, IP_UJI,
  );
}

async function buatDraftKosong(receivingId) {
  const hasil = await prepast.buat(
    { receivingId, pecahan: [{}], prepastStart: T(7) },
    AKTOR.operator, IP_UJI,
  );
  return hasil.dibuat[0].id;
}

describe('Lengkapi Prepast — silo tambahan', () => {
  test('melengkapi volume record utama sekaligus menambah 1 silo lain — satu transaksi', async () => {
    const rcv = await buatReceiving(5000);
    const id = await buatDraftKosong(rcv.id);

    const hasil = await prepast.lengkapiDraft(
      id,
      {
        siloId: SILO.satu,
        volumeLtr: 2000,
        pecahanTambahan: [{ siloId: SILO.dua, volumeLtr: 1500 }],
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.pecahanTambahan.length, 1);
    const idTambahan = hasil.pecahanTambahan[0].id;

    const [[utama]] = await pool.query(
      'SELECT silo_tujuan_id, vol_prepast_ltr FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Number(utama.silo_tujuan_id), SILO.satu);
    assert.equal(Number(utama.vol_prepast_ltr), 2000);

    const [[tambahan]] = await pool.query(
      'SELECT silo_tujuan_id, vol_prepast_ltr, receiving_id, prepast_start FROM prepast_record WHERE id = ?',
      [idTambahan],
    );
    assert.equal(Number(tambahan.silo_tujuan_id), SILO.dua);
    assert.equal(Number(tambahan.vol_prepast_ltr), 1500);
    assert.equal(tambahan.receiving_id, rcv.id);

    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    assert.equal(Number(induk.qty_remaining_ltr), 5000 - 2000 - 1500);

    const [[siloSatu]] = await pool.query(
      'SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?', [SILO.satu],
    );
    const [[siloDua]] = await pool.query(
      'SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?', [SILO.dua],
    );
    assert.equal(Number(siloSatu.vol_aktual_ltr), 2000);
    assert.equal(Number(siloDua.vol_aktual_ltr), 1500);
  });

  test('menambah silo pada pelengkapan TERPISAH, setelah volume utama sudah terkunci sebelumnya', async () => {
    const rcv = await buatReceiving(5000);
    const id = await buatDraftKosong(rcv.id);

    await prepast.lengkapiDraft(
      id, { siloId: SILO.satu, volumeLtr: 2000 }, AKTOR.operator, IP_UJI,
    );

    const hasil = await prepast.lengkapiDraft(
      id,
      { pecahanTambahan: [{ siloId: SILO.dua, volumeLtr: 1000 }] },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.pecahanTambahan.length, 1);
    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    assert.equal(Number(induk.qty_remaining_ltr), 5000 - 2000 - 1000);
  });

  test('baris tambahan boleh gantung (silo tanpa volume, atau sebaliknya)', async () => {
    const rcv = await buatReceiving(5000);
    const id = await buatDraftKosong(rcv.id);

    const hasil = await prepast.lengkapiDraft(
      id,
      {
        siloId: SILO.satu,
        volumeLtr: 2000,
        pecahanTambahan: [{ siloId: SILO.dua }],
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.pecahanTambahan[0].isGantung, true);
    const [[tambahan]] = await pool.query(
      'SELECT silo_tujuan_id, vol_prepast_ltr, is_gantung FROM prepast_record WHERE id = ?',
      [hasil.pecahanTambahan[0].id],
    );
    assert.equal(Number(tambahan.silo_tujuan_id), SILO.dua);
    assert.equal(tambahan.vol_prepast_ltr, null);
    assert.equal(Boolean(tambahan.is_gantung), true);

    // Sisa induk tidak berkurang untuk baris tambahan yang volumenya masih
    // kosong — hanya yang volume utama (2000) yang terpotong.
    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    assert.equal(Number(induk.qty_remaining_ltr), 3000);
  });

  test('total melebihi sisa batch induk ditolak — tidak ada yang tersimpan (atomik)', async () => {
    const rcv = await buatReceiving(3000);
    const id = await buatDraftKosong(rcv.id);

    await assert.rejects(
      () => prepast.lengkapiDraft(
        id,
        {
          siloId: SILO.satu,
          volumeLtr: 2000,
          pecahanTambahan: [{ siloId: SILO.dua, volumeLtr: 1500 }],
        },
        AKTOR.operator, IP_UJI,
      ),
      (err) => err.code === 'BR-06',
    );

    const [[utama]] = await pool.query(
      'SELECT silo_tujuan_id, vol_prepast_ltr FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(utama.silo_tujuan_id, null, 'record utama tidak boleh ikut tersimpan sebagian');
    assert.equal(utama.vol_prepast_ltr, null);

    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    assert.equal(Number(induk.qty_remaining_ltr), 3000, 'sisa induk tidak boleh berubah sama sekali');
  });

  test('silo tambahan sama dengan silo record utama ditolak — FR-29.5', async () => {
    const rcv = await buatReceiving(5000);
    const id = await buatDraftKosong(rcv.id);

    await assert.rejects(
      () => prepast.lengkapiDraft(
        id,
        {
          siloId: SILO.satu,
          volumeLtr: 1000,
          pecahanTambahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        },
        AKTOR.operator, IP_UJI,
      ),
      (err) => err.code === 'FR-29.5',
    );
  });

  test('kapasitas silo tambahan yang terlampaui tetap tersimpan, ditandai — BR-24', async () => {
    // Kapasitas tidak lagi memblokir Prepast (keputusan operasional, sama
    // seperti Pindah Silo) — baris tambahan yang melampaui bahkan batas
    // keras tetap dibuat, hanya ditandai melampaui_kapasitas untuk ditinjau.
    const rcv = await buatReceiving(10000);
    const id = await buatDraftKosong(rcv.id);

    // SILO6 (id 7 di seed) nominal 3.000 L, batas keras 4.000 L.
    const hasil = await prepast.lengkapiDraft(
      id,
      {
        siloId: SILO.satu,
        volumeLtr: 1000,
        pecahanTambahan: [{ siloId: 7, volumeLtr: 4001 }],
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.pecahanTambahan.length, 1);
    assert.equal(hasil.pecahanTambahan[0].melampauiKapasitas, true);

    const [[tambahan]] = await pool.query(
      'SELECT silo_tujuan_id, vol_prepast_ltr, melampaui_kapasitas FROM prepast_record WHERE id = ?',
      [hasil.pecahanTambahan[0].id],
    );
    assert.equal(Number(tambahan.silo_tujuan_id), 7);
    assert.equal(Number(tambahan.vol_prepast_ltr), 4001);
    assert.equal(Boolean(tambahan.melampaui_kapasitas), true);
  });
});
