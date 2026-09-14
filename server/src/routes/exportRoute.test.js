import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { buatApp } from '../app.js';
import { buatAccessToken } from '../auth/tokens.js';
import { shiftPada } from '../auth/shift.js';

test('route Data Tabel Raw terpasang pada /api/v1/export/download-table', async (t) => {
  const app = buatApp(pino({ level: 'silent' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const token = buatAccessToken({
    id: 1,
    kode: 'ADMIN',
    nama: 'Administrator',
    role: 'Admin',
  }, { shift: shiftPada() });
  const { port } = server.address();

  // Tanpa query tanggal harus berhenti di validasi (400). Jika route tidak
  // terpasang, responsnya akan 404 seperti kegagalan yang terlihat di UI.
  const respons = await fetch(
    `http://127.0.0.1:${port}/api/v1/export/download-table`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  assert.equal(respons.status, 400);
  const isi = await respons.json();
  assert.notEqual(isi.code, 'NOT_FOUND');
});
