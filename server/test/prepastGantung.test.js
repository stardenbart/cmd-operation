/**
 * Uji integrasi: Prepast menggantung bila data proses belum lengkap.
 *
 * Selain Waktu Selesai, kini Flowrate / Temp After Heater / Temp Output yang
 * kosong juga membuat record menggantung (is_gantung), sehingga belum dapat
 * disetujui dan tampil di "Perlu dilengkapi" (BR-23).
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;

const SILO_SATU = 2;
const W = (jam, menit = 0) => new Date(2026, 7, 10, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
});

beforeEach(reset);
after(tutup);

async function buatBatch(vol = 1000) {
  const r = await receiving.buat(
    { supplierId: 1, qtyKg: vol, beratJenis: 1, nilaiTs: 12.4, finishTime: W(6) },
    AKTOR.operator, IP_UJI,
  );
  return r.id;
}

async function isGantung(id) {
  const [b] = await pool.query('SELECT is_gantung FROM prepast_record WHERE id = ?', [id]);
  return Boolean(b[0].is_gantung);
}

const dasar = (receivingId) => ({
  receivingId,
  pecahan: [{ siloId: SILO_SATU, volumeLtr: 1000 }],
  prepastStart: W(7),
  prepastFinish: W(8),
  flowrate: 5.5,
  tempAfterHeater: 86,
  tempOutput: 4,
});

describe('Prepast gantung karena data proses tak lengkap', () => {
  test('lengkap semua -> tidak menggantung', async () => {
    const rid = await buatBatch();
    const res = await prepast.buat(dasar(rid), AKTOR.operator, IP_UJI);
    assert.equal(res.gantung, false);
    assert.equal(await isGantung(res.dibuat[0].id), false);
  });

  test('flowrate kosong -> menggantung', async () => {
    const rid = await buatBatch();
    const { flowrate, ...tanpaFlow } = dasar(rid);
    const res = await prepast.buat(tanpaFlow, AKTOR.operator, IP_UJI);
    assert.equal(res.gantung, true);
    assert.equal(await isGantung(res.dibuat[0].id), true);
  });

  test('temp after heater kosong -> menggantung', async () => {
    const rid = await buatBatch();
    const { tempAfterHeater, ...tanpaTah } = dasar(rid);
    const res = await prepast.buat(tanpaTah, AKTOR.operator, IP_UJI);
    assert.equal(res.gantung, true);
  });

  test('temp output kosong -> menggantung', async () => {
    const rid = await buatBatch();
    const { tempOutput, ...tanpaTout } = dasar(rid);
    const res = await prepast.buat(tanpaTout, AKTOR.operator, IP_UJI);
    assert.equal(res.gantung, true);
  });

  test('waktu selesai kosong -> menggantung (perilaku lama tetap)', async () => {
    const rid = await buatBatch();
    const { prepastFinish, ...tanpaFinish } = dasar(rid);
    const res = await prepast.buat(tanpaFinish, AKTOR.operator, IP_UJI);
    assert.equal(res.gantung, true);
  });
});
