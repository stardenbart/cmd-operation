import mysql from 'mysql2/promise';
import { config } from '../config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  // Samakan collation literal/query dengan schema hasil migrasi. Tanpa ini,
  // Aiven MySQL 8 memakai utf8mb4_0900_ai_ci dan perbandingan terhadap kolom
  // atau ekspresi view utf8mb4_unicode_ci dapat gagal dengan errno 1267.
  charset: config.db.collation,
  // Aiven mewajibkan TLS. Jika CA proyek diberikan melalui DB_SSL_CA,
  // sertifikat server juga diverifikasi. Tanpa CA, koneksi tetap terenkripsi
  // seperti ssl-mode=REQUIRED pada informasi koneksi Aiven.
  ssl: config.db.ssl
    ? {
        rejectUnauthorized: Boolean(config.db.sslCa),
        ...(config.db.sslCa ? { ca: config.db.sslCa } : {}),
      }
    : undefined,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  // Seluruh DATETIME disimpan & dibaca sebagai UTC (A-4).
  timezone: 'Z',
  // DECIMAL dikembalikan sebagai string agar tidak kehilangan presisi;
  // konversi ke number dilakukan sadar di lapis service.
  decimalNumbers: false,
  namedPlaceholders: true,
});

/**
 * Menjalankan fn di dalam satu transaksi.
 *
 * Setiap operasi yang mengubah volume WAJIB lewat sini. Inilah yang tidak
 * dimiliki Power Apps: submit transfer di sana adalah 1 insert + N update
 * berurutan, sehingga gagal di tengah meninggalkan stok yang salah permanen (M-1).
 *
 * @example
 *   await withTransaction(async (conn) => {
 *     const batches = await kunciBatch(conn, siloId);
 *     ...
 *   });
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const hasil = await fn(conn);
    await conn.commit();
    return hasil;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Memeriksa koneksi basis data — dipakai health check (NFR-20). */
export async function cekKoneksi() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SELECT 1');
    return true;
  } finally {
    conn.release();
  }
}

export async function tutupPool() {
  await pool.end();
}
