/**
 * Uji integrasi tautan publik dashboard.
 *
 * Membuktikan gerbangnya: endpoint publik menolak tanpa token dan dengan token
 * salah, menerima dengan token aktif, dan token yang DICABUT langsung mati.
 * Juga: hanya master:kelola yang boleh mengelola tautan.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { bangunBasisDataUji, tutup, AKTOR } from './bantuan/dbUji.js';
import { buatApp } from '../src/app.js';
import { buatAccessToken } from '../src/auth/tokens.js';
import { shiftPada } from '../src/auth/shift.js';

let server;
let alamat;

function url(path) { return `http://127.0.0.1:${alamat.port}${path}`; }
const tokenUntuk = (a) => buatAccessToken(
  { id: a.id, kode: a.kode, nama: a.nama, role: a.role }, { shift: shiftPada() },
);
const authHeader = (a) => ({ Authorization: `Bearer ${tokenUntuk(a)}` });

before(async () => {
  await bangunBasisDataUji();
  const app = buatApp(pino({ level: 'silent' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  alamat = server.address();
});

after(async () => {
  await new Promise((r) => server.close(r));
  await tutup();
});

describe('Tautan publik dashboard', () => {
  test('publik tanpa token -> 400', async () => {
    const res = await fetch(url('/api/v1/public/dashboard'));
    assert.equal(res.status, 400);
  });

  test('publik dengan token salah -> 403', async () => {
    const res = await fetch(url('/api/v1/public/dashboard?t=tidak-ada'));
    assert.equal(res.status, 403);
  });

  test('operator tidak boleh mengelola tautan -> 403', async () => {
    const res = await fetch(url('/api/v1/dashboard-share/putar'), {
      method: 'POST', headers: authHeader(AKTOR.operator),
    });
    assert.equal(res.status, 403);
  });

  test('admin memutar token, publik menerimanya, lalu cabut mematikannya', async () => {
    // Admin terbitkan token.
    const putar = await fetch(url('/api/v1/dashboard-share/putar'), {
      method: 'POST', headers: authHeader(AKTOR.admin),
    });
    assert.equal(putar.status, 200);
    const { token } = await putar.json();
    assert.ok(token && token.length >= 16, 'token diterbitkan');

    // Publik dengan token aktif -> 200 + bentuk data yang benar.
    const lihat = await fetch(url(`/api/v1/public/dashboard?t=${token}`));
    assert.equal(lihat.status, 200);
    const { data } = await lihat.json();
    assert.ok(Array.isArray(data.silos), 'ada daftar silo');
    assert.ok(data.ringkasan && typeof data.ringkasan.totalVolLtr === 'number', 'ada ringkasan');
    assert.ok(Array.isArray(data.batchAktif), 'ada papan batch aktif');

    // Cabut -> token yang sama tidak lagi berlaku.
    const cabut = await fetch(url('/api/v1/dashboard-share/cabut'), {
      method: 'POST', headers: authHeader(AKTOR.admin),
    });
    assert.equal(cabut.status, 200);

    const setelahCabut = await fetch(url(`/api/v1/public/dashboard?t=${token}`));
    assert.equal(setelahCabut.status, 403);
  });

  test('memutar token menonaktifkan token sebelumnya', async () => {
    const t1 = (await (await fetch(url('/api/v1/dashboard-share/putar'), {
      method: 'POST', headers: authHeader(AKTOR.admin),
    })).json()).token;
    const t2 = (await (await fetch(url('/api/v1/dashboard-share/putar'), {
      method: 'POST', headers: authHeader(AKTOR.admin),
    })).json()).token;

    assert.notEqual(t1, t2);
    assert.equal((await fetch(url(`/api/v1/public/dashboard?t=${t1}`))).status, 403);
    assert.equal((await fetch(url(`/api/v1/public/dashboard?t=${t2}`))).status, 200);
  });
});
