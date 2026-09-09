/**
 * Layanan Monitoring ronde - FR-7, FR-30.1
 *
 * Operator berkeliling mengecek pH dan suhu seluruh silo dalam satu ronde.
 * Power Apps memaksa satu form per silo, mengulang pemilihan silo dan
 * penulisan waktu di setiap pengisian: 8 silo x 7 kali cek berarti sampai
 * 56 pengisian form per hari. Di sini satu ronde adalah satu kali kirim.
 */

import { pool, withTransaction } from '../db/pool.js';
import { terbitkanId } from './idGenerator.js';
import { catatAudit } from './audit.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';

/**
 * Label untuk batch yang asal suppliernya tidak diketahui (pengembalian,
 * BR-25). Ditulis apa adanya, bukan disamarkan sebagai supplier: siapa pun
 * yang membaca snapshot ini harus tahu bahwa sebagian isi silo tidak dapat
 * ditelusuri.
 */
const TANPA_SUPPLIER = 'Tidak diketahui';

/** Rentang pH yang wajar untuk susu segar (FR-7.5). */
export const PH_MIN = 6.0;
export const PH_MAKS = 7.0;

/**
 * Silo yang perlu dicek beserta keadaan terakhirnya.
 *
 * Ambang berasal dari kolom `monitoring_interval_jam`, bukan dari
 * perbandingan nama silo. Inilah yang mencabut akar B-19: di Power Apps
 * ambang 2 jam untuk SILO25A/25B tidak pernah aktif karena membandingkan
 * silo_name ke "SILO 25A" (berspasi) padahal nilainya "SILO25A".
 */
export async function konteksRonde() {
  const [baris] = await pool.query(
    `SELECT m.silo_id, m.kode, m.silo_name, m.vol_aktual_ltr,
            m.monitoring_interval_jam, m.last_check_at, m.last_ph, m.last_temp,
            m.menit_sejak_cek, m.status_cek
       FROM v_silo_monitoring_status m
       JOIN v_silo_volume v ON v.silo_id = m.silo_id
      WHERE v.is_buffer = FALSE
      ORDER BY v.urutan`,
  );

  // Supplier aktif per silo, untuk snapshot supplier_list
  const [supplier] = await pool.query(
    `SELECT p.silo_tujuan_id AS silo_id, sup.supplier_name, p.qty_remaining_ltr
       FROM prepast_record p
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
      WHERE p.status_fifo = 'ACTIVE'
        AND p.qty_remaining_ltr > 0
        AND p.status_approval NOT IN ('Rejected','REVISED','VOIDED')
      ORDER BY p.prepast_finish ASC`,
  );

  const perSilo = new Map();
  for (const s of supplier) {
    if (!perSilo.has(s.silo_id)) perSilo.set(s.silo_id, []);
    perSilo.get(s.silo_id).push(
      `${s.supplier_name ?? TANPA_SUPPLIER} (${Number(s.qty_remaining_ltr).toLocaleString('id-ID')} L)`,
    );
  }

  return baris.map((b) => ({
    ...b,
    supplierList: (perSilo.get(b.silo_id) ?? []).join(', '),
    // Silo kosong tidak perlu dicek: tidak ada susu yang dapat menyimpang.
    perluDicek: Number(b.vol_aktual_ltr) > 0,
  }));
}

/**
 * Menyimpan satu ronde pengecekan.
 *
 * Satu waktu cek berlaku untuk seluruh baris, dan seluruhnya berada dalam
 * SATU transaksi: bila satu baris gagal, tidak ada yang tersimpan.
 *
 * @param {{timeCheck: Date, hasil: Array<{siloId:number, ph:number, temp:number}>}} masukan
 */
