/**
 * Uji integrasi transfer multi-baris - beberapa MT dari silo berbeda, satu
 * waktu, satu transaksi (atomik).
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let transfer;

const SILO = { satu: 2, dua: 3 };
const TANK_HRC = { id: 1, prefix: 'HRC' };
const W = (jam, menit = 0) => new Date(2026, 7, 10, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  transfer = await import('../src/services/transfer.js');
});

beforeEach(reset);
after(tutup);

async function isiSilo(siloId, volumeLtr) {
  const rcv = await receiving.buat(
    { supplierId: 1, qtyKg: volumeLtr, beratJenis: 1, nilaiTs: 12.4, finishTime: W(6) },
    AKTOR.operator, IP_UJI,
  );
  await prepast.buat(
    {
      receivingId: rcv.id,
      pecahan: [{ siloId, volumeLtr }],
      prepastStart: W(7), prepastFinish: W(8),
      flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
    },
    AKTOR.operator, IP_UJI,
  );
}

async function volumeSilo(siloId) {
  const [b] = await pool.query('SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?', [siloId]);
  return Number(b[0].vol_aktual_ltr);
}

describe('transfer.buatBanyak', () => {
  test('beberapa baris dari silo berbeda tersimpan sekaligus dengan waktu sama', async () => {
    await isiSilo(SILO.satu, 1000);
    await isiSilo(SILO.dua, 800);

    const hasil = await transfer.buatBanyak(
      {
        trfTime: W(12),
        baris: [
          { siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 400, tankId: TANK_HRC.id, batchPrefix: TANK_HRC.prefix, batchNomor: 1 },
          { siloAsalId: SILO.dua, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 300, tankId: TANK_HRC.id, batchPrefix: TANK_HRC.prefix, batchNomor: 2 },
        ],
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.transfers.length, 2);
    assert.equal(await volumeSilo(SILO.satu), 600);
    assert.equal(await volumeSilo(SILO.dua), 500);

    // Waktu transfernya sama untuk seluruh baris.
    const [baris] = await pool.query(
      'SELECT trf_time FROM transfer WHERE kode IN (?, ?)',
      hasil.transfers.map((t) => t.kode),
    );
    assert.equal(new Date(baris[0].trf_time).getTime(), new Date(baris[1].trf_time).getTime());
  });

  test('atomik - satu baris gagal berarti tidak ada yang tersimpan', async () => {
    await isiSilo(SILO.satu, 1000);
    await isiSilo(SILO.dua, 100);

    await assert.rejects(
      transfer.buatBanyak(
        {
          trfTime: W(12),
          baris: [
            { siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 400, tankId: TANK_HRC.id, batchPrefix: TANK_HRC.prefix, batchNomor: 1 },
            // Melebihi isi silo dua (100 L) -> BR-05, seluruh transaksi batal.
            { siloAsalId: SILO.dua, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 500, tankId: TANK_HRC.id, batchPrefix: TANK_HRC.prefix, batchNomor: 2 },
          ],
        },
        AKTOR.operator, IP_UJI,
      ),
    );

    // Baris pertama TIDAK boleh tersimpan - volume silo satu utuh.
    assert.equal(await volumeSilo(SILO.satu), 1000);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM transfer');
    assert.equal(n, 0);
  });
});
