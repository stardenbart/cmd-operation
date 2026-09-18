/**
 * Basis uji berdatabase - F2-13
 *
 * Aturan yang paling mahal bila salah justru tidak dapat diuji sebagai fungsi
 * murni: BR-06 menuntut VIEW kapasitas, BR-15 menuntut kunci baris, dan
 * kekekalan volume hanya berarti bila transaksinya benar-benar commit. Karena
 * itu uji-uji itu berjalan di atas basis data sungguhan.
 *
 * Basis data uji TERPISAH dari basis data pengembangan. Menjalankan uji yang
 * meng-TRUNCATE tabel transaksi di atas data kerja adalah cara yang sangat
 * efisien untuk menghapus sore yang produktif.
 */

import mysql from 'mysql2/promise';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AKAR = join(__dirname, '..', '..', '..');
const DIR_MIGRASI = join(AKAR, 'db', 'migrations');
const DIR_SEED = join(AKAR, 'db', 'seeds');

/**
 * PENJAGA: menolak berjalan di luar basis data uji.
 *
 * Bukan kehati-hatian berlebihan. `reset()` menjalankan TRUNCATE pada seluruh
 * tabel transaksi; satu variabel lingkungan yang lupa diset sudah cukup untuk
 * mengarahkannya ke data sungguhan. Nama basis data uji WAJIB berakhiran
 * `_test`, dan pemeriksaannya dilakukan sebelum apa pun disentuh.
 */
function pastikanBasisDataUji(nama) {
  if (!nama || !nama.endsWith('_test')) {
    throw new Error(
      `Basis data uji harus berakhiran "_test", diterima: "${nama}". ` +
        'Jalankan lewat "npm run test:integrasi" yang menyetel DB_NAME.',
    );
  }
}

/** Tabel transaksi, urut dari anak ke induk agar FK tidak menghalangi. */
const TABEL_TRANSAKSI = [
  'batch_traceability',
  'transfer_allocation',
  'transfer',
  'monitoring',
  'prepast_record',
  'receiving',
  'correction_request',
  'audit_log',
  'stock_opname',
  'idempotency_key',
  'refresh_token',
  'id_sequence',
  // FR-35: snapshot versi losses dibuat per uji, jadi ikut dibersihkan.
  // loss_point sendiri master (seeded), tetap dipertahankan.
  'loss_point_version',
];

/**
 * Memecah berkas SQL menjadi pernyataan terpisah.
 *
 * Sengaja SADAR LITERAL STRING: memecah begitu saja pada ';' memotong
 * pernyataan di tengah COMMENT kolom yang mengandung titik koma, dan galatnya
 * muncul sebagai kesalahan sintaks yang menunjuk potongan string.
 */