export async function simpanRonde({ timeCheck, hasil }, aktor, ip) {
  if (!Array.isArray(hasil) || hasil.length === 0) {
    throw new BusinessError('FR-30.1', 'Isi minimal satu silo dalam ronde ini');
  }

  const ganda = hasil.map((h) => h.siloId).filter((v, i, a) => a.indexOf(v) !== i);
  if (ganda.length > 0) {
    throw new BusinessError(
      'FR-30.1',
      `Silo yang sama diisi lebih dari satu kali dalam satu ronde (id ${ganda[0]})`,
    );
  }

  return withTransaction(async (conn) => {
    const [siloBaris] = await conn.query(
      `SELECT v.silo_id, v.silo_name, v.vol_aktual_ltr
         FROM v_silo_volume v WHERE v.is_buffer = FALSE`,
    );
    const infoSilo = new Map(siloBaris.map((s) => [s.silo_id, s]));

    const dibuat = [];
    const diLuarRentang = [];

    for (const h of hasil) {
      const silo = infoSilo.get(h.siloId);
      if (!silo) throw new NotFoundError(`Silo id ${h.siloId}`);

      // FR-7.5 - pH di luar rentang tidak diblokir (pengukurannya nyata),
      // tetapi ditandai agar penyimpangan tidak lewat tanpa terlihat.
      if (h.ph < PH_MIN || h.ph > PH_MAKS) {
        diLuarRentang.push({
          siloName: silo.silo_name, ph: h.ph, min: PH_MIN, maks: PH_MAKS,
        });
      }

      // Daftar supplier & volume disimpan sebagai SNAPSHOT: keduanya berubah
      // setiap kali ada transfer, sehingga menghitungnya ulang di kemudian
      // hari tidak akan menghasilkan keadaan saat pengecekan dilakukan.
      const [supBaris] = await conn.query(
        `SELECT sup.supplier_name, p.qty_remaining_ltr
           FROM prepast_record p
           LEFT JOIN supplier sup ON sup.id = p.supplier_id
          WHERE p.silo_tujuan_id = ?
            AND p.status_fifo = 'ACTIVE'
            AND p.qty_remaining_ltr > 0
            AND p.status_approval NOT IN ('Rejected','REVISED','VOIDED')
          ORDER BY p.prepast_finish ASC`,
        [h.siloId],
      );
      const supplierList = supBaris
        .map((s) => `${s.supplier_name ?? TANPA_SUPPLIER} (${Number(s.qty_remaining_ltr).toLocaleString('id-ID')} L)`)
        .join(', ');

      const kode = await terbitkanId(conn, 'MTR');
      const [res] = await conn.query(
        `INSERT INTO monitoring
           (kode, silo_id, ph_check, temp_check, time_check,
            supplier_list, val_aktual_snapshot_ltr, operator_id, status_approval)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending Approval')`,
        [kode, h.siloId, h.ph, h.temp, timeCheck, supplierList,
          silo.vol_aktual_ltr, aktor.id],
      );

      dibuat.push({ id: res.insertId, kode, siloId: h.siloId, siloName: silo.silo_name });
    }

    for (const d of dibuat) {
      await catatAudit(conn, {
        entity: 'monitoring', entityId: d.id, action: 'CREATE',
        actorId: aktor.id, after: { ...d, timeCheck }, ip,
      });
    }

    return { dibuat, diLuarRentang };
  });
}

export async function daftar({ halaman = 1, perHalaman = 25, siloId, status }) {
  const syarat = [];
  const nilai = [];
  if (siloId) { syarat.push('m.silo_id = ?'); nilai.push(siloId); }
  if (status) { syarat.push('m.status_approval = ?'); nilai.push(status); }

  const where = syarat.length ? `WHERE ${syarat.join(' AND ')}` : '';
  const offset = (halaman - 1) * perHalaman;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM monitoring m ${where}`, nilai,
  );
  const [baris] = await pool.query(
    `SELECT m.id, m.kode, m.ph_check, m.temp_check, m.time_check,
            m.supplier_list, m.val_aktual_snapshot_ltr, m.status_approval,
            s.silo_name, o.nama_lengkap AS operator_nama
       FROM monitoring m
       JOIN silo s     ON s.id = m.silo_id
       JOIN operator o ON o.id = m.operator_id
       ${where}
      ORDER BY m.time_check DESC, m.id DESC
      LIMIT ? OFFSET ?`,
    [...nilai, perHalaman, offset],
  );
  return { data: baris, total, halaman, perHalaman };
}
