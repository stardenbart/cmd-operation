/** Integrasi Receiving: Berat Jenis dan Total Solid boleh kosong, dilengkapi bertahap. */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let dataList;
let approval;

const SILO = 2;
const T = (jam, menit = 0) => new Date(2026, 8, 8, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  dataList = await import('../src/services/dataList.js');
  approval = await import('../src/services/approval.js');
});

beforeEach(reset);
after(tutup);

async function volumeBuffer() {
  const [[baris]] = await pool.query(
    `SELECT COALESCE(v.vol_aktual_ltr, 0) AS vol
       FROM silo s LEFT JOIN v_silo_volume v ON v.silo_id = s.id
      WHERE s.is_buffer = TRUE`,
  );
  return Number(baris.vol);
}

describe('Receiving — Berat Jenis dan Total Solid opsional', () => {
  test('disimpan tanpa Berat Jenis maupun Total Solid -> gantung, belum masuk buffer', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal(rcv.berat_jenis, null);
    assert.equal(rcv.qty_ltr, null);
    assert.equal(rcv.qty_remaining_ltr, null);
    assert.equal(Boolean(rcv.is_gantung), true);
    assert.equal(await volumeBuffer(), 0);

    const [[{ jumlah }]] = await pool.query(
      "SELECT COUNT(*) jumlah FROM v_approval_queue WHERE modul = 'receiving' AND id = ?",
      [rcv.id],
    );
    assert.equal(jumlah, 0);
  });

  test('disimpan dengan Berat Jenis tapi tanpa Total Solid -> volume masuk buffer, tetap gantung', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal(Number(rcv.qty_ltr), 1000);
    assert.equal(Number(rcv.qty_remaining_ltr), 1000);
    assert.equal(rcv.nilai_ts, null);
    assert.equal(Boolean(rcv.is_gantung), true);
    assert.equal(await volumeBuffer(), 1000);

    const [[{ jumlah }]] = await pool.query(
      "SELECT COUNT(*) jumlah FROM v_approval_queue WHERE modul = 'receiving' AND id = ?",
      [rcv.id],
    );
    assert.equal(jumlah, 0, 'record gantung tidak boleh masuk antrean approval');
  });

  test('melengkapi Berat Jenis menghitung volume tepat sekali, lalu Total Solid membuka approval', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 2050, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal(await volumeBuffer(), 0);

    const hanyaBj = await receiving.lengkapiDraft(
      rcv.id, { beratJenis: 1.025 }, AKTOR.operator, IP_UJI,
    );
    assert.equal(hanyaBj.isGantung, true);
    assert.deepEqual(hanyaBj.fieldKosong.map((f) => f.key), ['nilaiTs']);
    assert.equal(Number(hanyaBj.qtyLtr), 2000);

    const [[setelahBj]] = await pool.query(
      'SELECT qty_ltr, qty_remaining_ltr FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(Number(setelahBj.qty_ltr), 2000);
    assert.equal(Number(setelahBj.qty_remaining_ltr), 2000);
    assert.equal(await volumeBuffer(), 2000, 'volume masuk buffer begitu Berat Jenis tersedia');

    const [[{ jumlahSebelum }]] = await pool.query(
      "SELECT COUNT(*) jumlahSebelum FROM v_approval_queue WHERE modul = 'receiving' AND id = ?",
      [rcv.id],
    );
    assert.equal(jumlahSebelum, 0, 'Total Solid masih kosong -> belum masuk antrean approval');

    const lengkap = await receiving.lengkapiDraft(
      rcv.id, { nilaiTs: 12.4 }, AKTOR.operator, IP_UJI,
    );
    assert.equal(lengkap.isGantung, false);
    assert.deepEqual(lengkap.fieldKosong, []);
    assert.equal(await volumeBuffer(), 2000, 'volume tidak boleh bertambah dua kali');

    const [[{ jumlahSesudah }]] = await pool.query(
      "SELECT COUNT(*) jumlahSesudah FROM v_approval_queue WHERE modul = 'receiving' AND id = ?",
      [rcv.id],
    );
    assert.equal(jumlahSesudah, 1);
  });

  test('Berat Jenis yang sudah tersimpan tidak dapat ditimpa lewat pelengkapan', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    await assert.rejects(
      () => receiving.lengkapiDraft(rcv.id, { beratJenis: 2 }, AKTOR.operator, IP_UJI),
      (err) => err.code === 'BERAT_JENIS_ALREADY_SET',
    );
  });

  test('Total Solid yang sudah tersimpan tidak dapat ditimpa lewat pelengkapan', async () => {
    // Berat Jenis sengaja dibiarkan kosong supaya record tetap gantung
    // (lengkapiDraft menolak record yang sudah lengkap sepenuhnya) — yang
    // diuji di sini murni penjagaan atas Total Solid yang sudah terisi.
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, nilaiTs: 12.4, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    await assert.rejects(
      () => receiving.lengkapiDraft(rcv.id, { nilaiTs: 13 }, AKTOR.operator, IP_UJI),
      (err) => err.code === 'TOTAL_SOLID_ALREADY_SET',
    );
  });

  test('operator lain tidak dapat melengkapi Receiving milik operator lain', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    await assert.rejects(
      () => receiving.lengkapiDraft(
        rcv.id, { beratJenis: 1 }, { id: 999, kode: 'LAIN', role: 'Operator' }, IP_UJI,
      ),
      (err) => err.code === 'FORBIDDEN',
    );
  });

  test('muncul di Perlu dilengkapi (Dashboard) dan hilang setelah lengkap', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    const tagihan = await dataList.gantung(AKTOR.operator);
    const baris = tagihan.data.find((d) => d.modul === 'receiving' && Number(d.id) === rcv.id);
    assert.ok(baris, 'receiving gantung harus ikut ditagih di Perlu dilengkapi');
    assert.deepEqual(baris.fieldKosong.map((f) => f.key), ['beratJenis', 'nilaiTs']);

    await receiving.lengkapiDraft(rcv.id, { beratJenis: 1, nilaiTs: 12.4 }, AKTOR.operator, IP_UJI);

    const setelah = await dataList.gantung(AKTOR.operator);
    assert.equal(
      setelah.data.some((d) => d.modul === 'receiving' && Number(d.id) === rcv.id),
      false,
    );
  });

  test('Data List menandai baris receiving gantung dan mengizinkan tombol Lengkapi', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    const hasil = await dataList.daftar('receiving', {}, AKTOR.operator);
    const baris = hasil.data.find((b) => Number(b.id) === rcv.id);
    assert.ok(baris);
    assert.equal(baris.isDraft, true);
    assert.equal(baris.bolehLengkapi, true);
  });

  test('filter bjKosong hanya menampilkan Receiving yang Berat Jenis-nya kosong', async () => {
    const tanpaBj = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    // Gantung juga (TS kosong) tapi BJ-nya SUDAH ada — tidak boleh ikut.
    const denganBj = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(7) },
      AKTOR.operator,
      IP_UJI,
    );

    const hasil = await dataList.daftar('receiving', { bjKosong: true }, AKTOR.operator);
    const id = hasil.data.map((b) => Number(b.id));
    assert.ok(id.includes(tanpaBj.id));
    assert.equal(id.includes(denganBj.id), false);
  });

  test('Total Solid yang dilengkapi belakangan diteruskan ke Prepast anak yang masih kosong', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal(rcv.nilai_ts, null);

    const hasilPrepast = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        flowrate: 5.2,
        tempAfterHeater: 86,
        tempOutput: 7,
      },
      AKTOR.operator,
      IP_UJI,
    );
    const idAnak = hasilPrepast.dibuat[0].id;

    const [[anakSebelum]] = await pool.query(
      'SELECT nilai_ts FROM prepast_record WHERE id = ?',
      [idAnak],
    );
    assert.equal(anakSebelum.nilai_ts, null);

    const lengkap = await receiving.lengkapiDraft(
      rcv.id, { nilaiTs: 12.4 }, AKTOR.operator, IP_UJI,
    );
    assert.equal(lengkap.isGantung, false);

    const [[anakSesudah]] = await pool.query(
      'SELECT nilai_ts FROM prepast_record WHERE id = ?',
      [idAnak],
    );
    assert.equal(Number(anakSesudah.nilai_ts), 12.4);
  });

  test('record gantung ditolak saat approval, lengkap setelah dilengkapi', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );

    await assert.rejects(
      () => approval.setujui('receiving', rcv.id, AKTOR.spv, IP_UJI),
      (err) => err.code === 'BR-23',
    );

    await receiving.lengkapiDraft(rcv.id, { beratJenis: 1, nilaiTs: 12.4 }, AKTOR.operator, IP_UJI);

    await approval.setujui('receiving', rcv.id, AKTOR.spv, IP_UJI);
    const [[disetujui]] = await pool.query(
      'SELECT status_approval FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(disetujui.status_approval, 'Approved');
  });
});
