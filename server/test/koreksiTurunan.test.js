/**
 * Uji integrasi: koreksi prepast yang punya turunan aktif.
 *
 * Turunan (alokasi transfer) dihitung dari VOLUME. Karena itu:
 *  - mengubah flowrate / suhu / waktu (bukan volume) TIDAK diblokir BR-15;
 *  - mengubah volume TETAP diblokir selama masih ada turunan aktif.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let transfer;
let koreksi;

const SILO_SATU = 2;
const W = (jam, menit = 0) => new Date(2026, 7, 10, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  transfer = await import('../src/services/transfer.js');
  ({ koreksi } = await import('../src/services/koreksi.js'));
});

beforeEach(reset);
after(tutup);

/** Buat prepast berisi `volumeLtr` di SILO_SATU, lalu transfer sebagian keluar. */
async function prepastDenganTurunan(volumeLtr = 1000, ambil = 400) {
  const rcv = await receiving.buat(
    { supplierId: 1, qtyKg: volumeLtr, beratJenis: 1, nilaiTs: 12.4, finishTime: W(6) },
    AKTOR.operator, IP_UJI,
  );
  const pst = await prepast.buat(
    {
      receivingId: rcv.id,
      pecahan: [{ siloId: SILO_SATU, volumeLtr }],
      prepastStart: W(7), prepastFinish: W(8),
      flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
    },
    AKTOR.operator, IP_UJI,
  );
  await transfer.buat(
    {
      siloAsalId: SILO_SATU, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: ambil,
      trfTime: W(12), tankId: 1, batchPrefix: 'HRC', batchNomor: 1,
    },
    AKTOR.operator, IP_UJI,
  );
  return pst.dibuat[0].id;
}

describe('Koreksi prepast dengan turunan aktif', () => {
  test('ubah flowrate/suhu (bukan volume) TIDAK diblokir turunan', async () => {
    const id = await prepastDenganTurunan();

    await koreksi(
      'prepast', id,
      { flowrate: 6.1, tempAfterHeater: 88, tempOutput: 5 },
      'Input flowrate, temp output, dan temp after heater',
      AKTOR.operator, IP_UJI,
    );

    const [b] = await pool.query(
      'SELECT flowrate_pst, temp_after_heater, temp_output_prd, vol_prepast_ltr FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(Number(b[0].flowrate_pst), 6.1);
    assert.equal(Number(b[0].temp_after_heater), 88);
    assert.equal(Number(b[0].temp_output_prd), 5);
    // Volume tidak berubah.
    assert.equal(Number(b[0].vol_prepast_ltr), 1000);
    // Alokasi transfer tetap ada (turunan tidak disentuh).
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM transfer_allocation');
    assert.ok(n > 0);
  });

  test('koreksi non-volume TIDAK memunculkan lagi volume yang sudah habis terpakai', async () => {
    // Batch 1000 L dikuras HABIS oleh transfer (sisa 0, CLOSED).
    const id = await prepastDenganTurunan(1000, 1000);

    let [b] = await pool.query(
      'SELECT qty_remaining_ltr, status_fifo FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Number(b[0].qty_remaining_ltr), 0);
    assert.equal(b[0].status_fifo, 'CLOSED');

    // Koreksi hanya flowrate/suhu - sisa harus TETAP 0 dan tetap CLOSED,
    // bukan disetel ulang ke volume penuh (bug yang membuat susu "muncul lagi").
    await koreksi(
      'prepast', id,
      { flowrate: 6.2, tempAfterHeater: 88, tempOutput: 5 },
      'Update flowrate, temp', AKTOR.operator, IP_UJI,
    );

    [b] = await pool.query(
      'SELECT qty_remaining_ltr, status_fifo, flowrate_pst FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Number(b[0].qty_remaining_ltr), 0, 'sisa tetap 0');
    assert.equal(b[0].status_fifo, 'CLOSED', 'tetap CLOSED');
    assert.equal(Number(b[0].flowrate_pst), 6.2, 'flowrate tetap terkoreksi');
  });

  test('ubah volume TETAP diblokir selama ada turunan aktif (BR-15)', async () => {
    const id = await prepastDenganTurunan();
    await assert.rejects(
      koreksi('prepast', id, { volumeLtr: 900 }, 'Ubah volume', AKTOR.operator, IP_UJI),
      (err) => err.code === 'BR-15',
    );
  });
});
