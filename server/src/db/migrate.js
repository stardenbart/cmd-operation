/**
 * Runner migrasi — F0-3
 *
 * Menjalankan berkas .sql di db/migrations secara berurutan, satu kali saja.
 * Yang sudah dijalankan dicatat di tabel `schema_migration`.
 *
 * Idempoten (T-23): dijalankan dua kali menghasilkan keadaan yang sama.
 *
 *   node src/db/migrate.js           jalankan migrasi yang belum dijalankan
 *   node src/db/migrate.js --reset   HAPUS SELURUH basis data lalu bangun ulang
 *   node src/db/migrate.js --status  tampilkan status tanpa mengubah apa pun
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR_MIGRASI = join(__dirname, '..', '..', '..', 'db', 'migrations');
const DIR_SEED = join(__dirname, '..', '..', '..', 'db', 'seeds');

/**
 * Memecah berkas SQL menjadi pernyataan terpisah.
 *
 * Memakai koneksi multipleStatements akan lebih ringkas, tetapi menjalankan
 * satu per satu membuat pesan kesalahan menunjuk pernyataan yang benar-benar
 * gagal — jauh lebih berguna saat migrasi bermasalah.
 */
function pecahPernyataan(sql) {
  const tanpaKomentar = sql
    .split('\n')
    .filter((baris) => !baris.trim().startsWith('--'))
    .join('\n');

  // Pemecahan harus SADAR LITERAL STRING.
  //
  // Memecah begitu saja pada ';' memotong pernyataan di tengah string yang
  // kebetulan mengandung titik koma, misalnya pada COMMENT kolom. Galatnya
  // muncul sebagai kesalahan sintaks yang menunjuk potongan string, sehingga
  // penyebab aslinya sulit ditebak.
  const pernyataan = [];
  let buffer = '';
  let kutip = null;

  for (let i = 0; i < tanpaKomentar.length; i += 1) {
    const c = tanpaKomentar[i];

    if (kutip) {
      buffer += c;
      // Backslash meng-escape karakter berikutnya, kecuali di dalam backtick
      if (c === '\\' && kutip !== '`') {
        i += 1;
        buffer += tanpaKomentar[i] ?? '';
        continue;
      }
      // Dua kutip berturut-turut adalah kutip ter-escape, bukan penutup
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

async function buatKoneksi({ sebagaiRoot = false } = {}) {
  return mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: sebagaiRoot ? 'root' : config.db.user,
    password: sebagaiRoot ? process.env.MYSQL_ROOT_PASSWORD : config.db.password,
    database: config.db.database,
    multipleStatements: false,
    timezone: 'Z',
  });
}

async function pastikanTabelMigrasi(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      nama       VARCHAR(100) PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
}

async function daftarSudahJalan(conn) {
  const [baris] = await conn.query('SELECT nama FROM schema_migration');
  return new Set(baris.map((b) => b.nama));
}

/** Nama basis data sebagaimana tertulis di berkas migrasi. */
const NAMA_PRODUKSI = 'fm_receiving';

/**
 * Menyesuaikan berkas migrasi untuk basis data selain produksi.
 *
 * `005_grants.sql` menyebut nama basis data secara harfiah, dan memang harus:
 * GRANT tidak menerima nama yang dinamis. Tanpa penyesuaian ini, menjalankan
 * migrasi ke basis data staging akan MENCABUT hak fm_app pada basis data
 * PRODUKSI - kerusakan yang jauh lebih besar daripada gagalnya migrasi.
 *
 * Garis bawah yang di-escape disubstitusi LEBIH DAHULU. Urutannya menentukan:
 * bentuk biasa akan ikut mencocoki sebagian bentuk ter-escape bila didahulukan,
 * dan REVOKE-nya lolos tanpa berubah.
 */
function sesuaikanNamaBasisData(sql, nama) {
  if (nama === NAMA_PRODUKSI) return sql;

  const escProduksi = NAMA_PRODUKSI.replaceAll('_', '\\_');
  const escBaru = nama.replaceAll('_', '\\_');

  return sql
    .split('`' + escProduksi + '`').join('`' + escBaru + '`')
    .split('`' + NAMA_PRODUKSI + '`').join('`' + nama + '`');
}

/** Hak yang belum pernah diberikan tidak dapat dicabut; itu bukan kegagalan. */
const HAK_TIDAK_ADA = 1141;

async function jalankanBerkas(conn, dir, nama) {
  const mentah = await readFile(join(dir, nama), 'utf8');
  const sql = sesuaikanNamaBasisData(mentah, config.db.database);
  const pernyataan = pecahPernyataan(sql);

  for (const [i, p] of pernyataan.entries()) {
    try {
      await conn.query(p);
    } catch (err) {
      // Basis data baru belum punya hak wildcard untuk dicabut
      if (err.errno === HAK_TIDAK_ADA && p.trim().toUpperCase().startsWith('REVOKE')) continue;
      throw new Error(
        `Migrasi "${nama}" gagal pada pernyataan #${i + 1}:\n` +
          `${p.slice(0, 200)}...\n\n${err.message}`,
      );
    }
  }
  return pernyataan.length;
}

async function migrate({ reset = false, statusSaja = false } = {}) {
  // SELURUH migrasi dijalankan sebagai root.
  //
  // Migrasi bersifat DDL (CREATE, ALTER, GRANT); user aplikasi sengaja TIDAK
  // diberi hak itu — 005_grants.sql mencabutnya, dan itu memang tujuannya.
  // Aplikasi hanya boleh menulis data, tidak mengubah bentuk basis data.
  //
  // Pemisahan ini terlihat saat migrasi 006 ditolak dengan "CREATE command
  // denied ... for table 'schema_migration'": runner sebelumnya memakai user
  // aplikasi, sehingga ia kehilangan hak begitu 005_grants berjalan.
  if (!process.env.MYSQL_ROOT_PASSWORD) {
    throw new Error(
      'Migrasi memerlukan MYSQL_ROOT_PASSWORD di .env — DDL tidak dijalankan ' +
        'sebagai user aplikasi (lihat 005_grants.sql).',
    );
  }

  const conn = await buatKoneksi({ sebagaiRoot: true });
  try {
    if (reset) {
      console.log('⚠  --reset: menghapus seluruh basis data dan membangun ulang\n');
      await conn.query(`DROP DATABASE IF EXISTS \`${config.db.database}\``);
      await conn.query(`CREATE DATABASE \`${config.db.database}\``);
      await conn.changeUser({ database: config.db.database });
    }

    await pastikanTabelMigrasi(conn);
    const sudah = await daftarSudahJalan(conn);
    const berkas = (await readdir(DIR_MIGRASI)).filter((f) => f.endsWith('.sql')).sort();

    if (statusSaja) {
      console.log('Status migrasi:\n');
      for (const f of berkas) {
        console.log(`  ${sudah.has(f) ? '✔' : '·'}  ${f}`);
      }
      return;
    }

    const belum = berkas.filter((f) => !sudah.has(f));
    if (belum.length === 0) {
      console.log('✔ Basis data sudah mutakhir, tidak ada migrasi baru.');
      return;
    }

    for (const nama of belum) {
      const jumlah = await jalankanBerkas(conn, DIR_MIGRASI, nama);
      await conn.query('INSERT INTO schema_migration (nama) VALUES (?)', [nama]);
      console.log(`✔  ${nama}  (${jumlah} pernyataan)`);
    }

    console.log(`\n✔ ${belum.length} migrasi berhasil dijalankan.`);
  } finally {
    await conn.end();
  }
}

/**
 * Seed dijalankan sebagai USER APLIKASI, bukan root.
 *
 * Isinya DML (INSERT/UPDATE), sehingga hak fm_app sudah memadai — dan
 * menjalankannya sebagai user aplikasi sekaligus memastikan hak yang
 * diberikan 005_grants.sql memang cukup untuk operasi normal.
 */
export async function seed() {
  const conn = await buatKoneksi();
  try {
    const berkas = (await readdir(DIR_SEED)).filter((f) => f.endsWith('.sql')).sort();
    for (const nama of berkas) {
      const jumlah = await jalankanBerkas(conn, DIR_SEED, nama);
      console.log(`✔  seed ${nama}  (${jumlah} pernyataan)`);
    }
  } finally {
    await conn.end();
  }
}

// Deteksi "berkas ini dijalankan langsung".
// pathToFileURL menangani spasi dan pemisah path Windows dengan benar;
// merangkai string file:// secara manual gagal pada path berisi spasi.
const dijalankanLangsung =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (dijalankanLangsung) {
  const argv = process.argv.slice(2);
  migrate({ reset: argv.includes('--reset'), statusSaja: argv.includes('--status') })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\n✖ ${err.message}`);
      process.exit(1);
    });
}

export { migrate };
