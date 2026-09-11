/**
 * Uji rute skema transfer - regresi tujuan kosong dari form.
 *
 * Form Transfer menyimpan siloTujuanId dan tankId dalam satu state, dan
 * mengirim keduanya apa adanya. Untuk PEMAKAIAN PRODUKSI, siloTujuanId ikut
 * terkirim sebagai string kosong; untuk PINDAH SILO, tankId yang kosong.
 * Sebelum diperbaiki, z.coerce mengubah '' menjadi 0 lalu .positive()
 * menolaknya - "Number must be greater than 0" - pada field yang justru tidak
 * relevan untuk jenis itu (terlihat di produksi: gagal "siloTujuanId").
 *
 * DB tidak disentuh: yang diuji lapis SKEMA. Permintaan yang benar bentuknya
 * lolos skema lalu gagal lebih dalam; yang diuji di sini adalah field mana yang
 * ditolak skema, bukan hasil akhirnya.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { buatApp } from '../app.js';
import { buatAccessToken } from '../auth/tokens.js';

async function denganServer(kerja) {
  const app = buatApp(pino({ level: 'silent' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    return await kerja(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const tokenOperator = () =>
  buatAccessToken({ id: 2, kode: 'OP', nama: 'Operator', role: 'Operator' });

const kirimTransfer = (port, body) =>
  fetch(`http://127.0.0.1:${port}/api/v1/transfer`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenOperator()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

const kirimTransferBatch = (port, body) =>
  fetch(`http://127.0.0.1:${port}/api/v1/transfer/batch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenOperator()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

const fields = (body) => (body.error?.details ?? body.details ?? []).map((d) => d.field);

test('PEMAKAIAN PRODUKSI: siloTujuanId kosong tidak lagi ditolak sebagai ">0"', async () => {
  await denganServer(async (port) => {
    // Persis payload form saat jenis PEMAKAIAN PRODUKSI: siloTujuanId=''.
    // tankId sengaja dikosongkan agar permintaan berhenti di skema (bukan DB),
    // sehingga superRefine-lah satu-satunya yang menolak.
    const res = await kirimTransfer(port, {
      siloAsalId: 2,
      jenis: 'PEMAKAIAN PRODUKSI',
      volumeLtr: 200,
      tankId: '',
      siloTujuanId: '',
      batchPrefix: '',
      batchNomor: '',
    });
    assert.equal(res.status, 400);
    const bidang = fields(await res.json());
    // Yang wajib untuk jenis ini adalah tankId - itu yang boleh muncul.
    assert.ok(bidang.includes('tankId'), `harus menuntut tankId, dapat: ${bidang}`);
    // siloTujuanId kosong TIDAK boleh lagi jadi alasan penolakan.
    assert.ok(!bidang.includes('siloTujuanId'), `siloTujuanId tak boleh ditolak, dapat: ${bidang}`);
  });
});

test('PINDAH SILO: tankId kosong tidak lagi ditolak sebagai ">0"', async () => {
  await denganServer(async (port) => {
    const res = await kirimTransfer(port, {
      siloAsalId: 2,
      jenis: 'PINDAH SILO',
      volumeLtr: 200,
      tankId: '',
      siloTujuanId: '',
      batchPrefix: '',
      batchNomor: '',
    });
    assert.equal(res.status, 400);
    const bidang = fields(await res.json());
    assert.ok(bidang.includes('siloTujuanId'), `harus menuntut siloTujuanId, dapat: ${bidang}`);
    assert.ok(!bidang.includes('tankId'), `tankId tak boleh ditolak, dapat: ${bidang}`);
  });
});

test('batch MANUAL: waktu wajib di setiap baris transfer', async () => {
  await denganServer(async (port) => {
    const res = await kirimTransferBatch(port, {
      modeBatch: 'MANUAL',
      baris: [
        {
          trfTime: '2026-09-10T12:00:00+07:00',
          siloAsalId: 2,
          jenis: 'PEMAKAIAN PRODUKSI',
          volumeLtr: 200,
          tankId: 1,
          batchPrefix: 'HRC',
          batchNomor: 1,
        },
        {
          siloAsalId: 3,
          jenis: 'PEMAKAIAN PRODUKSI',
          volumeLtr: 200,
          tankId: 1,
          batchPrefix: 'HRC',
          batchNomor: 2,
        },
      ],
    });

    assert.equal(res.status, 400);
    assert.deepEqual(fields(await res.json()), ['baris.1.trfTime']);
  });
});

test('batch SAMA: waktu bersama wajib di tingkat request', async () => {
  await denganServer(async (port) => {
    const res = await kirimTransferBatch(port, {
      modeBatch: 'SAMA',
      batchBersama: { batchPrefix: 'HRC', batchNomor: 1 },
      baris: [
        {
          siloAsalId: 2,
          jenis: 'PEMAKAIAN PRODUKSI',
          volumeLtr: 200,
          tankId: 1,
        },
      ],
    });

    assert.equal(res.status, 400);
    assert.deepEqual(fields(await res.json()), ['trfTime']);
  });
});
