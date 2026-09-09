/**
 * Uji autentikasi - FR-1, migrasi 012
 *
 * Yang diuji di sini bukan "apakah login berhasil", melainkan hal-hal yang
 * kalau salah tidak akan terlihat dari layar: pesan galat yang membocorkan
 * siapa yang punya akun, sesi lama yang selamat setelah password diganti, dan
 * akun hasil migrasi yang terlihat siap dipakai padahal kredensialnya belum
 * pernah diterbitkan.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, PASSWORD_UJI } from './bantuan/dbUji.js';

let pool;
let auth;
let argon2;

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  auth = await import('../src/auth/service.js');
  argon2 = (await import('argon2')).default;
});

/*
 * Kredensial operator uji DIPULIHKAN di tiap uji.
 *
 * `reset()` hanya mengosongkan tabel transaksi; tabel operator adalah master
 * dan sengaja dibiarkan. Uji di berkas ini justru mengubah master itu -
 * mengosongkan password, mengunci akun, menggantinya - sehingga tanpa
 * pemulihan ini kegagalan satu uji merembet menjadi kegagalan palsu di uji
 * berikutnya, dan yang terbaca bukan lagi hal yang sedang diuji.
 */
beforeEach(async () => {
  await reset();
  const hash = await argon2.hash(PASSWORD_UJI, { type: argon2.argon2id });
  await pool.query(
    `UPDATE operator
        SET password_hash = ?, must_change_password = FALSE,
            failed_attempts = 0, locked_until = NULL, is_active = TRUE`,
    [hash],
  );
  await pool.query('DELETE FROM refresh_token');
});
after(async () => { await tutup(); });

describe('Login dengan username dan password', () => {
  test('kredensial benar menghasilkan token dan mencatat jejaknya', async () => {
    const hasil = await auth.login({
      username: AKTOR.operator.kode,
      password: PASSWORD_UJI,
      ip: '10.0.0.1',
    });

    assert.ok(hasil.accessToken);
    assert.ok(hasil.refreshToken);
    assert.equal(hasil.operator.username, AKTOR.operator.kode);
    assert.equal(hasil.mustChangePassword, false);

    const [jejak] = await pool.query(
      "SELECT COUNT(*) n FROM audit_log WHERE action = 'LOGIN_OK' AND actor_id = ?",
      [AKTOR.operator.id],
    );
    assert.equal(Number(jejak[0].n), 1);
  });

  /**
   * Username tidak lagi terpampang di dropdown. Membedakan "username tidak
   * ada" dari "password salah" berarti menyediakan alat untuk menebak siapa
   * saja yang punya akun di sini.
   */
  test('pesan galatnya SAMA untuk username asing dan password salah', async () => {
    const asing = await auth.login({ username: 'tidak-ada', password: 'apa-saja-123' })
      .then(() => null, (e) => e.message);
    const salah = await auth.login({ username: AKTOR.operator.kode, password: 'salah-sekali-123' })
      .then(() => null, (e) => e.message);

    assert.ok(asing, 'username asing ditolak');
    assert.ok(salah, 'password salah ditolak');
    assert.equal(asing, salah);
  });

  /**
   * Seluruh operator hasil migrasi berada di keadaan ini: PIN lama tidak dapat
   * diubah menjadi password, jadi `password_hash` mereka NULL sampai Admin
   * menerbitkannya. argon2.verify() dengan hash null MELEMPAR galat internal,
   * bukan menolak dengan rapi - kalau keadaan ini tidak ditangkap lebih dulu,
   * yang muncul di layar operator adalah galat 500.
   */
  test('akun tanpa password ditolak rapi, bukan dengan galat internal', async () => {
    await pool.query('UPDATE operator SET password_hash = NULL WHERE id = ?', [AKTOR.operator.id]);

    await assert.rejects(
      () => auth.login({ username: AKTOR.operator.kode, password: PASSWORD_UJI }),
      /Username atau password salah/,
    );
  });

  test('akun nonaktif tidak dapat masuk', async () => {
    await pool.query('UPDATE operator SET is_active = FALSE WHERE id = ?', [AKTOR.operator.id]);

    await assert.rejects(
      () => auth.login({ username: AKTOR.operator.kode, password: PASSWORD_UJI }),
      /Username atau password salah/,
    );
  });

  test('percobaan gagal dihitung dan akun terkunci', async () => {
    for (let i = 0; i < 5; i += 1) {
      await auth.login({ username: AKTOR.operator.kode, password: 'salah-sekali-123' })
        .catch(() => {});
    }

    const [baris] = await pool.query(
      'SELECT failed_attempts, locked_until FROM operator WHERE id = ?',
      [AKTOR.operator.id],
    );
    // failed_attempts DIRESET saat penguncian terjadi, jadi yang membuktikan
    // rate limit bekerja adalah locked_until, bukan hitungannya.
    assert.ok(baris[0].locked_until, 'akun dikunci');

    // Password yang BENAR pun ditolak selama terkunci.
    await assert.rejects(
      () => auth.login({ username: AKTOR.operator.kode, password: PASSWORD_UJI }),
      /terkunci/i,
    );
  });
});

