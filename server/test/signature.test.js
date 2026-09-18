/**
 * Uji tanda tangan digital operator (migrasi 034) - kolom Paraf Halaman 1
 * form GMP, pengganti QR.
 *
 * Tiga lapis: (1) layanan simpan/hapus/cek-nya sendiri; (2) endpoint HTTP
 * self-service (SELALU milik operator yang login, tidak ada parameter id);
 * (3) penegakan wajibnya - receiving.buat() menolak sebelum data apa pun
 * tersimpan bila operatornya belum punya tanda tangan.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';
import { buatApp } from '../src/app.js';
import { buatAccessToken } from '../src/auth/tokens.js';
import { shiftPada } from '../src/auth/shift.js';

let receiving;
let signature;
let QRCode;

const W = (hari, jam, menit = 0) => new Date(2026, 7, hari, jam, menit);

let server;
let alamat;
function url(path) { return `http://127.0.0.1:${alamat.port}${path}`; }
const tokenUntuk = (a) => buatAccessToken(
  { id: a.id, kode: a.kode, nama: a.nama, role: a.role }, { shift: shiftPada() },
);
const authHeader = (a) => ({ Authorization: `Bearer ${tokenUntuk(a)}` });

before(async () => {
  await bangunBasisDataUji();
  receiving = await import('../src/services/receiving.js');
  signature = await import('../src/services/signature.js');
  QRCode = (await import('qrcode')).default;

  const app = buatApp(pino({ level: 'silent' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  alamat = server.address();
});

beforeEach(reset);
after(async () => {
  await new Promise((r) => server.close(r));
  await tutup();
});

async function pngUji() {
  return QRCode.toBuffer('uji-tanda-tangan', { type: 'png', width: 20 });
}

describe('Layanan simpanTandaTangan/hapus/punya', () => {
  test('menyimpan PNG sah, punyaTandaTangan jadi true', async () => {
    await signature.hapusTandaTangan(AKTOR.operator.id);
    assert.equal(await signature.punyaTandaTangan(AKTOR.operator.id), false);

    await signature.simpanTandaTangan(AKTOR.operator.id, await pngUji());
    assert.equal(await signature.punyaTandaTangan(AKTOR.operator.id), true);
  });

  test('menolak buffer kosong', async () => {
    await assert.rejects(
      () => signature.simpanTandaTangan(AKTOR.operator.id, Buffer.alloc(0)),
      /tidak boleh kosong/,
    );
  });

  test('menolak yang bukan PNG sah', async () => {
    await assert.rejects(
      () => signature.simpanTandaTangan(AKTOR.operator.id, Buffer.from('bukan png sama sekali')),
      /bukan gambar PNG/,
    );
  });

  test('hapusTandaTangan mengosongkan kembali', async () => {
    await signature.simpanTandaTangan(AKTOR.operator.id, await pngUji());
    assert.equal(await signature.punyaTandaTangan(AKTOR.operator.id), true);

    await signature.hapusTandaTangan(AKTOR.operator.id);
    assert.equal(await signature.punyaTandaTangan(AKTOR.operator.id), false);
    assert.equal(await signature.ambilTandaTangan(AKTOR.operator.id), null);
  });

  test('menyimpan lagi MENIMPA yang lama, bukan menambah', async () => {
    await signature.simpanTandaTangan(AKTOR.operator.id, await pngUji());
    const kedua = await QRCode.toBuffer('yang kedua', { type: 'png', width: 30 });
    await signature.simpanTandaTangan(AKTOR.operator.id, kedua);

    const tersimpan = await signature.ambilTandaTangan(AKTOR.operator.id);
    assert.ok(tersimpan.equals(kedua), 'yang tersimpan adalah versi terbaru');
  });

  test('pastikanPunyaTandaTangan menolak SIGNATURE_REQUIRED bila belum ada', async () => {
    await signature.hapusTandaTangan(AKTOR.operator.id);
    await assert.rejects(
      () => signature.pastikanPunyaTandaTangan(AKTOR.operator.id),
      (err) => err.code === 'SIGNATURE_REQUIRED',
    );
  });

  test('pastikanPunyaTandaTangan lolos bila sudah ada', async () => {
    await signature.simpanTandaTangan(AKTOR.operator.id, await pngUji());
    await assert.doesNotReject(() => signature.pastikanPunyaTandaTangan(AKTOR.operator.id));
  });
});

describe('Endpoint /api/v1/auth/signature - SELALU milik sendiri', () => {
  test('GET tanpa tanda tangan -> ada:false', async () => {
    await signature.hapusTandaTangan(AKTOR.operator.id);
    const res = await fetch(url('/api/v1/auth/signature'), { headers: authHeader(AKTOR.operator) });
    assert.equal(res.status, 200);
    const { ada, gambar } = await res.json();
    assert.equal(ada, false);
    assert.equal(gambar, null);
  });

  test('POST menyimpan, GET sesudahnya mengembalikan ada:true + data URL', async () => {
    const png = await pngUji();
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

    const simpan = await fetch(url('/api/v1/auth/signature'), {
      method: 'POST',
      headers: { ...authHeader(AKTOR.operator), 'Content-Type': 'application/json' },
      body: JSON.stringify({ gambar: dataUrl }),
    });
    assert.equal(simpan.status, 200);

    const lihat = await fetch(url('/api/v1/auth/signature'), { headers: authHeader(AKTOR.operator) });
    const { ada, gambar } = await lihat.json();
    assert.equal(ada, true);
    assert.equal(gambar, dataUrl);
  });

  test('POST menolak yang bukan data URL PNG', async () => {
    const res = await fetch(url('/api/v1/auth/signature'), {
      method: 'POST',
      headers: { ...authHeader(AKTOR.operator), 'Content-Type': 'application/json' },
      body: JSON.stringify({ gambar: 'bukan-data-url' }),
    });
    assert.equal(res.status, 400);
  });

  test('DELETE menghapus tanda tangan', async () => {
    await signature.simpanTandaTangan(AKTOR.operator.id, await pngUji());
    const hapus = await fetch(url('/api/v1/auth/signature'), {
      method: 'DELETE', headers: authHeader(AKTOR.operator),
    });
    assert.equal(hapus.status, 200);
    assert.equal(await signature.punyaTandaTangan(AKTOR.operator.id), false);
  });

  test('tanpa login -> 401', async () => {
    const res = await fetch(url('/api/v1/auth/signature'));
    assert.equal(res.status, 401);
  });

  test('milik SPV tidak terusik saat operator mengatur miliknya sendiri', async () => {
    await signature.simpanTandaTangan(AKTOR.spv.id, await pngUji());
    await fetch(url('/api/v1/auth/signature'), {
      method: 'POST',
      headers: { ...authHeader(AKTOR.operator), 'Content-Type': 'application/json' },
      body: JSON.stringify({ gambar: `data:image/png;base64,${(await pngUji()).toString('base64')}` }),
    });
    assert.equal(await signature.punyaTandaTangan(AKTOR.spv.id), true, 'milik SPV tidak ikut berubah');
  });
});

describe('receiving.buat() TIDAK mewajibkan tanda tangan (dicabut 2026-09-18)', () => {
  // Sempat mewajibkan tanda tangan sebelum submit Receiving (BR baru saat
  // migrasi 034 dibuat), tapi ini memblokir operasional operator yang belum
  // sempat membuat tanda tangannya - dicabut di hari yang sama fitur ini
  // dirilis ke production. formExcel.js tetap menangani ketiadaan tanda
  // tangan dengan baik (sel Paraf kosong, bukan galat) - lihat
  // approvalShare.test.js.
  test('berhasil walau operator belum punya tanda tangan', async () => {
    await signature.hapusTandaTangan(AKTOR.operator.id);
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, nilaiTs: 12.4, finishTime: W(10, 6) },
      AKTOR.operator, IP_UJI,
    );
    assert.ok(rcv.id);
  });

  test('berhasil juga begitu operator sudah punya tanda tangan', async () => {
    await signature.simpanTandaTangan(AKTOR.operator.id, await pngUji());
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 1000, beratJenis: 1, nilaiTs: 12.4, finishTime: W(10, 6) },
      AKTOR.operator, IP_UJI,
    );
    assert.ok(rcv.id);
  });
});
