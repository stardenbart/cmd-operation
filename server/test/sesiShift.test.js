/**
 * Sesi berakhir otomatis saat pergantian shift — migrasi 032, auth/shift.js.
 *
 * Shift TIDAK dikendalikan lewat jam mesin sungguhan di sini (rapuh, dan test
 * jadi bergantung kapan ia dijalankan) — melainkan dengan memanipulasi
 * `shift_login` yang tersimpan di refresh_token setelah login yang benar-benar
 * terjadi, mensimulasikan "waktu sudah berlalu ke shift lain" tanpa perlu
 * mengendalikan jam.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { bangunBasisDataUji, reset, tutup, AKTOR, PASSWORD_UJI, IP_UJI } from './bantuan/dbUji.js';
import { buatApp } from '../src/app.js';
import { buatAccessToken } from '../src/auth/tokens.js';
import { shiftPada } from '../src/auth/shift.js';

let pool;
let authService;

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  authService = await import('../src/auth/service.js');
});

beforeEach(reset);
after(tutup);

/** Shift lain yang PASTI berbeda dari shift saat ini — cukup 1, 2, atau 3. */
function shiftLain() {
  const sekarang = shiftPada();
  return (sekarang % 3) + 1;
}

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

describe('login() — shift asal sesi', () => {
  test('shift_login yang tersimpan sama dengan shift saat ini', async () => {
    const hasil = await authService.login({
      username: AKTOR.operator.kode, password: PASSWORD_UJI, ip: IP_UJI,
    });
    assert.ok(hasil.accessToken);

    const [[baris]] = await pool.query(
      'SELECT shift_login FROM refresh_token WHERE operator_id = ? ORDER BY id DESC LIMIT 1',
      [AKTOR.operator.id],
    );
    assert.equal(baris.shift_login, shiftPada());
  });
});

describe('refresh() — ditolak begitu shift berganti', () => {
  test('berhasil selama masih shift yang sama', async () => {
    const login = await authService.login({
      username: AKTOR.operator.kode, password: PASSWORD_UJI, ip: IP_UJI,
    });
    const hasil = await authService.refresh({ refreshToken: login.refreshToken });
    assert.ok(hasil.accessToken);
    assert.ok(hasil.refreshToken);
  });

  test('ditolak begitu shift_login tersimpan berbeda dari shift saat ini', async () => {
    const login = await authService.login({
      username: AKTOR.operator.kode, password: PASSWORD_UJI, ip: IP_UJI,
    });

    // Mensimulasikan "waktu sudah masuk shift lain" — tanpa memindahkan jam
    // sungguhan, cukup ubah apa yang tersimpan sebagai shift asal sesi.
    await pool.query(
      'UPDATE refresh_token SET shift_login = ? WHERE operator_id = ?',
      [shiftLain(), AKTOR.operator.id],
    );

    await assert.rejects(
      () => authService.refresh({ refreshToken: login.refreshToken }),
      (err) => err.code === 'UNAUTHORIZED' && /shift/i.test(err.message),
    );
  });

  test('token yang ditolak karena shift tetap tercabut — tidak bisa dipakai lagi', async () => {
    const login = await authService.login({
      username: AKTOR.operator.kode, password: PASSWORD_UJI, ip: IP_UJI,
    });
    await pool.query(
      'UPDATE refresh_token SET shift_login = ? WHERE operator_id = ?',
      [shiftLain(), AKTOR.operator.id],
    );
    await assert.rejects(() => authService.refresh({ refreshToken: login.refreshToken }));

    // Dicoba lagi dengan token yang SAMA — harus tetap gagal (sudah tercabut
    // saat percobaan pertama), bukan lolos karena "belum pernah dicoba".
    await assert.rejects(() => authService.refresh({ refreshToken: login.refreshToken }));
  });
});

describe('wajibLogin (HTTP) — token dengan shift asal yang beda ditolak tiap request', () => {
  test('token dengan shift saat ini diterima', async () => {
    await denganServer(async (port) => {
      const token = buatAccessToken(
        { id: AKTOR.operator.id, kode: AKTOR.operator.kode, nama: AKTOR.operator.nama, role: AKTOR.operator.role },
        { shift: shiftPada() },
      );
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
    });
  });

  test('token dengan shift BERBEDA ditolak 401, meski tanda tangan & masa berlakunya sah', async () => {
    await denganServer(async (port) => {
      const token = buatAccessToken(
        { id: AKTOR.operator.id, kode: AKTOR.operator.kode, nama: AKTOR.operator.nama, role: AKTOR.operator.role },
        { shift: shiftLain() },
      );
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      assert.equal(res.status, 401);
      assert.match(body.message ?? JSON.stringify(body), /shift/i);
    });
  });

  test('token tanpa klaim shift sama sekali (mis. terbit sebelum fitur ini) ditolak', async () => {
    await denganServer(async (port) => {
      const token = buatAccessToken({
        id: AKTOR.operator.id, kode: AKTOR.operator.kode, nama: AKTOR.operator.nama, role: AKTOR.operator.role,
      });
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 401);
    });
  });
});
