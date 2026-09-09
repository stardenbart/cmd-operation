/**
 * Layanan Receiving — FR-4
 *
 * Penerimaan susu dari supplier. Selalu masuk buffer (BR-02) — silo tujuan
 * ditentukan sistem, bukan dipilih operator.
 */

import { pool, withTransaction } from '../db/pool.js';
import { hitungQtyLtr } from './konversi.js';
import { terbitkanId } from './idGenerator.js';
import { catatAudit } from './audit.js';
import { BusinessError, NotFoundError, ForbiddenError } from '../middleware/errors.js';

const STATUS_DIABAIKAN = ['Rejected', 'REVISED', 'VOIDED'];

/** Silo buffer — satu-satunya tujuan penerimaan (BR-02). */
async function ambilBuffer(conn) {
  const [baris] = await conn.query(
    'SELECT id, kode, silo_name, kapasitas_maks_ltr FROM silo WHERE is_buffer = TRUE AND is_active = TRUE LIMIT 1',
  );
  if (!baris[0]) {
    throw new BusinessError('BR-02', 'Silo buffer tidak ditemukan atau tidak aktif');
  }
  return baris[0];
}

/** Konteks form penerimaan: buffer beserta kapasitas tersisa (FR-4.4). */
export async function konteksForm() {
  const [baris] = await pool.query(
    `SELECT sv.silo_id, sv.kode, sv.silo_name,
            sv.kapasitas_maks_ltr, sv.vol_aktual_ltr, sv.vol_tersedia_ltr
       FROM v_silo_volume sv
       JOIN silo s ON s.id = sv.silo_id
      WHERE s.is_buffer = TRUE`,
  );
  const [suppliers] = await pool.query(
    'SELECT id, kode, supplier_name FROM supplier WHERE is_active = TRUE ORDER BY supplier_name',
  );
  return { buffer: baris[0] ?? null, suppliers };
}

/**
 * Membuat satu penerimaan.
 *
 * Seluruhnya dalam satu transaksi (M-1): penerbitan ID, penyimpanan record,
 * dan pencatatan audit berhasil bersama atau gagal bersama.
 */
export async function buat({ supplierId, qtyKg, beratJenis, nilaiTs, finishTime, remarks }, aktor, ip) {
  return withTransaction(async (conn) => {
    const buffer = await ambilBuffer(conn);

    const [supplier] = await conn.query(
      'SELECT id, supplier_name FROM supplier WHERE id = ? AND is_active = TRUE',
      [supplierId],
    );
    if (!supplier[0]) throw new NotFoundError('Supplier');

    // BR-03 — pembulatan ke bawah, terverifikasi terhadap 168 baris nyata
    const qtyLtr = hitungQtyLtr(qtyKg, beratJenis);

    const kode = await terbitkanId(conn, 'RCV');

    const [hasil] = await conn.query(
      `INSERT INTO receiving
         (kode, supplier_id, silo_id, qty_kg, berat_jenis, qty_ltr,
          qty_remaining_ltr, nilai_ts, finish_time, operator_id,
          status_approval, status_fifo, buffer_status, cmd_source, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'Pending Approval', 'ACTIVE', 'IN_BUFFER', 'CMD1', ?)`,
      [
        kode, supplierId, buffer.id, qtyKg, beratJenis, qtyLtr,
        qtyLtr, nilaiTs ?? null, finishTime, aktor.id, remarks ?? null,
      ],
    );

    const record = await ambilSatu(conn, hasil.insertId);

    await catatAudit(conn, {
      entity: 'receiving',
      entityId: hasil.insertId,
      action: 'CREATE',
      actorId: aktor.id,
      after: record,
      ip,
    });

    return record;
  });
}

async function ambilSatu(conn, id) {
  const [baris] = await conn.query(
    `SELECT r.*, sup.supplier_name, s.silo_name, o.nama_lengkap AS operator_nama
       FROM receiving r
       JOIN supplier sup ON sup.id = r.supplier_id
       JOIN silo s       ON s.id = r.silo_id
       JOIN operator o   ON o.id = r.operator_id
      WHERE r.id = ?`,
    [id],
  );
  return baris[0] ?? null;
}

export async function ambil(id) {
  const record = await ambilSatu(pool, id);
  if (!record) throw new NotFoundError('Penerimaan');
  return record;
}

/** Daftar berpaginasi (FR-10.9) — menggantikan pemuatan seluruh tabel ke klien. */
export async function daftar({ halaman = 1, perHalaman = 25, status, supplierId, dariTanggal, sampaiTanggal }) {
  const syarat = [];
  const nilai = [];

  if (status) { syarat.push('r.status_approval = ?'); nilai.push(status); }
  if (supplierId) { syarat.push('r.supplier_id = ?'); nilai.push(supplierId); }
  if (dariTanggal) { syarat.push('r.finish_time >= ?'); nilai.push(dariTanggal); }
  if (sampaiTanggal) { syarat.push('r.finish_time <= ?'); nilai.push(sampaiTanggal); }

  const where = syarat.length ? `WHERE ${syarat.join(' AND ')}` : '';
  const offset = (halaman - 1) * perHalaman;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM receiving r ${where}`,
    nilai,
  );
  const [baris] = await pool.query(
    `SELECT r.id, r.kode, r.qty_kg, r.berat_jenis, r.qty_ltr, r.qty_remaining_ltr,
            r.nilai_ts, r.finish_time, r.status_approval, r.status_fifo,
            r.buffer_status, sup.supplier_name, o.nama_lengkap AS operator_nama
       FROM receiving r
       JOIN supplier sup ON sup.id = r.supplier_id
       JOIN operator o   ON o.id = r.operator_id
       ${where}
      ORDER BY r.finish_time DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    [...nilai, perHalaman, offset],
  );

  return { data: baris, total, halaman, perHalaman };
}

