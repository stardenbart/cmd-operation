/**
 * Layanan autentikasi — FR-1
 *
 * Perbedaan pokok dari Power Apps: kredensial diverifikasi DI SERVER. Aplikasi
 * lama menarik seluruh daftar operator beserta pin_code-nya ke perangkat lewat
 * `ClearCollect(colOperatorMaster, ...)`, lalu membandingkan plaintext di UI —
 * artinya siapa pun yang membuka aplikasi memegang PIN semua orang (M-7).
 *
 * Sejak migrasi 012, login memakai USERNAME dan PASSWORD, bukan memilih nama
 * dari dropdown lalu mengetik PIN. Dua alasannya:
 *
 *   Dropdown menuntut daftar seluruh operator dikirim ke perangkat SEBELUM
 *   ada yang login. Itu berarti siapa pun yang membuka halaman login tahu
 *   siapa saja yang bekerja di sini — versi yang lebih ringan dari kesalahan
 *   yang sama dengan M-7. `daftarOperatorAktif()` karena itu DIHAPUS, bukan
 *   sekadar tidak dipakai lagi: fungsi yang masih ada akan dipakai lagi.
 *
 *   PIN enam digit hanya punya sejuta kemungkinan dan dalam praktiknya dipilih
 *   dari tanggal lahir atau nomor urut. Yang menahan serangan hanyalah
 *   penguncian setelah lima kali gagal.
 */

