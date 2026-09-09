/**
 * Seed master data — F0-5
 *
 * Menjalankan db/seeds/*.sql, lalu membuat akun Admin pertama.
 *
 * PIN awal dibangkitkan acak dan hanya ditampilkan SEKALI di layar.
 * Ia tidak pernah ditulis ke berkas mana pun — termasuk berkas seed —
 * dan akun ditandai wajib ganti PIN saat login pertama (FR-26.2.5).
 *
 *   node src/db/seed.js
 */

import { pathToFileURL } from 'node:url';
import argon2 from 'argon2';
import { pool } from './pool.js';
import { seed as seedSql } from './migrate.js';
import { bangkitkanPasswordSementara } from '../auth/password.js';

async function buatAdminAwal({ terbitkanUlang = false } = {}) {
  /*
   * Tiga keadaan, dan ketiganya harus ditangani.
   *
   * Sebelumnya fungsi ini hanya mengenal dua: ada Admin, atau tidak ada.
   * Migrasi 012 melahirkan keadaan ketiga - Admin ADA tetapi passwordnya
   * BELUM PERNAH DITERBITKAN, sebab PIN lama tidak dapat diubah menjadi
   * password. Kalau keadaan itu ikut "dilewati", tidak ada satu pun orang yang
   * dapat masuk, termasuk untuk mereset orang lain.
   */
  const [ada] = await pool.query(
    `SELECT id, kode, username, password_hash IS NOT NULL AS punya_password
       FROM operator WHERE role = 'Admin' ORDER BY id LIMIT 1`,
  );

  const adminAda = ada[0];

  /*
   * `--terbitkan-ulang` menerbitkan password baru walau sudah ada.
   *
   * Dipakai ketika passwordnya ADA tetapi tidak seorang pun tahu isinya -
   * termasuk keadaan yang lebih buruk: password yang asal-usulnya tidak dapat
   * dijelaskan. Kredensial semacam itu harus digantikan, bukan dibiarkan
   * karena "toh sudah ada".
   */
  if (adminAda?.punya_password && !terbitkanUlang) {
    console.log(`·  Admin sudah ada (${adminAda.username}) dan sudah berpassword — dilewati`);
    console.log('   Pakai --terbitkan-ulang bila passwordnya tidak diketahui.');
    return;
  }

  const password = bangkitkanPasswordSementara();
  const hash = await argon2.hash(password, { type: argon2.argon2id });

  let username;
  if (adminAda) {
    username = adminAda.username;
    await pool.query(
      `UPDATE operator
          SET password_hash = ?, must_change_password = TRUE,
              failed_attempts = 0, locked_until = NULL
        WHERE id = ?`,
      [hash, adminAda.id],
    );
  } else {
    username = 'ADMIN';
    await pool.query(
      `INSERT INTO operator
         (kode, username, nama_lengkap, password_hash, must_change_password, role, is_active)
       VALUES (?, ?, ?, ?, TRUE, 'Admin', TRUE)`,
      ['ADMIN', username, 'Administrator', hash],
    );
  }

  const judul = adminAda ? 'PASSWORD ADMIN DITERBITKAN' : 'AKUN ADMIN PERTAMA';

  console.log(`
┌────────────────────────────────────────────────┐
│  ${judul.padEnd(45)}│
│                                                │
│    Username : ${username.padEnd(33)}│
│    Password : ${password.padEnd(33)}│
│                                                │
│  Catat sekarang — password ini tidak           │
│  ditampilkan lagi dan wajib diganti saat       │
│  login pertama.                                │
└────────────────────────────────────────────────┘`);
}

/**
 * @param {{adminSaja?: boolean}} opsi
 *
 * `--admin-saja` melewati seed master dan hanya menerbitkan kredensial Admin.
 *
 * Ini jalur pemulihan, bukan kemudahan: bila satu-satunya Admin kehilangan
 * passwordnya, tidak ada seorang pun yang dapat meresetnya lewat aplikasi -
 * reset password menuntut wewenang Admin. Tanpa jalur ini, satu-satunya cara
 * adalah menjalankan seed master penuh, yang menulis ulang seluruh master data
 * pada basis data yang sudah dipakai.
 */
async function jalankan({ adminSaja = false, terbitkanUlang = false } = {}) {
  if (!adminSaja) await seedSql();
  await buatAdminAwal({ terbitkanUlang });

  if (adminSaja) return;

  const [[{ n: silo }]] = await pool.query('SELECT COUNT(*) n FROM silo');
  const [[{ n: supplier }]] = await pool.query('SELECT COUNT(*) n FROM supplier');
  const [[{ n: tank }]] = await pool.query('SELECT COUNT(*) n FROM tank_master');
  const [[{ n: prefix }]] = await pool.query('SELECT COUNT(*) n FROM batch_prefix');

  console.log(
    `\n✔ Master data: ${silo} silo · ${supplier} supplier · ${tank} tank · ${prefix} prefiks batch`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  jalankan({
    adminSaja: process.argv.includes('--admin-saja'),
    terbitkanUlang: process.argv.includes('--terbitkan-ulang'),
  })
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(`\n✖ ${err.message}`);
      await pool.end();
      process.exit(1);
    });
}
