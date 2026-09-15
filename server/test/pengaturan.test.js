/**
 * Pengaturan aplikasi — preferensi global (migrasi 029).
 *
 * Beda dari master data: satu baris tetap, berlaku sama untuk semua orang.
 * Yang diuji di sini: bawaannya benar, cuma Admin yang boleh mengubah (sama
 * seperti wilayah Master Data lain — SPV pun tidak, lihat permissions.js),
 * dan perubahan tercatat di audit.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';
import { buatApp } from '../src/app.js';
import { buatAccessToken } from '../src/auth/tokens.js';
import { shiftPada } from '../src/auth/shift.js';

let pool;
let pengaturan;

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  pengaturan = await import('../src/services/pengaturan.js');
});

beforeEach(reset);
after(tutup);

describe('pengaturan.ambil', () => {
  test('bawaan: tampilkan sisa silo AKTIF', async () => {
    const hasil = await pengaturan.ambil();
    assert.equal(hasil.tampilkanSisaSilo, true);
  });
});

describe('pengaturan.perbarui — wewenang', () => {
  test('Operator ditolak', async () => {
    await assert.rejects(
      () => pengaturan.perbarui({ tampilkan_sisa_silo: false }, AKTOR.operator, IP_UJI),
      (err) => err.code === 'FORBIDDEN',
    );
  });

  test('SPV ditolak — master data & pengaturan global adalah wilayah Admin', async () => {
    await assert.rejects(
      () => pengaturan.perbarui({ tampilkan_sisa_silo: false }, AKTOR.spv, IP_UJI),
      (err) => err.code === 'FORBIDDEN',
    );
  });

  test('Admin berhasil mengubah, tercatat di audit', async () => {
    const hasil = await pengaturan.perbarui(
      { tampilkan_sisa_silo: false }, AKTOR.admin, IP_UJI,
    );
    assert.equal(hasil.tampilkanSisaSilo, false);

    const ulang = await pengaturan.ambil();
    assert.equal(ulang.tampilkanSisaSilo, false);

    const [[audit]] = await pool.query(
      "SELECT actor_id, action FROM audit_log WHERE entity = 'pengaturan_aplikasi' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(audit.actor_id, AKTOR.admin.id);
    assert.equal(audit.action, 'UPDATE');
  });

  test('menyalakan lagi mengembalikan ke semula', async () => {
    await pengaturan.perbarui({ tampilkan_sisa_silo: false }, AKTOR.admin, IP_UJI);
    await pengaturan.perbarui({ tampilkan_sisa_silo: true }, AKTOR.admin, IP_UJI);
    assert.equal((await pengaturan.ambil()).tampilkanSisaSilo, true);
  });
});

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

const token = (aktor) => buatAccessToken({
  id: aktor.id, kode: aktor.kode, nama: aktor.nama, role: aktor.role,
}, { shift: shiftPada() });

describe('rute /api/v1/pengaturan', () => {
  test('GET dapat dibaca Operator (bukan rahasia)', async () => {
    await denganServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/pengaturan`, {
        headers: { Authorization: `Bearer ${token(AKTOR.operator)}` },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.data.tampilkanSisaSilo, true);
    });
  });

  test('PATCH ditolak untuk Operator (403), berhasil untuk Admin', async () => {
    await denganServer(async (port) => {
      const ditolak = await fetch(`http://127.0.0.1:${port}/api/v1/pengaturan`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token(AKTOR.operator)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tampilkanSisaSilo: false }),
      });
      assert.equal(ditolak.status, 403);

      const berhasil = await fetch(`http://127.0.0.1:${port}/api/v1/pengaturan`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token(AKTOR.admin)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tampilkanSisaSilo: false }),
      });
      const body = await berhasil.json();
      assert.equal(berhasil.status, 200, JSON.stringify(body));
      assert.equal(body.data.tampilkanSisaSilo, false);
    });
  });
});