/**
 * Apakah penerimaan ini punya turunan aktif? — BR-15
 *
 * Query biasa terhadap foreign key. Power Apps memakai `id_receiving = Title`
 * pada koleksi non-delegable, dan untuk Prepast memakai substring match pada
 * JSON (`Title in supplier_fifo`) yang rawan false positive (B-13).
 */
export async function dependensi(id) {
  const [anak] = await pool.query(
    `SELECT p.id, p.kode, p.vol_prepast_ltr, p.status_approval, s.silo_name
       FROM prepast_record p
       JOIN silo s ON s.id = p.silo_tujuan_id
      WHERE p.receiving_id = ?
        AND p.status_approval NOT IN (?, ?, ?)
      ORDER BY p.prepast_finish ASC, p.id ASC`,
    [id, ...STATUS_DIABAIKAN],
  );
  return anak;
}

/**
 * Koreksi — FR-14.
 *
 * Bercabang menurut status (keputusan D-3):
 *   Pending/Rejected → sunting di tempat + audit before/after
 *   Approved         → reversal + record baru (BR-12)
 */
export async function koreksi(id, perubahan, alasan, aktor, ip) {
  return withTransaction(async (conn) => {
    const [baris] = await conn.query('SELECT * FROM receiving WHERE id = ? FOR UPDATE', [id]);
    const lama = baris[0];
    if (!lama) throw new NotFoundError('Penerimaan');

    const anak = await dependensi(id);
    if (anak.length > 0) {
      throw new BusinessError(
        'BR-15',
        'Penerimaan ini tidak dapat diubah karena ada Prepast turunan yang masih aktif',
        { turunan: anak },
      );
    }

    const praApproval = ['Pending Approval', 'Rejected'].includes(lama.status_approval);
    if (!praApproval && lama.status_approval !== 'Approved') {
      throw new BusinessError(
        'BR-19',
        `Record berstatus ${lama.status_approval} tidak dapat dikoreksi`,
      );
    }
    if (!praApproval && aktor.role !== 'SPV') {
      throw new ForbiddenError('Hanya SPV yang dapat mengoreksi record yang sudah disetujui');
    }

    const qtyKg = perubahan.qtyKg ?? Number(lama.qty_kg);
    const beratJenis = perubahan.beratJenis ?? Number(lama.berat_jenis);
    const qtyLtr = hitungQtyLtr(qtyKg, beratJenis);

    if (praApproval) {
      // Sunting di tempat. Sah karena record belum pernah disetujui siapa pun,
      // dan jejaknya tersimpan utuh di audit_log (syarat A-2).
      await conn.query(
        `UPDATE receiving
            SET supplier_id = ?, qty_kg = ?, berat_jenis = ?, qty_ltr = ?,
                qty_remaining_ltr = ?, nilai_ts = ?, finish_time = ?, remarks = ?
          WHERE id = ?`,
        [
          perubahan.supplierId ?? lama.supplier_id,
          qtyKg, beratJenis, qtyLtr, qtyLtr,
          perubahan.nilaiTs ?? lama.nilai_ts,
          perubahan.finishTime ?? lama.finish_time,
          perubahan.remarks ?? lama.remarks,
          id,
        ],
      );

      const baru = await ambilSatu(conn, id);
      await catatAudit(conn, {
        entity: 'receiving', entityId: id, action: 'CORRECT',
        actorId: aktor.id, before: lama, after: baru, reason: alasan, ip,
      });
      return baru;
    }

    // Record sudah disetujui: reversal + entri baru (BR-12).
    // Penggantian harus terlihat di dalam data itu sendiri, bukan hanya di log —
    // auditor yang membaca daftar transaksi harus dapat melihat bahwa suatu
    // record digantikan tanpa perlu membuka jejak audit.
    await conn.query(
      `UPDATE receiving
          SET status_approval = 'REVISED', status_fifo = 'CLOSED', qty_remaining_ltr = 0
        WHERE id = ?`,
      [id],
    );

    const kode = await terbitkanId(conn, 'RCV');
    const [hasil] = await conn.query(
      `INSERT INTO receiving
         (kode, supplier_id, silo_id, qty_kg, berat_jenis, qty_ltr, qty_remaining_ltr,
          nilai_ts, finish_time, operator_id, status_approval, status_fifo,
          buffer_status, cmd_source, correction_ref_id, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               'Pending Approval', 'ACTIVE', 'IN_BUFFER', 'CMD1', ?, ?)`,
      [
        kode,
        perubahan.supplierId ?? lama.supplier_id,
        lama.silo_id, qtyKg, beratJenis, qtyLtr, qtyLtr,
        perubahan.nilaiTs ?? lama.nilai_ts,
        perubahan.finishTime ?? lama.finish_time,
        aktor.id, id,
        perubahan.remarks ?? lama.remarks,
      ],
    );

    const baru = await ambilSatu(conn, hasil.insertId);
    await catatAudit(conn, {
      entity: 'receiving', entityId: id, action: 'CORRECT',
      actorId: aktor.id, before: lama, after: baru, reason: alasan, ip,
    });
    return baru;
  });
}
