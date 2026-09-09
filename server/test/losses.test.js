/**
 * Uji integrasi Losses Management - FR-35.
 *
 * Master 27 titik losses + versioning: setiap perubahan volume/satuan/aktif
 * men-snapshot konfigurasi (BR-28) agar laporan historis tetap akurat.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let losses;

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  losses = await import('../src/services/losses.js');
});
beforeEach(reset);
after(tutup);

async function idLoss(kode) {
  const [b] = await pool.query('SELECT id FROM loss_point WHERE kode = ?', [kode]);
  return b[0].id;
}

describe('FR-35 - losses setting', () => {
  test('T-52: seed menghasilkan 27 loss point dengan data benar', async () => {
    const { data } = await losses.daftar();
    assert.equal(data.length, 27);
    const lp07 = data.find((d) => d.kode === 'LP-07');
    assert.equal(lp07.nama, 'Dorongan Awal Silo 7 -> Silo 25A');
    assert.equal(Number(lp07.volume_liter), 45);
    assert.equal(lp07.kategori, 'prepast');
    assert.equal(lp07.satuan, 'per_transfer');
    assert.equal(lp07.calculation_type, 'fixed_per_frequency_prepast');
  });

  test('T-57: LP-01 di-seed aktif = false', async () => {
    const { data } = await losses.daftar();
    assert.equal(Boolean(data.find((d) => d.kode === 'LP-01').aktif), false);
  });

  test('daftar dikelompokkan per kategori sesuai urutan proses', async () => {
    const { perKategori } = await losses.daftar();
    assert.deepEqual(
      perKategori.map((g) => g.kategori),
      ['receiving', 'prepast', 'switching', 'buffer', 'penarikan'],
    );
  });

  test('T-53: toggle aktif menghasilkan snapshot versi baru (27 titik)', async () => {
    const id = await idLoss('LP-05');
    const [sebelum] = await pool.query('SELECT COUNT(*) n FROM loss_point_version');
    await losses.sunting(id, { aktif: false }, AKTOR.admin, IP_UJI);
    const [sesudah] = await pool.query('SELECT COUNT(*) n FROM loss_point_version');
    assert.equal(Number(sesudah[0].n), Number(sebelum[0].n) + 1);
    const [v] = await pool.query('SELECT snapshot FROM loss_point_version ORDER BY id DESC LIMIT 1');
    const snap = typeof v[0].snapshot === 'string' ? JSON.parse(v[0].snapshot) : v[0].snapshot;
    assert.equal(snap.length, 27);
  });

  test('T-54: sunting volume menghasilkan snapshot versi baru', async () => {
    const id = await idLoss('LP-22');
    await losses.sunting(id, { volume_liter: 30.5 }, AKTOR.admin, IP_UJI);
    const [v] = await pool.query('SELECT COUNT(*) n FROM loss_point_version');
    assert.equal(Number(v[0].n), 1);
    const [b] = await pool.query('SELECT volume_liter FROM loss_point WHERE id = ?', [id]);
    assert.equal(Number(b[0].volume_liter), 30.5);
  });

  test('sunting nama saja TIDAK memicu versi baru', async () => {
    const id = await idLoss('LP-24');
    await losses.sunting(id, { nama: 'Penarikan Silo 1 (rev)' }, AKTOR.admin, IP_UJI);
    const [v] = await pool.query('SELECT COUNT(*) n FROM loss_point_version');
    assert.equal(Number(v[0].n), 0);
  });

  test('T-55: perubahan loss point tercatat di audit_log', async () => {
    const id = await idLoss('LP-23');
    await losses.sunting(id, { volume_liter: 40 }, AKTOR.admin, IP_UJI);
    const [a] = await pool.query(
      "SELECT action FROM audit_log WHERE entity='loss_point' AND entity_id=? ORDER BY id DESC LIMIT 1",
      [id],
    );
    assert.ok(a[0], 'jejak audit loss_point ada');
    assert.equal(a[0].action, 'UPDATE');
  });

  test('T-56: non-Admin ditolak menyunting loss point', async () => {
    const id = await idLoss('LP-24');
    await assert.rejects(
      () => losses.sunting(id, { aktif: false }, AKTOR.operator, IP_UJI),
      (err) => { assert.match(err.message, /tidak berwenang/i); return true; },
    );
  });

  test('detail memuat riwayat perubahan', async () => {
    const id = await idLoss('LP-26');
    await losses.sunting(id, { volume_liter: 2 }, AKTOR.admin, IP_UJI);
    const d = await losses.detail(id);
    assert.equal(d.kode, 'LP-26');
    assert.ok(Array.isArray(d.riwayat) && d.riwayat.length >= 1);
  });
});
