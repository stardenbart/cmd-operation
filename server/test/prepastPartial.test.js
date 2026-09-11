/** Integrasi Prepast parsial: simpan apa adanya, tagih, lalu lengkapi bertahap. */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';
import { buatApp } from '../src/app.js';
import { buatAccessToken } from '../src/auth/tokens.js';

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

async function denganServer(kerja) {
  const app = buatApp(pino({ level: 'silent' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await kerja(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const tokenOperator = () => buatAccessToken({
  id: AKTOR.operator.id,
  kode: AKTOR.operator.kode,
  nama: AKTOR.operator.nama,
  role: AKTOR.operator.role,
});

describe('Prepast parsial', () => {
  test('rute HTTP menerima payload frontend tanpa siloId dan volumeLtr', async () => {
    const rcv = await buatReceiving();

    await denganServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/prepast`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenOperator()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receivingId: rcv.id,
          pecahan: [{}],
          prepastStart: T(7).toISOString(),
        }),
      });

      const body = await res.json();
      assert.equal(res.status, 201, JSON.stringify(body));
      assert.equal(body.data.gantung, true);
      assert.ok(body.data.fieldKosong.some((f) => f.key === 'siloId'));
      assert.ok(body.data.fieldKosong.some((f) => f.key === 'volumeLtr'));

      const id = body.data.dibuat[0].id;
      const [[baris]] = await pool.query(
        `SELECT silo_tujuan_id, vol_prepast_ltr, qty_remaining_ltr, is_gantung
           FROM prepast_record WHERE id = ?`,
        [id],
      );
      assert.equal(baris.silo_tujuan_id, null);
      assert.equal(baris.vol_prepast_ltr, null);
      assert.equal(baris.qty_remaining_ltr, null);
      assert.equal(Boolean(baris.is_gantung), true);

      const [[induk]] = await pool.query(
        'SELECT qty_remaining_ltr FROM receiving WHERE id = ?',
        [rcv.id],
      );
      assert.equal(Number(induk.qty_remaining_ltr), 1000);

      const tagihan = await dataList.gantung(AKTOR.operator);
      assert.ok(tagihan.data.some((item) => (
        Number(item.id) === Number(id)
        && item.fieldKosong.some((f) => f.key === 'siloId')
        && item.fieldKosong.some((f) => f.key === 'volumeLtr')
      )));
    });
  });

  test('silo dan volume boleh sama-sama kosong lalu dilengkapi bertahap', async () => {
    const rcv = await buatReceiving();
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{}],
        prepastStart: T(7),
        prepastFinish: T(8),
        flowrate: 5.2,
        tempAfterHeater: 86,
        tempOutput: 7,
      },
      AKTOR.operator,
      IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    assert.equal(hasil.totalLtr, 0);
    assert.deepEqual(
      hasil.fieldKosong.map((f) => f.key),
      ['siloId', 'volumeLtr'],
    );

    const hanyaSilo = await prepast.lengkapiDraft(
      id,
      { siloId: SILO },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal(hanyaSilo.isGantung, true);
    assert.deepEqual(hanyaSilo.fieldKosong.map((f) => f.key), ['volumeLtr']);

    const [[sebelumVolume]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(Number(sebelumVolume.qty_remaining_ltr), 1000);
    const [[siloSebelum]] = await pool.query(
      `SELECT s.standing_time_anchor, v.vol_aktual_ltr, v.jumlah_batch_aktif
         FROM silo s JOIN v_silo_volume v ON v.silo_id = s.id
        WHERE s.id = ?`,
      [SILO],
    );
    assert.equal(siloSebelum.standing_time_anchor, null);
    assert.equal(Number(siloSebelum.vol_aktual_ltr), 0);
    assert.equal(Number(siloSebelum.jumlah_batch_aktif), 0);

    const lengkap = await prepast.lengkapiDraft(
      id,
      { volumeLtr: 1000 },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal(lengkap.isGantung, false);
    assert.deepEqual(lengkap.fieldKosong, []);

    const [[sesudah]] = await pool.query(
      `SELECT vol_prepast_ltr, qty_remaining_ltr
         FROM prepast_record WHERE id = ?`,
      [id],
    );
    assert.equal(Number(sesudah.vol_prepast_ltr), 1000);
    assert.equal(Number(sesudah.qty_remaining_ltr), 1000);
    const [[indukSesudah]] = await pool.query(
      'SELECT qty_remaining_ltr, buffer_status FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(Number(indukSesudah.qty_remaining_ltr), 0);
    assert.equal(indukSesudah.buffer_status, 'COMPLETED');

    const [[volumeSilo]] = await pool.query(
      `SELECT vol_aktual_ltr, jumlah_batch_aktif
         FROM v_silo_volume WHERE silo_id = ?`,
      [SILO],
    );
    assert.equal(Number(volumeSilo.vol_aktual_ltr), 1000);
    assert.equal(Number(volumeSilo.jumlah_batch_aktif), 1);
    const [[siloSesudah]] = await pool.query(
      'SELECT standing_time_anchor FROM silo WHERE id = ?',
      [SILO],
    );
    assert.equal(new Date(siloSesudah.standing_time_anchor).getTime(), T(8).getTime());
  });

  test('silo tujuan boleh kosong lalu dilengkapi dari Dashboard', async () => {
    const rcv = await buatReceiving();
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ volumeLtr: 1000 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        flowrate: 5.2,
        tempAfterHeater: 86,
        tempOutput: 7,
      },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal(hasil.gantung, true);
    assert.deepEqual(hasil.fieldKosong.map((f) => f.key), ['siloId']);

    const id = hasil.dibuat[0].id;
    const [[sebelum]] = await pool.query(
      'SELECT silo_tujuan_id, is_gantung FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(sebelum.silo_tujuan_id, null);
    assert.equal(Boolean(sebelum.is_gantung), true);

    const tagihan = await dataList.gantung(AKTOR.operator);
    assert.equal(tagihan.data[0].tempat, 'Belum ditentukan');
    assert.deepEqual(tagihan.data[0].fieldKosong.map((f) => f.key), ['siloId']);

    const konteks = await prepast.konteksPelengkapan(id, AKTOR.operator);
    assert.equal(konteks.siloId, null);
    assert.ok(konteks.siloTujuan.some((s) => Number(s.silo_id) === SILO));

    const lengkap = await prepast.lengkapiDraft(
      id,
      { siloId: SILO },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal(lengkap.isGantung, false);
    assert.deepEqual(lengkap.fieldKosong, []);

    const [[sesudah]] = await pool.query(
      'SELECT silo_tujuan_id, is_gantung FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(Number(sesudah.silo_tujuan_id), SILO);
    assert.equal(Boolean(sesudah.is_gantung), false);

    const [[volume]] = await pool.query(
      'SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?',
      [SILO],
    );
    assert.equal(Number(volume.vol_aktual_ltr), 1000);
    const [[silo]] = await pool.query(
      'SELECT standing_time_anchor FROM silo WHERE id = ?',
      [SILO],
    );
    assert.equal(new Date(silo.standing_time_anchor).getTime(), T(8).getTime());
    assert.equal((await dataList.gantung(AKTOR.operator)).data.length, 0);
  });

  test('kapasitas silo diperiksa ketika silo tujuan dilengkapi', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 7000, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ volumeLtr: 7000 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        flowrate: 5.2,
        tempAfterHeater: 86,
        tempOutput: 7,
      },
      AKTOR.operator,
      IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    await assert.rejects(
      () => prepast.lengkapiDraft(id, { siloId: SILO }, AKTOR.operator, IP_UJI),
      (err) => err.code === 'FR-29.7',
    );

    const [[baris]] = await pool.query(
      'SELECT silo_tujuan_id, is_gantung FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(baris.silo_tujuan_id, null);
    assert.equal(Boolean(baris.is_gantung), true);
  });

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