import argon2 from 'argon2';
import { pool, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { catatAudit } from '../services/audit.js';
import { UnauthorizedError, AppError } from '../middleware/errors.js';
import {
  buatAccessToken,
  buatRefreshToken,
  hashRefreshToken,
} from './tokens.js';

function terkunci(operator) {
  return operator.locked_until && new Date(operator.locked_until) > new Date();
}

/**
 * Menormalkan kolom JSON `custom_permissions` menjadi array (FR-34).
 * mysql2 biasanya sudah mem-parse kolom JSON, tetapi kolom bisa NULL atau -
 * pada konfigurasi tertentu - berupa string; keduanya diamankan di sini.
 */
function sebagaiArrayAksi(nilai) {
  if (Array.isArray(nilai)) return nilai;
  if (typeof nilai === 'string' && nilai.trim()) {
    try {
      const hasil = JSON.parse(nilai);
      return Array.isArray(hasil) ? hasil : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Mencatat satu percobaan login yang gagal, lalu mengembalikan apakah akun
 * menjadi terkunci.
 *
 * Dijalankan dalam TRANSAKSINYA SENDIRI, terpisah dari alur login.
 *
 * Ini bukan pilihan gaya. Bila pencatatan berada dalam transaksi yang sama
 * dengan alur login, `throw` untuk menolak PIN salah akan me-rollback
 * transaksi itu — sehingga penambahan hitungan gagal dan entri LOGIN_FAILED
 * ikut terhapus, dan rate limit tidak pernah dapat menghitung apa pun.
 *
 * Penambahan dilakukan atomik di dalam SQL (`failed_attempts + 1`), bukan
 * dibaca-lalu-ditulis, agar dua percobaan bersamaan tidak saling menimpa.
 */
async function catatGagal(operator, ip) {
  return withTransaction(async (conn) => {
    // Dua pernyataan, bukan satu UPDATE dengan CASE.
    //
    // Dalam satu UPDATE, MySQL mengevaluasi assignment dari kiri ke kanan dan
    // referensi kolom pada assignment berikutnya melihat nilai yang SUDAH
    // diperbarui. Menggabungkan penambahan dan pengecekan ambang dalam satu
    // pernyataan membuat `failed_attempts + 1` di dalam CASE terbaca sebagai
    // (lama + 1) + 1, sehingga akun terkunci satu percobaan lebih awal.
    //
    // Memisahkannya membuat maksudnya jelas dan tidak bergantung pada urutan
    // evaluasi. Penambahan tetap atomik di dalam SQL, dan keduanya berada di
    // satu transaksi sehingga tidak ada keadaan separuh.
    await conn.query(
      'UPDATE operator SET failed_attempts = failed_attempts + 1 WHERE id = ?',
      [operator.id],
    );

    const [baris] = await conn.query(
      'SELECT failed_attempts FROM operator WHERE id = ?',
      [operator.id],
    );
    const gagal = baris[0].failed_attempts;

    let kunci = null;
    if (gagal >= config.auth.maxAttempts) {
      const [hasil] = await conn.query(
        `UPDATE operator
            SET locked_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE)
          WHERE id = ?`,
        [config.auth.lockoutMinutes, operator.id],
      );
      if (hasil.affectedRows === 1) {
        const [b2] = await conn.query('SELECT locked_until FROM operator WHERE id = ?', [
          operator.id,
        ]);
        kunci = b2[0].locked_until;
      }
    }

    await catatAudit(conn, {
      entity: 'operator',
      entityId: operator.id,
      action: 'LOGIN_FAILED',
      actorId: operator.id,
      after: { failed_attempts: gagal, locked_until: kunci },
      ip,
    });

    return Boolean(kunci);
  });
}

/**
 * Login dengan username + password.
 *
 * @returns {{accessToken, refreshToken, operator, mustChangePassword}}
 */
export async function login({ username, password, userAgent, ip }) {
  const [barisOp] = await pool.query(
    `SELECT id, kode, username, nama_lengkap, password_hash, role, is_active,
            must_change_password, failed_attempts, locked_until, custom_permissions
       FROM operator WHERE username = ?`,
    [String(username ?? '').trim()],
  );
  const operator = barisOp[0];
  if (operator) operator.custom_permissions = sebagaiArrayAksi(operator.custom_permissions);

  /*
   * Satu pesan untuk seluruh sebab kegagalan.
   *
   * Sekarang username tidak lagi terpampang di dropdown, jadi membedakan
   * "username tidak ada" dari "password salah" berarti menyediakan alat untuk
   * menebak siapa saja yang punya akun di sini.
   */
  const gagalUmum = new UnauthorizedError('Username atau password salah');

  if (!operator || !operator.is_active) throw gagalUmum;

  /*
   * Password belum pernah diterbitkan.
   *
   * Ini keadaan seluruh operator hasil migrasi: PIN lama tidak dapat diubah
   * menjadi password, jadi `password_hash` mereka NULL sampai Admin mereset.
   * argon2.verify() dengan hash null akan melempar galat internal, bukan
   * menolak dengan rapi — jadi keadaan ini harus ditangkap lebih dulu.
   */
  if (!operator.password_hash) throw gagalUmum;

  if (terkunci(operator)) {
    throw new AppError(
      `Akun terkunci sampai ${new Date(operator.locked_until).toLocaleTimeString('id-ID')} UTC. ` +
        'Terlalu banyak percobaan gagal.',
      { status: 429, code: 'ACCOUNT_LOCKED' },
    );
  }

  if (!(await argon2.verify(operator.password_hash, String(password)))) {
    // Dicatat di transaksinya sendiri — lihat catatan pada catatGagal()
    const dikunci = await catatGagal(operator, ip);
    if (dikunci) {
      throw new AppError(
        `Password salah. Akun dikunci ${config.auth.lockoutMinutes} menit.`,
        { status: 429, code: 'ACCOUNT_LOCKED' },
      );
    }
    throw gagalUmum;
  }

  return withTransaction(async (conn) => {
    // Berhasil — hitungan gagal direset
    await conn.query(
      'UPDATE operator SET failed_attempts = 0, locked_until = NULL WHERE id = ?',
      [operator.id],
    );

    const refreshToken = buatRefreshToken();
    await conn.query(
      `INSERT INTO refresh_token (operator_id, token_hash, expires_at, user_agent)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY), ?)`,
      [operator.id, hashRefreshToken(refreshToken), userAgent ?? null],
    );

    await catatAudit(conn, {
      entity: 'operator',
      entityId: operator.id,
      action: 'LOGIN_OK',
      actorId: operator.id,
      ip,
    });

    return {
      accessToken: buatAccessToken(operator),
      refreshToken,
      operator: {
        id: operator.id,
        kode: operator.kode,
        username: operator.username,
        nama: operator.nama_lengkap,
        role: operator.role,
        customPermissions: operator.custom_permissions,
      },
      mustChangePassword: Boolean(operator.must_change_password),
    };
  });
}

/** Menukar refresh token dengan access token baru, sekaligus merotasinya. */
export async function refresh({ refreshToken, userAgent }) {
  return withTransaction(async (conn) => {
    const hash = hashRefreshToken(refreshToken ?? '');
    const [baris] = await conn.query(
      `SELECT rt.id, rt.operator_id, o.kode, o.nama_lengkap, o.role, o.is_active,
              o.custom_permissions
         FROM refresh_token rt
         JOIN operator o ON o.id = rt.operator_id
        WHERE rt.token_hash = ?
          AND rt.revoked_at IS NULL
          AND rt.expires_at > UTC_TIMESTAMP()
        FOR UPDATE`,
      [hash],
    );
    const sesi = baris[0];
    if (!sesi || !sesi.is_active) {
      throw new UnauthorizedError('Sesi tidak valid atau telah berakhir');
    }

    // Rotasi: token lama dicabut, token baru diterbitkan. Token yang dicuri
    // hanya berguna sekali, dan pemakaian ulangnya akan gagal.
    await conn.query('UPDATE refresh_token SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [
      sesi.id,
    ]);

    const tokenBaru = buatRefreshToken();
    await conn.query(
      `INSERT INTO refresh_token (operator_id, token_hash, expires_at, user_agent)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY), ?)`,
      [sesi.operator_id, hashRefreshToken(tokenBaru), userAgent ?? null],
    );

    return {
      accessToken: buatAccessToken({
        id: sesi.operator_id,
        kode: sesi.kode,
        nama_lengkap: sesi.nama_lengkap,
        role: sesi.role,
        custom_permissions: sebagaiArrayAksi(sesi.custom_permissions),
      }),
      refreshToken: tokenBaru,
    };
  });
}

export async function logout({ refreshToken }) {
  if (!refreshToken) return;
  await pool.query(
    'UPDATE refresh_token SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND revoked_at IS NULL',
    [hashRefreshToken(refreshToken)],
  );
}

/**
 * Aturan password - dipakai saat ganti sendiri maupun saat Admin mereset.
 *
 * Panjang minimalnya delapan, bukan enam seperti PIN lama, dan justru itu
 * gunanya pindah dari PIN: enam digit angka hanya sejuta kemungkinan.
 *
 * Yang TIDAK dituntut di sini: huruf besar, angka, dan simbol wajib. Aturan
 * semacam itu menghasilkan "Password1!" di mana-mana lalu ditempel di monitor.
 * Yang dituntut hanya panjang dan bukan password yang jelas-jelas umum.
 */
const PASSWORD_UMUM = new Set([
  'password', 'password1', '12345678', '123456789', 'qwerty123',
  'admin123', 'cimory123', 'operator', 'rahasia1',
]);

export function periksaPassword(baru) {
  const p = String(baru ?? '');

  if (p.length < config.auth.passwordMinLength) {
    throw new AppError(
      `Password minimal ${config.auth.passwordMinLength} karakter`,
      { code: 'PASSWORD_TOO_SHORT' },
    );
  }
  if (p.trim() !== p) {
    // Spasi di ujung tidak terlihat saat diketik dan menghasilkan gagal login
    // yang tidak dapat dijelaskan pemiliknya.
    throw new AppError('Password tidak boleh diawali atau diakhiri spasi', {
      code: 'PASSWORD_SPACE',
    });
  }
  if (PASSWORD_UMUM.has(p.toLowerCase())) {
    throw new AppError('Password terlalu umum, pilih yang lain', {
      code: 'PASSWORD_COMMON',
    });
  }
  return p;
}

/**
 * Ganti password sendiri. Wajib dilakukan setelah reset oleh Admin (FR-26.2.5).
 */
export async function gantiPassword({ operatorId, passwordLama, passwordBaru, ip }) {
  periksaPassword(passwordBaru);

  if (String(passwordLama) === String(passwordBaru)) {
    throw new AppError('Password baru harus berbeda dari password lama', {
      code: 'PASSWORD_UNCHANGED',
    });
  }

  return withTransaction(async (conn) => {
    const [baris] = await conn.query(
      'SELECT id, password_hash FROM operator WHERE id = ? FOR UPDATE',
      [operatorId],
    );
    const operator = baris[0];
    if (!operator) throw new UnauthorizedError();
    if (!operator.password_hash) throw new UnauthorizedError('Password lama salah');

    if (!(await argon2.verify(operator.password_hash, String(passwordLama)))) {
      throw new UnauthorizedError('Password lama salah');
    }

    await conn.query(
      `UPDATE operator
          SET password_hash = ?, must_change_password = FALSE
        WHERE id = ?`,
      [await argon2.hash(String(passwordBaru), { type: argon2.argon2id }), operatorId],
    );

    /*
     * Mengganti password mencabut seluruh sesi lain.
     *
     * Bila password diganti karena dicurigai bocor, sesi yang sudah berjalan
     * tidak boleh ikut selamat - kalau tidak, penggantian itu tidak mengusir
     * siapa pun.
     */
    await conn.query(
      'UPDATE refresh_token SET revoked_at = UTC_TIMESTAMP() WHERE operator_id = ? AND revoked_at IS NULL',
      [operatorId],
    );

    await catatAudit(conn, {
      entity: 'operator',
      entityId: operatorId,
      action: 'PIN_RESET',
      actorId: operatorId,
      reason: 'Ganti password oleh pemilik akun',
      ip,
    });
  });
}
