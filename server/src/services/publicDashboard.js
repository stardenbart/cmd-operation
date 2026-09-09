/**
 * Tautan publik dashboard (read-only) - FR berbagi tampilan.
 *
 * Penerima tautan melihat kartu stok, visual silo, dan papan batch aktif TANPA
 * login. Gerbangnya token rahasia yang dapat dicabut: hanya SATU token aktif;
 * memutarnya menonaktifkan yang lama. Endpoint publik hanya menyajikan agregat
 * baca-saja - tidak ada identitas, tidak ada operasi tulis.
 */

import { randomBytes } from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { siloLive, batchAktifLive } from './dashboardLive.js';

/** Agregat baca-saja untuk halaman publik. */
export async function dataPublik() {
  const [silo, batchAktif] = await Promise.all([siloLive(), batchAktifLive()]);
  return {
    silos: silo.data,
    ringkasan: silo.ringkasan,
    batchAktif,
    diperbaruiPada: new Date().toISOString(),
  };
}

/** Token aktif saat ini, atau null bila berbagi belum/berhenti diaktifkan. */
export async function tokenAktif() {
  const [baris] = await pool.query(
    'SELECT token FROM public_dashboard_token WHERE aktif = TRUE ORDER BY id DESC LIMIT 1',
  );
  return baris[0]?.token ?? null;
}

/** True bila token cocok dan masih aktif. Perbandingan lewat basis data. */
export async function verifikasiToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [baris] = await pool.query(
    'SELECT 1 FROM public_dashboard_token WHERE token = ? AND aktif = TRUE LIMIT 1',
    [token],
  );
  return baris.length > 0;
}

/**
 * Terbitkan token baru; token lama dinonaktifkan. Satu transaksi supaya tidak
 * pernah ada dua token aktif sekaligus.
 */
export async function putarToken(aktor, ip) {
  const token = randomBytes(24).toString('base64url'); // 32 karakter URL-safe
  await withTransaction(async (conn) => {
    await conn.query('UPDATE public_dashboard_token SET aktif = FALSE WHERE aktif = TRUE');
    const [hasil] = await conn.query(
      'INSERT INTO public_dashboard_token (token, aktif, dibuat_oleh) VALUES (?, TRUE, ?)',
      [token, aktor.id],
    );
    await catatAudit(conn, {
      entity: 'dashboard_share',
      entityId: hasil.insertId,
      action: 'UPDATE',
      actorId: aktor.id,
      after: { peristiwa: 'token diterbitkan' },
      ip,
    });
  });
  return token;
}

/** Cabut seluruh token aktif; tautan yang beredar langsung mati. */
export async function cabutToken(aktor, ip) {
  await withTransaction(async (conn) => {
    const [aktif] = await conn.query(
      'SELECT id FROM public_dashboard_token WHERE aktif = TRUE',
    );
    await conn.query('UPDATE public_dashboard_token SET aktif = FALSE WHERE aktif = TRUE');
    for (const t of aktif) {
      await catatAudit(conn, {
        entity: 'dashboard_share',
        entityId: t.id,
        action: 'UPDATE',
        actorId: aktor.id,
        after: { peristiwa: 'token dicabut' },
        ip,
      });
    }
  });
}
