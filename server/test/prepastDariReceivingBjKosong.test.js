/**
 * Integrasi: Prepast dari Receiving yang Berat Jenis-nya belum diisi.
 *
 * Receiving tanpa Berat Jenis belum punya qty_remaining_ltr (volume liter
 * belum dapat dihitung). Operator tetap harus bisa memindahkan susu itu ke
 * silo SEKARANG — Prepast dibuat sebagai draft (silo boleh dipilih, Volume
 * wajib menyusul) dan baru mengambil stok Receiving setelah Berat Jenis-nya
 * dilengkapi.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let voidSvc;

const SILO = 2;
const T = (jam, menit = 0) => new Date(2026, 8, 8, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  voidSvc = await import('../src/services/void.js');
});

beforeEach(reset);
after(tutup);

async function buatReceivingTanpaBj() {
  return receiving.buat(
    { supplierId: 1, qtyKg: 2050, finishTime: T(6) },
    AKTOR.operator,
    IP_UJI,
  );
}

describe('Prepast dari Receiving tanpa Berat Jenis', () => {
  test('Receiving tanpa BJ tetap muncul di antrean buffer Prepast', async () => {
    const rcv = await buatReceivingTanpaBj();
    const antrean = await prepast.antreanBuffer();
    const baris = antrean.find((b) => Number(b.id) === rcv.id);
    assert.ok(baris, 'Receiving tanpa BJ harus tetap muncul di antrean buffer');
    assert.equal(baris.qty_remaining_ltr, null);
  });

  test('Receiving yang sungguh habis (BJ diketahui, sisa 0) tetap tidak muncul', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
      },
      AKTOR.operator,
      IP_UJI,
    );

    const antrean = await prepast.antreanBuffer();
    assert.equal(antrean.some((b) => Number(b.id) === rcv.id), false);
  });

  test('Prepast dapat dibuat sebagai draft (silo boleh, volume wajib kosong); Receiving tidak berubah', async () => {
    const rcv = await buatReceivingTanpaBj();

    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO }],
        prepastStart: T(7),
      },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal(hasil.totalLtr, 0);
    assert.equal(hasil.sisaBatchIndukLtr, null);
    assert.equal(hasil.gantung, true);

    const id = hasil.dibuat[0].id;
    const [[anak]] = await pool.query(
      'SELECT silo_tujuan_id, vol_prepast_ltr, qty_remaining_ltr, is_gantung FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(Number(anak.silo_tujuan_id), SILO);
    assert.equal(anak.vol_prepast_ltr, null);
    assert.equal(anak.qty_remaining_ltr, null);
    assert.equal(Boolean(anak.is_gantung), true);

    // Receiving induk tidak boleh tersentuh sama sekali — masih gantung,
    // masih ACTIVE, bukan ditutup seolah-olah habis.
    const [[induk]] = await pool.query(
      'SELECT berat_jenis, qty_remaining_ltr, status_fifo, buffer_status, is_gantung FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(induk.berat_jenis, null);
    assert.equal(induk.qty_remaining_ltr, null);
    assert.equal(induk.status_fifo, 'ACTIVE');
    assert.equal(induk.buffer_status, 'IN_BUFFER');
    assert.equal(Boolean(induk.is_gantung), true);
  });

  test('mengisi Volume langsung saat membuat Prepast ditolak — BERAT_JENIS_BELUM_DIISI', async () => {
    const rcv = await buatReceivingTanpaBj();

    await assert.rejects(
      () => prepast.buat(
        {
          receivingId: rcv.id,
          pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
          prepastStart: T(7),
        },
        AKTOR.operator,
        IP_UJI,
      ),
      (err) => err.code === 'BERAT_JENIS_BELUM_DIISI',
    );
  });

  test('Berat Jenis Receiving dapat dilengkapi walau sudah punya Prepast turunan (masih gantung tanpa volume)', async () => {
    const rcv = await buatReceivingTanpaBj();
    await prepast.buat(
      { receivingId: rcv.id, pecahan: [{ siloId: SILO }], prepastStart: T(7) },
      AKTOR.operator,
      IP_UJI,
    );

    const lengkap = await receiving.lengkapiDraft(
      rcv.id, { beratJenis: 1.025 }, AKTOR.operator, IP_UJI,
    );
    assert.equal(Number(lengkap.qtyLtr), 2000); // FLOOR(2050 / 1.025)

    const [[indukSesudah]] = await pool.query(
      'SELECT qty_ltr, qty_remaining_ltr FROM receiving WHERE id = ?',
      [rcv.id],
    );
    // Belum ada anak yang mengambil stok apa pun — sisa harus penuh.
    assert.equal(Number(indukSesudah.qty_ltr), 2000);
    assert.equal(Number(indukSesudah.qty_remaining_ltr), 2000);
  });

  test('mengisi Volume Prepast sebelum Berat Jenis Receiving diisi ditolak', async () => {
    const rcv = await buatReceivingTanpaBj();
    const hasil = await prepast.buat(
      { receivingId: rcv.id, pecahan: [{ siloId: SILO }], prepastStart: T(7) },
      AKTOR.operator,
      IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    const konteks = await prepast.konteksPelengkapan(id, AKTOR.operator);
    assert.equal(konteks.bjIndukBelumDiisi, true);

    await assert.rejects(
      () => prepast.lengkapiDraft(id, { volumeLtr: 1000 }, AKTOR.operator, IP_UJI),
      (err) => err.code === 'RECEIVING_BJ_BELUM_DIISI',
    );
  });

  test('alur penuh: draft dibuat -> BJ dilengkapi -> Volume Prepast dilengkapi -> sisa Receiving berkurang', async () => {
    const rcv = await buatReceivingTanpaBj();
    // Data proses lain sengaja lengkap di sini — yang belum tersedia hanya
    // Volume, supaya isGantung yang diuji murni mencerminkan status Volume,
    // bukan tercampur dengan field proses lain yang memang belum diisi.
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO }],
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

    await receiving.lengkapiDraft(rcv.id, { beratJenis: 1.025 }, AKTOR.operator, IP_UJI);

    const konteks = await prepast.konteksPelengkapan(id, AKTOR.operator);
    assert.equal(konteks.bjIndukBelumDiisi, false);

    const lengkap = await prepast.lengkapiDraft(
      id, { volumeLtr: 1200 }, AKTOR.operator, IP_UJI,
    );
    assert.equal(lengkap.isGantung, false);

    const [[anak]] = await pool.query(
      'SELECT vol_prepast_ltr, qty_remaining_ltr FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(Number(anak.vol_prepast_ltr), 1200);

    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(Number(induk.qty_remaining_ltr), 2000 - 1200);

    const [[volumeSilo]] = await pool.query(
      'SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?',
      [SILO],
    );
    assert.equal(Number(volumeSilo.vol_aktual_ltr), 1200);
  });
});

describe('Void — record gantung tanpa volume sama sekali', () => {
  // Bug nyata yang ditemukan lewat pengujian manual: tandaiVoid() memaksa
  // qty_remaining_ltr = 0 tanpa peduli apakah kolom volumenya sendiri masih
  // NULL. Constraint database (migrasi 022/024) menuntut keduanya sama-sama
  // NULL atau sama-sama terisi, sehingga percobaan lama gagal dengan
  // "Check constraint 'ck_pst_remaining' is violated." — bukan ditolak rapi
  // sebagai BusinessError, melainkan 500 mentah.

  test('void tunggal atas Prepast draft (volume masih NULL) tidak melanggar constraint', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    const hasil = await prepast.buat(
      { receivingId: rcv.id, pecahan: [{}], prepastStart: T(7) },
      AKTOR.operator,
      IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    await voidSvc.batalkan('prepast', id, 'uji void draft tanpa volume', AKTOR.spv, IP_UJI);

    const [[baris]] = await pool.query(
      'SELECT status_approval, vol_prepast_ltr, qty_remaining_ltr FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(baris.status_approval, 'VOIDED');
    assert.equal(baris.vol_prepast_ltr, null);
    // Bukan 0 — 0 berarti "volume nyata yang sudah habis", beda dari
    // "tidak pernah punya volume".
    assert.equal(baris.qty_remaining_ltr, null);
  });

  test('void berjenjang Receiving tanpa Berat Jenis + Prepast draft turunannya', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    const hasil = await prepast.buat(
      { receivingId: rcv.id, pecahan: [{}], prepastStart: T(7) },
      AKTOR.operator,
      IP_UJI,
    );
    const idAnak = hasil.dibuat[0].id;

    const dibatalkan = await voidSvc.batalkanBerjenjang(
      'receiving', rcv.id, 'uji void berjenjang tanpa Berat Jenis', AKTOR.spv, IP_UJI,
    );
    assert.equal(dibatalkan.jumlah, 2);

    const [[induk]] = await pool.query(
      'SELECT status_approval, qty_ltr, qty_remaining_ltr FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(induk.status_approval, 'VOIDED');
    assert.equal(induk.qty_ltr, null);
    assert.equal(induk.qty_remaining_ltr, null);

    const [[anak]] = await pool.query(
      'SELECT status_approval, qty_remaining_ltr FROM prepast_record WHERE id = ?',
      [idAnak],
    );
    assert.equal(anak.status_approval, 'VOIDED');
    assert.equal(anak.qty_remaining_ltr, null);
  });

  test('void atas record yang SUDAH punya volume tetap memberi qty_remaining_ltr = 0', async () => {
    // Regresi: perbaikan di atas tidak boleh mengubah perilaku lama untuk
    // record yang volumenya sungguh-sungguh ada.
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    await voidSvc.batalkan('receiving', rcv.id, 'uji void record berisi', AKTOR.spv, IP_UJI);

    const [[baris]] = await pool.query(
      'SELECT qty_ltr, qty_remaining_ltr FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(Number(baris.qty_ltr), 1000);
    assert.equal(Number(baris.qty_remaining_ltr), 0);
  });
});
