/** Integrasi Prepast parsial: simpan apa adanya, tagih, lalu lengkapi bertahap. */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let dataList;

const SILO = 2;
const T = (jam, menit = 0) => new Date(2026, 8, 8, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  dataList = await import('../src/services/dataList.js');
});

beforeEach(reset);
after(tutup);

async function buatReceiving() {
  return receiving.buat(
    { supplierId: 1, qtyKg: 1000, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
    AKTOR.operator,
    IP_UJI,
  );
}

describe('Prepast parsial', () => {
  test('nilai yang sudah diisi tetap tersimpan dan field kosong ditagih Dashboard', async () => {
    const rcv = await buatReceiving();
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        tempAfterHeater: 86,
      },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal(hasil.gantung, true);
    assert.deepEqual(hasil.fieldKosong.map((f) => f.key), ['flowrate', 'tempOutput']);

    const id = hasil.dibuat[0].id;
    const [[baris]] = await pool.query(
      `SELECT prepast_finish, flowrate_pst, temp_after_heater, temp_output_prd,
              is_gantung
         FROM prepast_record WHERE id = ?`,
      [id],
    );
    assert.ok(baris.prepast_finish, 'finish yang sudah diisi tidak boleh dibuang');
    assert.equal(baris.flowrate_pst, null);
    assert.equal(Number(baris.temp_after_heater), 86);
    assert.equal(baris.temp_output_prd, null);
    assert.equal(Boolean(baris.is_gantung), true);

    const tagihan = await dataList.gantung(AKTOR.operator);
    assert.deepEqual(tagihan.data[0].fieldKosong.map((f) => f.key), ['flowrate', 'tempOutput']);

    const [[{ jumlahApproval }]] = await pool.query(
      "SELECT COUNT(*) jumlahApproval FROM v_approval_queue WHERE modul = 'prepast' AND id = ?",
      [id],
    );
    assert.equal(jumlahApproval, 0);

    const [[silo]] = await pool.query('SELECT standing_time_anchor FROM silo WHERE id = ?', [SILO]);
    assert.ok(silo.standing_time_anchor, 'anchor dibuat begitu finish tersedia');
  });

  test('dapat dilengkapi bertahap dan baru keluar dari Dashboard setelah lengkap', async () => {
    const rcv = await buatReceiving();
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
        tempAfterHeater: 86,
      },
      AKTOR.operator,
      IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    const sebagian = await prepast.lengkapiDraft(
      id,
      { prepastFinish: T(8) },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal(sebagian.isGantung, true);
    assert.deepEqual(sebagian.fieldKosong.map((f) => f.key), ['flowrate', 'tempOutput']);

    const lengkap = await prepast.lengkapiDraft(
      id,
      { flowrate: 5.2, tempOutput: 7 },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal(lengkap.isGantung, false);
    assert.deepEqual(lengkap.fieldKosong, []);

    const tagihan = await dataList.gantung(AKTOR.operator);
    assert.equal(tagihan.data.length, 0);

    const [[{ jumlahApproval }]] = await pool.query(
      "SELECT COUNT(*) jumlahApproval FROM v_approval_queue WHERE modul = 'prepast' AND id = ?",
      [id],
    );
    assert.equal(jumlahApproval, 1);
  });

  test('operator tidak dapat melengkapi record milik operator lain', async () => {
    const rcv = await buatReceiving();
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
      },
      AKTOR.operator,
      IP_UJI,
    );

    await assert.rejects(
      () => prepast.lengkapiDraft(
        hasil.dibuat[0].id,
        { prepastFinish: T(8) },
        { id: 999, kode: 'LAIN', role: 'Operator' },
        IP_UJI,
      ),
      (err) => err.code === 'FORBIDDEN',
    );
  });

  test('record lama tetap dapat dilengkapi setelah ada Prepast yang lebih baru', async () => {
    const rcvLama = await buatReceiving();
    const lama = await prepast.buat(
      {
        receivingId: rcvLama.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        tempAfterHeater: 86,
      },
      AKTOR.operator,
      IP_UJI,
    );

    const rcvBaru = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, nilaiTs: 12.4, finishTime: T(8, 30) },
      AKTOR.operator,
      IP_UJI,
    );
    await prepast.buat(
      {
        receivingId: rcvBaru.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(9),
        prepastFinish: T(10),
        flowrate: 5,
        tempAfterHeater: 86,
        tempOutput: 7,
      },
      AKTOR.operator,
      IP_UJI,
    );

    const lengkap = await prepast.lengkapiDraft(
      lama.dibuat[0].id,
      { flowrate: 5.2, tempOutput: 7 },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal(lengkap.isGantung, false);
    assert.deepEqual(lengkap.fieldKosong, []);
  });
});
