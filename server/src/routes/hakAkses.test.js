/**
 * Uji rute hak akses custom - FR-34 (T-48, T-49).
 *
 * Membuktikan bahwa klaim `cp` di JWT benar-benar mengalir sampai middleware
 * otorisasi: endpoint yang dijaga menolak Viewer polos, tetapi menerima Viewer
 * yang diberi hak akses custom yang sesuai. Tidak menyentuh basis data - yang
 * diuji adalah GERBANGNYA; permintaan yang lolos gerbang gagal di validasi
 * (bukan 403), dan itu justru buktinya.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { buatApp } from '../app.js';
import { buatAccessToken } from '../auth/tokens.js';
import { shiftPada } from '../auth/shift.js';

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

const kirim = (port, token) => fetch(`http://127.0.0.1:${port}/api/v1/master/suppliers`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});

test('T-49: Viewer polos ditolak endpoint master:kelola (403)', async () => {
  await denganServer(async (port) => {
    const token = buatAccessToken({ id: 9, kode: 'VW', nama: 'Viewer', role: 'Viewer' }, { shift: shiftPada() });
    const res = await kirim(port, token);
    assert.equal(res.status, 403);
  });
});

test('T-48/T-49: Viewer dengan cp master:kelola LOLOS gerbang (bukan 403)', async () => {
  await denganServer(async (port) => {
    const token = buatAccessToken({
      id: 9, kode: 'VW', nama: 'Viewer', role: 'Viewer',
      custom_permissions: ['master:kelola'],
    }, { shift: shiftPada() });
    const res = await kirim(port, token);
    // Lolos otorisasi; gagal karena body kosong (validasi), BUKAN karena wewenang.
    assert.notEqual(res.status, 403);
  });
});

test('cp yang tidak relevan tetap tidak membuka endpoint lain', async () => {
  await denganServer(async (port) => {
    const token = buatAccessToken({
      id: 9, kode: 'VW', nama: 'Viewer', role: 'Viewer',
      custom_permissions: ['export:jalankan'],
    }, { shift: shiftPada() });
    const res = await kirim(port, token);
    assert.equal(res.status, 403);
  });
});
