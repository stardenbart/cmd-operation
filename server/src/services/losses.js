/**
 * Losses Management - FR-35.
 *
 * Konfigurasi 27 titik losses. Setiap perubahan yang memengaruhi kalkulasi
 * (volume, satuan, aktif/nonaktif) MEN-SNAPSHOT seluruh konfigurasi ke
 * loss_point_version (BR-28), sehingga laporan historis tetap merujuk keadaan
 * konfigurasi saat laporan itu dibuat, bukan yang terkini.
 */

import { pool, withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { pastikanBerwenang, AKSI } from '../auth/permissions.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';

const KATEGORI = ['receiving', 'prepast', 'switching', 'buffer', 'penarikan'];
const BOLEH_UBAH = ['nama', 'volume_liter', 'satuan', 'calculation_type', 'aktif', 'catatan'];
// Hanya perubahan ini yang memicu snapshot versi baru (FR-35.4.5).
const PEMICU_VERSI = ['volume_liter', 'satuan', 'aktif'];

/** Daftar loss point + pengelompokan per kategori (FR-35.4.2). */
export async function daftar() {
  const [baris] = await pool.query('SELECT * FROM loss_point ORDER BY kode');
  const perKategori = KATEGORI.map((kat) => ({
    kategori: kat,
    titik: baris.filter((b) => b.kategori === kat),
  })).filter((g) => g.titik.length > 0);
  return { data: baris, perKategori, total: baris.length };
}

/** Riwayat perubahan satu loss point, dari jejak audit. */
async function riwayatLossPoint(id) {
  const [baris] = await pool.query(
    `SELECT a.id, a.action, a.before_json, a.after_json, a.reason, a.created_at,
            o.nama_lengkap AS aktor_nama
       FROM audit_log a
       LEFT JOIN operator o ON o.id = a.actor_id
      WHERE a.entity = 'loss_point' AND a.entity_id = ?
      ORDER BY a.created_at DESC, a.id DESC`,
    [id],
  );
  return baris;
}

/** Detail satu loss point + riwayatnya - FR-35.5. */
export async function detail(id) {
  const [baris] = await pool.query('SELECT * FROM loss_point WHERE id = ?', [id]);
  if (!baris[0]) throw new NotFoundError('Loss point');
  return { ...baris[0], riwayat: await riwayatLossPoint(id) };
}

/** Membuat snapshot versi dari SELURUH konfigurasi loss point saat ini. */
async function buatVersiDalam(conn, aktor, catatan) {
  const [semua] = await conn.query(
    `SELECT kode, nama, kategori, volume_liter, satuan, calculation_type, aktif
       FROM loss_point ORDER BY kode`,
  );
  const [hasil] = await conn.query(
    'INSERT INTO loss_point_version (snapshot, dibuat_oleh, catatan) VALUES (?, ?, ?)',
    [JSON.stringify(semua), aktor.id, catatan ?? null],
  );
  return hasil.insertId;
}

/**
 * Menyunting satu loss point - FR-35.4. Perubahan volume/satuan/aktif memicu
 * snapshot versi (BR-28) dan tercatat di audit.
 */
export async function sunting(id, masukan, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.MASTER_KELOLA);

  const set = {};
  for (const k of BOLEH_UBAH) if (k in masukan) set[k] = masukan[k];
  if (Object.keys(set).length === 0) {
    throw new BusinessError('FR-35', 'Tidak ada nilai yang diubah');
  }
  if ('kategori' in masukan && !KATEGORI.includes(masukan.kategori)) {
    throw new BusinessError('FR-35', 'Kategori tidak sah');
  }

  return withTransaction(async (conn) => {
    const [baris] = await conn.query('SELECT * FROM loss_point WHERE id = ? FOR UPDATE', [id]);
    const lama = baris[0];
    if (!lama) throw new NotFoundError('Loss point');

    const kolom = Object.keys(set);
    await conn.query(
      `UPDATE loss_point SET ${kolom.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
      [...kolom.map((k) => set[k]), id],
    );
    const [baruBaris] = await conn.query('SELECT * FROM loss_point WHERE id = ?', [id]);
    const baru = baruBaris[0];

    const memicuVersi = PEMICU_VERSI.some((k) => k in set);
    let versiId = null;
    if (memicuVersi) versiId = await buatVersiDalam(conn, aktor, `Perubahan ${lama.kode}`);

    const berubah = {};
    for (const k of kolom) {
      if (String(lama[k] ?? '') !== String(baru[k] ?? '')) {
        berubah[k] = { dari: lama[k], menjadi: baru[k] };
      }
    }
    await catatAudit(conn, {
      entity: 'loss_point',
      entityId: id,
      action: 'UPDATE',
      actorId: aktor.id,
      before: lama,
      after: { perubahan: berubah, versiId },
      reason: `Loss point ${lama.kode} diperbarui`,
      ip,
    });

    return { data: baru, perubahan: berubah, versiId };
  });
}

/** Membuat snapshot versi secara eksplisit - FR-35.5. */
export async function buatVersi(aktor, catatan, ip) {
  pastikanBerwenang(aktor, AKSI.MASTER_KELOLA);
  return withTransaction(async (conn) => {
    const id = await buatVersiDalam(conn, aktor, catatan);
    await catatAudit(conn, {
      entity: 'loss_point_version', entityId: id, action: 'CREATE',
      actorId: aktor.id, after: { catatan: catatan ?? null }, ip,
    });
    return { id };
  });
}

/** Daftar snapshot versi (ringkas) - FR-35.5. */
export async function daftarVersi() {
  const [baris] = await pool.query(
    `SELECT v.id, v.berlaku_sejak, v.catatan, o.nama_lengkap AS dibuat_oleh,
            JSON_LENGTH(v.snapshot) AS jumlah_titik
       FROM loss_point_version v
       LEFT JOIN operator o ON o.id = v.dibuat_oleh
      ORDER BY v.berlaku_sejak DESC, v.id DESC`,
  );
  return { data: baris, total: baris.length };
}

/** Detail satu snapshot versi - FR-35.5. */
export async function versi(id) {
  const [baris] = await pool.query(
    `SELECT v.id, v.snapshot, v.berlaku_sejak, v.catatan, o.nama_lengkap AS dibuat_oleh
       FROM loss_point_version v
       LEFT JOIN operator o ON o.id = v.dibuat_oleh
      WHERE v.id = ?`,
    [id],
  );
  if (!baris[0]) throw new NotFoundError('Versi loss point');
  return baris[0];
}
