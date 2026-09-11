/** Kg Receiving belum terkonversi — ringkasan Dashboard Stok tersimpan. */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let dashboardLive;

const T = (jam, menit = 0) => new Date(2026, 8, 8, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  dashboardLive = await import('../src/services/dashboardLive.js');
});

beforeEach(reset);
after(tutup);

describe('kgBelumTerkonversi', () => {
  test('kosong bila tidak ada Receiving tanpa Berat Jenis', async () => {
    await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    const hasil = await dashboardLive.kgBelumTerkonversi();
    assert.equal(hasil.kgBelumTerkonversi, 0);
    assert.equal(hasil.jumlahReceivingBelumTerkonversi, 0);
  });

  test('Receiving tanpa Berat Jenis ikut terhitung', async () => {
    await receiving.buat(
      { supplierId: 1, qtyKg: 1200, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    await receiving.buat(
      { supplierId: 1, qtyKg: 800, finishTime: T(7) },
      AKTOR.operator,
      IP_UJI,
    );
    const hasil = await dashboardLive.kgBelumTerkonversi();
    assert.equal(hasil.kgBelumTerkonversi, 2000);
    assert.equal(hasil.jumlahReceivingBelumTerkonversi, 2);
  });

  test('berkurang begitu Berat Jenis dilengkapi', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1200, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    assert.equal((await dashboardLive.kgBelumTerkonversi()).kgBelumTerkonversi, 1200);

    await receiving.lengkapiDraft(rcv.id, { beratJenis: 1.025 }, AKTOR.operator, IP_UJI);

    const sesudah = await dashboardLive.kgBelumTerkonversi();
    assert.equal(sesudah.kgBelumTerkonversi, 0);
    assert.equal(sesudah.jumlahReceivingBelumTerkonversi, 0);
  });

  test('Receiving VOIDED/REVISED/Rejected dikeluarkan', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1200, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    await pool.query("UPDATE receiving SET status_approval = 'VOIDED' WHERE id = ?", [rcv.id]);

    const hasil = await dashboardLive.kgBelumTerkonversi();
    assert.equal(hasil.kgBelumTerkonversi, 0);
    assert.equal(hasil.jumlahReceivingBelumTerkonversi, 0);
  });

  test('mengalir ke ringkasan siloLive()', async () => {
    await receiving.buat(
      { supplierId: 1, qtyKg: 1500, finishTime: T(6) },
      AKTOR.operator,
      IP_UJI,
    );
    const { ringkasan } = await dashboardLive.siloLive();
    assert.equal(ringkasan.kgBelumTerkonversi, 1500);
    assert.equal(ringkasan.jumlahReceivingBelumTerkonversi, 1);
  });
});
