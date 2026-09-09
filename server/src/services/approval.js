/**
 * Layanan Approval - FR-9, FR-16
 *
 * Wewenang SPV semata (BR-22). Admin tidak mewarisinya: menyetujui dan
 * menolak adalah keputusan mutu, bukan keputusan administratif.
 *
 * Dua perbaikan atas Power Apps:
 *   B-5   Ikon reject di sana `Visible: =false` pada tab Receiving, Prepast,
 *         dan Transfer, sehingga hanya Monitoring yang dapat direject.
 *         Jalur rejectnya sendiri sudah ada tetapi belum pernah dijalankan.
 *   WF-4  Persetujuan satu per satu, tiap klik memuat ulang seluruh koleksi.
 *         Di sini approve massal berjalan dalam satu transaksi.
 */

import { pool, withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { periksa } from './dependensi.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';
import { pastikanBerwenang, AKSI } from '../auth/permissions.js';

/** Modul -> tabel. Pengembalian berbagi tabel dengan prepast (BR-25). */
const TABEL = {
  receiving: { tabel: 'receiving', entity: 'receiving' },
  prepast: { tabel: 'prepast_record', entity: 'prepast' },
  pengembalian: { tabel: 'prepast_record', entity: 'pengembalian' },
  transfer: { tabel: 'transfer', entity: 'transfer' },
  monitoring: { tabel: 'monitoring', entity: 'monitoring' },
};

function petaModul(modul) {
  const m = TABEL[modul];
  if (!m) throw new BusinessError('VALIDATION_ERROR', `Modul tidak dikenal: ${modul}`);
  return m;
}

/** Antrean approval terpadu lintas modul - FR-16.1. */
export async function antrean({ modul } = {}) {
  const [baris] = await pool.query(
    `SELECT q.*, o.nama_lengkap AS operator_nama,
            TIMESTAMPDIFF(MINUTE, q.created_at, UTC_TIMESTAMP()) AS usia_menit
       FROM v_approval_queue q
       JOIN operator o ON o.id = q.operator_id
      ${modul ? 'WHERE q.modul = ?' : ''}
      ORDER BY q.created_at ASC`,
    modul ? [modul] : [],
  );

  const perModul = {};
  for (const b of baris) perModul[b.modul] = (perModul[b.modul] ?? 0) + 1;

  return {
    data: baris,
    total: baris.length,
    perModul,
    // Usia antrean tertua: penanda kemacetan persetujuan (FR-27.4.12)
    usiaTertuaMenit: baris.length ? Math.max(...baris.map((b) => b.usia_menit)) : 0,
  };
}

async function ambilRecord(conn, modul, id, { kunci = false } = {}) {
  const { tabel } = petaModul(modul);
  const [baris] = await conn.query(
    `SELECT * FROM ${tabel} WHERE id = ?${kunci ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!baris[0]) throw new NotFoundError('Record');
  return baris[0];
}

/** Menyetujui satu record. */
async function setujuiSatu(conn, modul, id, aktor, ip) {
  const { tabel, entity } = petaModul(modul);
  const lama = await ambilRecord(conn, modul, id, { kunci: true });

  if (lama.status_approval !== 'Pending Approval') {
    throw new BusinessError(
      'BR-19',
      `${lama.kode} berstatus ${lama.status_approval}, bukan Pending Approval`,
    );
  }

  // BR-23 - draft belum lengkap tidak boleh masuk antrean, apalagi disetujui
  if (lama.is_gantung) {
    throw new BusinessError(
      'BR-23',
      `${lama.kode} masih berupa draft. Lengkapi waktunya sebelum disetujui.`,
    );
  }

  await conn.query(
    `UPDATE ${tabel}
        SET status_approval = 'Approved', approved_by_id = ?, approved_at = UTC_TIMESTAMP()
      WHERE id = ?`,
    [aktor.id, id],
  );

  const baru = await ambilRecord(conn, modul, id);
  await catatAudit(conn, {
    entity, entityId: id, action: 'APPROVE',
    actorId: aktor.id, before: lama, after: baru, ip,
  });

  return { modul, id, kode: lama.kode };
}

export async function setujui(modul, id, aktor, ip) {
  // BR-22 - Admin sengaja TIDAK mewarisi wewenang ini (D-5)
  pastikanBerwenang(aktor, AKSI.APPROVAL_PUTUSKAN);
  return withTransaction((conn) => setujuiSatu(conn, modul, id, aktor, ip));
}

/**
 * Approve massal - FR-16.2.
 *
 * SATU transaksi untuk seluruh pilihan: bila satu record gagal (misalnya
 * ternyata sudah di-void orang lain), seluruh batch dibatalkan dan hasilnya
 * dilaporkan per baris. Persetujuan separuh jalan akan membuat SPV mengira
 * ia sudah menyetujui semuanya.
 */
export async function setujuiMassal(daftar, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.APPROVAL_MASSAL);
  if (!Array.isArray(daftar) || daftar.length === 0) {
    throw new BusinessError('FR-16.2', 'Pilih minimal satu record');
  }

  return withTransaction(async (conn) => {
    const berhasil = [];
    for (const { modul, id } of daftar) {
      berhasil.push(await setujuiSatu(conn, modul, id, aktor, ip));
    }
    return { disetujui: berhasil, jumlah: berhasil.length };
  });
}

/**
 * Menolak satu record - FR-9.3.
 *
 * Reject tidak dapat dilakukan massal (FR-16.4): penolakan menuntut alasan
 * yang khusus untuk record itu.
 */
export async function tolak(modul, id, alasan, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.APPROVAL_PUTUSKAN);
  if (!alasan || alasan.trim().length < 3) {
    throw new BusinessError('FR-9.3', 'Alasan penolakan wajib diisi');
  }

  return withTransaction(async (conn) => {
    const { tabel, entity } = petaModul(modul);
    const lama = await ambilRecord(conn, modul, id, { kunci: true });

    if (lama.status_approval !== 'Pending Approval') {
      throw new BusinessError(
        'BR-19',
        `${lama.kode} berstatus ${lama.status_approval}, bukan Pending Approval`,
      );
    }

    /**
     * BR-15 - guard dependensi.
     *
     * Menolak record yang sudah punya turunan aktif akan membuat volume
     * turunannya menggantung: ia berasal dari sesuatu yang dinyatakan tidak
     * sah. Turunannya harus ditangani lebih dulu.
     *
     * Jalur ini belum pernah dijalankan di produksi karena tombol rejectnya
     * tersembunyi (B-5), sehingga guardnya pun belum pernah aktif.
     */
    const dep = await periksa(modul, id, { conn });
    if (!dep.boleh) {
      throw new BusinessError(
        'BR-15',
        `${lama.kode} tidak dapat ditolak karena ada ${dep.jumlah} record turunan yang masih aktif. ` +
          'Tangani turunannya lebih dulu.',
        { pohon: dep.pohon, jumlah: dep.jumlah },
      );
    }

    await conn.query(
      `UPDATE ${tabel}
          SET status_approval = 'Rejected', rejection_comment = ?,
              approved_by_id = ?, approved_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [alasan, aktor.id, id],
    );

    const baru = await ambilRecord(conn, modul, id);
    await catatAudit(conn, {
      entity, entityId: id, action: 'REJECT',
      actorId: aktor.id, before: lama, after: baru, reason: alasan, ip,
    });

    return { modul, id, kode: lama.kode };
  });
}

/** Pohon dependensi suatu record, untuk dialog peringatan (FR-17.1). */
export async function dependensi(modul, id) {
  return periksa(modul, id);
}