describe('Ganti password sendiri', () => {
  test('password baru berlaku, yang lama tidak lagi', async () => {
    await auth.gantiPassword({
      operatorId: AKTOR.operator.id,
      passwordLama: PASSWORD_UJI,
      passwordBaru: 'PasswordBaru99',
    });

    const baru = await auth.login({
      username: AKTOR.operator.kode, password: 'PasswordBaru99',
    });
    assert.ok(baru.accessToken);

    await assert.rejects(
      () => auth.login({ username: AKTOR.operator.kode, password: PASSWORD_UJI }),
      /Username atau password salah/,
    );
  });

  /**
   * Kalau password diganti karena dicurigai bocor, sesi yang sudah berjalan
   * tidak boleh ikut selamat - kalau tidak, penggantian itu tidak mengusir
   * siapa pun.
   */
  test('seluruh sesi lain dicabut', async () => {
    await auth.login({ username: AKTOR.operator.kode, password: PASSWORD_UJI });

    const [sebelum] = await pool.query(
      'SELECT COUNT(*) n FROM refresh_token WHERE operator_id = ? AND revoked_at IS NULL',
      [AKTOR.operator.id],
    );
    assert.equal(Number(sebelum[0].n), 1);

    await auth.gantiPassword({
      operatorId: AKTOR.operator.id,
      passwordLama: PASSWORD_UJI,
      passwordBaru: 'PasswordBaru99',
    });

    const [sesudah] = await pool.query(
      'SELECT COUNT(*) n FROM refresh_token WHERE operator_id = ? AND revoked_at IS NULL',
      [AKTOR.operator.id],
    );
    assert.equal(Number(sesudah[0].n), 0);
  });

  test('password lama yang salah menolak penggantian', async () => {
    await assert.rejects(
      () => auth.gantiPassword({
        operatorId: AKTOR.operator.id,
        passwordLama: 'bukan-yang-benar',
        passwordBaru: 'PasswordBaru99',
      }),
      /Password lama salah/,
    );
  });

  test('password baru yang terlalu pendek, umum, atau sama DITOLAK', async () => {
    const coba = (baru) => auth.gantiPassword({
      operatorId: AKTOR.operator.id,
      passwordLama: PASSWORD_UJI,
      passwordBaru: baru,
    });

    await assert.rejects(() => coba('abc123'), /minimal/i);
    await assert.rejects(() => coba('password'), /umum/i);
    await assert.rejects(() => coba(PASSWORD_UJI), /berbeda/i);
    // Spasi di ujung tidak terlihat saat diketik dan menghasilkan gagal login
    // yang tidak dapat dijelaskan pemiliknya.
    await assert.rejects(() => coba(' PasswordBaru99 '), /spasi/i);
  });

  test('menandai selesai wajib ganti password', async () => {
    await pool.query(
      'UPDATE operator SET must_change_password = TRUE WHERE id = ?',
      [AKTOR.operator.id],
    );

    await auth.gantiPassword({
      operatorId: AKTOR.operator.id,
      passwordLama: PASSWORD_UJI,
      passwordBaru: 'PasswordBaru99',
    });

    const [baris] = await pool.query(
      'SELECT must_change_password FROM operator WHERE id = ?',
      [AKTOR.operator.id],
    );
    assert.equal(Boolean(baris[0].must_change_password), false);
  });
});

describe('Daftar operator tidak lagi dapat diambil tanpa login', () => {
  /**
   * Bukan sekadar "endpointnya dihapus dari router". Fungsi yang masih ada
   * akan dipakai lagi oleh layar berikutnya yang butuh daftar nama.
   */
  test('daftarOperatorAktif() sudah tidak ada di modul auth', () => {
    assert.equal(auth.daftarOperatorAktif, undefined);
  });
});