function pecahPernyataan(sql) {
  const tanpaKomentar = sql
    .split('\n')
    .filter((baris) => !baris.trim().startsWith('--'))
    .join('\n');

  const pernyataan = [];
  let buffer = '';
  let kutip = null;

  for (let i = 0; i < tanpaKomentar.length; i += 1) {
    const c = tanpaKomentar[i];

    if (kutip) {
      buffer += c;
      if (c === '\\' && kutip !== '`') {
        i += 1;
        buffer += tanpaKomentar[i] ?? '';
        continue;
      }
      if (c === kutip) {
        if (tanpaKomentar[i + 1] === kutip) {
          i += 1;
          buffer += tanpaKomentar[i];
          continue;
        }
        kutip = null;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      kutip = c;
      buffer += c;
      continue;
    }
    if (c === ';') {
      if (buffer.trim()) pernyataan.push(buffer.trim());
      buffer = '';
      continue;
    }
    buffer += c;
  }

  if (buffer.trim()) pernyataan.push(buffer.trim());
  return pernyataan;
}

/** Nama basis data produksi sebagaimana tertulis di berkas migrasi. */
const NAMA_PRODUKSI = 'fm_receiving';

/**
 * Menyesuaikan berkas migrasi untuk basis data uji.
 *
 * `005_grants.sql` menyebut nama basis data secara harfiah, dan memang harus:
 * GRANT tidak menerima nama yang dinamis. Supaya model hak akses yang SAMA
 * tetap ikut diuji - bukan dilewati - nama basis datanya disubstitusi di sini,
 * termasuk bentuk ter-escape `fm\_receiving` yang dipakai REVOKE karena
 * garis bawah adalah wildcard dalam konteks hak akses MySQL.
 */
function sesuaikanUntukUji(sql, namaUji) {
  // Garis bawah di-escape lebih dulu, dan HARUS dikerjakan sebelum bentuk
  // biasa: kalau tidak, `fm\_receiving` tidak pernah cocok, pernyataan REVOKE
  // lolos tanpa disubstitusi, dan ia mencabut hak fm_app pada basis data
  // PRODUKSI. Uji yang merusak lingkungan kerja lebih buruk daripada uji yang
  // tidak ada.
  const escProduksi = NAMA_PRODUKSI.replaceAll('_', '\\_');
  const escUji = namaUji.replaceAll('_', '\\_');

  return sql
    .replaceAll(`\`${escProduksi}\``, `\`${escUji}\``)
    .replaceAll(`\`${NAMA_PRODUKSI}\``, `\`${namaUji}\``);
}

/** Hak yang belum pernah diberikan tidak dapat dicabut; itu bukan kegagalan. */
const HAK_TIDAK_ADA = 1141;

async function jalankanBerkas(conn, dir, nama, namaUji) {
  let sql = await readFile(join(dir, nama), 'utf8');
  if (namaUji) sql = sesuaikanUntukUji(sql, namaUji);

  for (const [i, p] of pecahPernyataan(sql).entries()) {
    // Jaring pengaman terakhir. Bila substitusi nama gagal karena berkas
    // migrasi menuliskannya dengan cara yang tidak terduga, pernyataan hak
    // akses akan menyasar basis data produksi. Lebih baik ujinya berhenti
    // dengan pesan yang jelas daripada berhasil sambil mencabut hak di sana.
    const perintah = p.trim().toUpperCase();
    const soalHakAkses = perintah.startsWith('GRANT') || perintah.startsWith('REVOKE');
    const masihMenyebutProduksi =
      p.includes(`\`${NAMA_PRODUKSI}\``) ||
      p.includes(`\`${NAMA_PRODUKSI.replaceAll('_', '\\_')}\``);

    if (namaUji && soalHakAkses && masihMenyebutProduksi) {
      throw new Error(
        `${nama} pernyataan #${i + 1} masih menyebut "${NAMA_PRODUKSI}". ` +
          'Substitusi nama gagal; uji dihentikan agar hak akses produksi tidak tersentuh.',
      );
    }

    try {
      await conn.query(p);
    } catch (err) {
      // Basis data uji baru dibuat, jadi tidak ada hak wildcard untuk dicabut.
      if (err.errno === HAK_TIDAK_ADA && perintah.startsWith('REVOKE')) continue;
      throw new Error(`${nama} gagal pada pernyataan #${i + 1}: ${err.message}`);
    }
  }
}

let sudahDibangun = false;

/**
 * Membangun basis data uji: buang, buat ulang, migrasi, seed master.
 *
 * Dijalankan sekali per proses uji. Node menjalankan tiap berkas uji di
 * prosesnya sendiri, sehingga tiap berkas mendapat skema yang bersih tanpa
 * bergantung pada urutan berkas.
 */
export async function bangunBasisDataUji() {
  if (sudahDibangun) return;

  const { config } = await import('../../src/config.js');
  pastikanBasisDataUji(config.db.database);

  if (!process.env.MYSQL_ROOT_PASSWORD) {
    throw new Error('Uji integrasi memerlukan MYSQL_ROOT_PASSWORD di .env (migrasi adalah DDL).');
  }

  // Migrasi sebagai root: isinya DDL, dan 005_grants.sql memang mencabut hak
  // itu dari user aplikasi.
  const root = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: 'root',
    password: process.env.MYSQL_ROOT_PASSWORD,
    timezone: 'Z',
  });
  try {
    await root.query(`DROP DATABASE IF EXISTS \`${config.db.database}\``);
    await root.query(`CREATE DATABASE \`${config.db.database}\``);
    await root.changeUser({ database: config.db.database });

    const berkas = (await readdir(DIR_MIGRASI)).filter((f) => f.endsWith('.sql')).sort();
    for (const nama of berkas) {
      await jalankanBerkas(root, DIR_MIGRASI, nama, config.db.database);
    }
  } finally {
    await root.end();
  }

  // Seed sebagai user aplikasi: isinya DML, dan menjalankannya begini
  // sekaligus membuktikan hak dari 005_grants.sql memadai untuk operasi normal.
  const app = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    timezone: 'Z',
  });
  try {
    const berkas = (await readdir(DIR_SEED)).filter((f) => f.endsWith('.sql')).sort();
    for (const nama of berkas) await jalankanBerkas(app, DIR_SEED, nama, config.db.database);
  } finally {
    await app.end();
  }

  await seedOperatorUji();
  sudahDibangun = true;
}

