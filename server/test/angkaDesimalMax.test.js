/**
 * angkaDesimal({ max }) — BR-11-nya galat 500.
 *
 * Bug nyata: DECIMAL(6,2) di database (temp_after_heater, temp_output_prd,
 * ph_check, dst.) punya batas atas, tapi validasi Zod sebelum ini cuma
 * memeriksa `min` dan jumlah desimal. Salah ketik satu digit tambahan
 * (mis. "123412" alih-alih "12,3412") lolos ke server dan ditolak MySQL
 * sebagai "Out of range value" — galat mentah 500 ke operator, bukan pesan
 * yang jelas. `max` menutup celah itu di lapis validasi.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { z } from 'zod';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let angkaDesimal;
let angkaDesimalOpsional;
let pool;
let receiving;
let prepast;
let buatApp;
let buatAccessToken;
let shiftPada;

const T = (jam, menit = 0) => new Date(2026, 8, 8, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ angkaDesimal, angkaDesimalOpsional } = await import('../src/middleware/validasi.js'));
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  ({ buatApp } = await import('../src/app.js'));
  ({ buatAccessToken } = await import('../src/auth/tokens.js'));
  ({ shiftPada } = await import('../src/auth/shift.js'));
});

beforeEach(reset);
after(tutup);

describe('angkaDesimal — opsi max', () => {
  test('menerima nilai tepat pada batas', () => {
    const hasil = angkaDesimal({ min: 0, max: 9999.99, maxDecimals: 2 }).safeParse('9999,99');
    assert.equal(hasil.success, true);
    assert.equal(hasil.data, 9999.99);
  });

  test('menolak nilai yang melebihi batas', () => {
    const hasil = angkaDesimal({ min: 0, max: 9999.99, maxDecimals: 2 }).safeParse('123412');
    assert.equal(hasil.success, false);
    assert.match(hasil.error.issues[0].message, /maksimal 9999\.99/);
  });

  test('tanpa max, nilai besar tetap diterima (perilaku lama tidak berubah)', () => {
    const hasil = angkaDesimal({ min: 0, maxDecimals: 2 }).safeParse('123412');
    assert.equal(hasil.success, true);
  });

  test('angkaDesimalOpsional meneruskan opsi max juga', () => {
    const hasil = angkaDesimalOpsional({ min: 0, max: 9999.99, maxDecimals: 2 }).safeParse('123412');
    assert.equal(hasil.success, false);
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

// Shift dihitung SAAT test berjalan (bukan di-hardcode) — sesi wajibLogin()
// memeriksa shift token terhadap shift saat ini, lihat auth/shift.js.
const tokenOperator = () => buatAccessToken({
  id: AKTOR.operator.id,
  kode: AKTOR.operator.kode,
  nama: AKTOR.operator.nama,
  role: AKTOR.operator.role,
}, { shift: shiftPada() });

describe('Reproduksi bug: Temp Output melebihi kolom DECIMAL(6,2)', () => {
  test('ditolak sebagai 400 VALIDATION_ERROR, bukan 500 INTERNAL_ERROR', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
      AKTOR.operator, IP_UJI,
    );
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: 2, volumeLtr: 1000 }],
        prepastStart: T(7),
      },
      AKTOR.operator, IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    await denganServer(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/prepast/${id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenOperator()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prepastFinish: T(8).toISOString(),
          flowrate: 5.2,
          tempAfterHeater: 86,
          tempOutput: 123412,
        }),
      });

      const body = await res.json();
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.ok(
        body.details?.some((d) => d.field === 'tempOutput' && /maksimal/.test(d.pesan)),
        JSON.stringify(body),
      );
    });

    // Record tidak boleh tersentuh sama sekali — validasi ditolak sebelum
    // masuk ke lapis service.
    const [[baris]] = await pool.query(
      'SELECT temp_output_prd FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(baris.temp_output_prd, null);
  });
});
