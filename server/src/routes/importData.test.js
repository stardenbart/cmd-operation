import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import JSZip from 'jszip';
import { buatApp } from '../app.js';
import { buatAccessToken } from '../auth/tokens.js';
import { shiftPada } from '../auth/shift.js';

test('route pratinjau Import terpasang dan menolak paket kosong secara terstruktur', async (t) => {
  const app = buatApp(pino({ level: 'silent' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const token = buatAccessToken({
    id: 1, kode: 'ADMIN', nama: 'Administrator', role: 'Admin',
  }, { shift: shiftPada() });
  const zip = await new JSZip().generateAsync({ type: 'nodebuffer' });
  const { port } = server.address();
  const respons = await fetch(`http://127.0.0.1:${port}/api/v1/import/preview`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/zip',
    },
    body: zip,
  });

  assert.equal(respons.status, 422);
  const isi = await respons.json();
  assert.equal(isi.code, 'IMPORT_BERKAS');
});
