/**
 * Penulis jejak audit — NFR-6, syarat A-1..A-8 (PRD 15.3.1)
 *
 * Memenuhi 21 CFR Part 11 §11.10(e) dan prinsip ALCOA+.
 *
 * Tabel `audit_log` bersifat append-only di tingkat basis data: user aplikasi
 * hanya diberi hak INSERT & SELECT. Bahkan bug di kode aplikasi tidak dapat
 * mengubah atau menghapus jejak.
 */

const AKSI_WAJIB_ALASAN = new Set(['CORRECT', 'VOID']);

/**
 * Mencatat satu peristiwa.
 *
 * @param {import('mysql2/promise').Connection} conn
 *   Koneksi atau transaksi berjalan. Pencatatan audit HARUS berada di dalam
 *   transaksi yang sama dengan perubahan datanya — bila transaksi di-rollback,
 *   jejaknya ikut hilang, sehingga tidak pernah ada catatan untuk perubahan
 *   yang tidak pernah terjadi.
 * @param {object} p
 * @param {string} p.entity        nama tabel, mis. 'receiving'
 * @param {number} p.entityId
 * @param {string} p.action        salah satu ENUM audit_log.action
 * @param {number} p.actorId       operator.id — A-3, bukan string nama
 * @param {object|null} [p.before] snapshot baris UTUH sebelum (A-2)
 * @param {object|null} [p.after]  snapshot baris UTUH sesudah
 * @param {string|null} [p.reason] wajib untuk CORRECT & VOID (A-5)
 * @param {string|null} [p.ip]
 */
export async function catatAudit(conn, {
  entity,
  entityId,
  action,
  actorId,
  before = null,
  after = null,
  reason = null,
  ip = null,
}) {
  if (AKSI_WAJIB_ALASAN.has(action) && !reason?.trim()) {
    throw new Error(
      `Aksi ${action} wajib menyertakan alasan (syarat A-5). ` +
        'Koreksi dan pembatalan tanpa alasan tidak dapat diaudit.',
    );
  }

  await conn.query(
    `INSERT INTO audit_log
       (entity, entity_id, action, actor_id, before_json, after_json, reason, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entity,
      entityId,
      action,
      actorId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      reason ?? null,
      ip ?? null,
    ],
  );
}

/**
 * Riwayat perubahan satu record, urut waktu — untuk panel "Riwayat Perubahan"
 * (syarat A-6). Jejak audit yang tidak dapat ditunjukkan sama saja dengan
 * tidak ada.
 */
export async function riwayatAudit(conn, entity, entityId) {
  const [baris] = await conn.query(
    `SELECT a.id, a.action, a.reason, a.created_at,
            a.before_json, a.after_json,
            o.kode AS actor_kode, o.nama_lengkap AS actor_nama
       FROM audit_log a
       JOIN operator o ON o.id = a.actor_id
      WHERE a.entity = ? AND a.entity_id = ?
      ORDER BY a.created_at ASC, a.id ASC`,
    [entity, entityId],
  );
  return baris;
}