/**
 * Operator uji dengan id yang PASTI.
 *
 * Seed SQL tidak memuat operator, dan `src/db/seed.js` hanya membuat akun
 * Admin dengan password acak yang ditampilkan sekali - benar untuk produksi,
 * tidak dapat dipakai uji. Ketiganya dibuat di sini dengan id eksplisit supaya
 * `AKTOR` di bawah tidak perlu menebak, dan dengan password tetap supaya uji
 * wewenang dapat benar-benar login.
 */
async function seedOperatorUji() {
  const argon2 = (await import('argon2')).default;
  const QRCode = (await import('qrcode')).default;
  const hash = await argon2.hash(PASSWORD_UJI, { type: argon2.argon2id });
  const conn = await konekPerkakas();

  // PNG kecil yang SAH (bukan cuma placeholder byte acak) - dipakai sebagai
  // tanda tangan digital bawaan ketiga aktor uji (migrasi 034). Tanpa ini,
  // setiap uji yang memanggil receiving.buat() gagal duluan dengan
  // SIGNATURE_REQUIRED, padahal yang diuji bukan itu.
  const tandaTanganUji = await QRCode.toBuffer('uji', { type: 'png', width: 20 });

  for (const o of Object.values(AKTOR)) {
    await conn.query(
      `INSERT INTO operator
         (id, kode, username, nama_lengkap, password_hash, must_change_password, role,
          is_active, signature_image, signature_updated_at)
       VALUES (?, ?, ?, ?, ?, FALSE, ?, TRUE, ?, UTC_TIMESTAMP())`,
      [o.id, o.kode, o.kode, o.nama, hash, o.role, tandaTanganUji],
    );
  }
}

/**
 * Mengosongkan seluruh data transaksi, master dibiarkan.
 *
 * Dipanggil di awal tiap uji, bukan di akhir: uji yang gagal di tengah
 * meninggalkan sisa, dan membersihkan di akhir berarti kegagalan pertama
 * merembet menjadi kegagalan palsu di uji berikutnya.
 */
let koneksiPerkakas = null;

/**
 * Koneksi milik perkakas uji, terpisah dari pool aplikasi.
 *
 * Pembersihan memakai TRUNCATE, yang menuntut hak DROP - dan `fm_app` memang
 * TIDAK memilikinya. Percobaan pertama memakai pool aplikasi ditolak dengan
 * "DROP command denied", dan penolakan itu benar: model hak akses di
 * 005_grants.sql sengaja seketat itu, aplikasi hanya boleh menulis data.
 *
 * Melonggarkan hak fm_app agar ujinya lolos berarti menguji sistem yang
 * berbeda dari yang dijalankan. Jadi yang mengalah adalah perkakasnya:
 * pembersihan adalah pekerjaan perkakas, bukan pekerjaan aplikasi.
 */
async function konekPerkakas() {
  if (koneksiPerkakas) return koneksiPerkakas;

  const { config } = await import('../../src/config.js');
  pastikanBasisDataUji(config.db.database);

  koneksiPerkakas = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: 'root',
    password: process.env.MYSQL_ROOT_PASSWORD,
    database: config.db.database,
    timezone: 'Z',
  });
  return koneksiPerkakas;
}

export async function reset() {
  const conn = await konekPerkakas();

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABEL_TRANSAKSI) await conn.query(`TRUNCATE TABLE \`${t}\``);
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // Silo kembali kosong: standing time anchor ikut dibersihkan, kalau tidak
  // uji standing time membaca jangkar dari uji sebelumnya.
  await conn.query('UPDATE silo SET standing_time_anchor = NULL');
}

/** Menutup pool dan koneksi perkakas agar proses uji tidak menggantung. */
export async function tutup() {
  const { pool } = await import('../../src/db/pool.js');
  await pool.end();
  if (koneksiPerkakas) {
    await koneksiPerkakas.end();
    koneksiPerkakas = null;
  }
}

/** Aktor uji, sesuai peran di matriks 2.10.1. */
export const AKTOR = {
  operator: { id: 2, kode: 'OP001', nama: 'Ade Yudistira', role: 'Operator' },
  spv: { id: 3, kode: 'SPV001', nama: 'Fajrul Rivai', role: 'SPV' },
  admin: { id: 1, kode: 'ADMIN', nama: 'Administrator', role: 'Admin' },
};

/**
 * Password tetap untuk seluruh operator uji. Hanya berlaku di basis data uji.
 *
 * Panjangnya harus melewati `config.auth.passwordMinLength`, kalau tidak uji
 * ganti-password akan gagal karena aturan panjang, bukan karena yang diuji.
 */
export const PASSWORD_UJI = 'UjiCoba123';

export const IP_UJI = '127.0.0.1';
