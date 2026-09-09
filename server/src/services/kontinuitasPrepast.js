import { pool } from '../db/pool.js';

const STATUS_NYATA = ['Approved', 'Pending Approval'];
const SEMENIT = 60_000;

/**
 * Sumber kebenaran tunggal kontinuitas Prepast (PRD v7 §3 dan §7).
 * Form input dan laporan wajib memanggil fungsi ini, bukan menyalin aturannya.
 * Input form hanya memiliki presisi menit, sehingga detik selalu diabaikan.
 */
export function menit(nilai) {
  if (!nilai) return null;
  const tanggal = nilai instanceof Date ? nilai : new Date(nilai);
  return Number.isNaN(tanggal.getTime()) ? null : Math.floor(tanggal.getTime() / SEMENIT);
}

export function kontinu(sebelumnya, berikutnya) {
  return Boolean(
    sebelumnya
    && berikutnya
    && menit(sebelumnya.finish) === menit(berikutnya.start),
  );
}

/**
 * Kontinuitas untuk PERHITUNGAN SESI analitik.
 *
 * Checkbox pada form sengaja memakai `kontinu()` yang bersifat global, sebab
 * ia mengambil waktu record terakhir plant. Frekuensi operasional berbeda:
 * perpindahan silo selalu memulai sesi baru meskipun waktunya bersambung.
 */
export function kontinuDalamSilo(sebelumnya, berikutnya) {
  return Boolean(
    sebelumnya
    && berikutnya
    && Number(sebelumnya.siloId) === Number(berikutnya.siloId)
    && kontinu(sebelumnya, berikutnya),
  );
}

/** Record Prepast terakhir di seluruh plant, tidak dibatasi silo tujuan. */
export async function recordTerakhir(conn, { kunci = false, excludeId = null } = {}) {
  const eksekutor = conn ?? pool;
  const kecualikan = excludeId == null ? '' : 'AND p.id <> ?';
  const [baris] = await eksekutor.query(
    `SELECT p.id, p.kode, p.silo_tujuan_id AS siloId,
            p.prepast_start AS start, p.prepast_finish AS finish,
            p.vol_prepast_ltr AS volumeLtr, p.status_approval AS status,
            r.kode AS receivingKode, sup.supplier_name AS supplierName,
            s.silo_name AS siloName
       FROM prepast_record p
       LEFT JOIN receiving r ON r.id = p.receiving_id
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
       JOIN silo s ON s.id = p.silo_tujuan_id
      WHERE s.is_buffer = FALSE
        AND COALESCE(p.jenis_batch, 'PREPAST') = 'PREPAST'
        AND p.prepast_finish IS NOT NULL
        AND p.status_approval IN (?, ?)
        ${kecualikan}
      ORDER BY p.prepast_finish DESC, p.id DESC
      LIMIT 1${kunci ? ' FOR UPDATE' : ''}`,
    excludeId == null ? STATUS_NYATA : [...STATUS_NYATA, excludeId],
  );
  return baris[0] ?? null;
}

export function kelompokkan(records) {
  const sesi = [];
  let sebelumnya = null;
  let aktif = null;

  for (const record of records) {
    const prosesSama = sebelumnya
      && Number(sebelumnya.siloId) === Number(record.siloId)
      && String(sebelumnya.supplierName ?? '').trim().toUpperCase()
        === String(record.supplierName ?? '').trim().toUpperCase()
      && menit(sebelumnya.start) === menit(record.start)
      && menit(sebelumnya.finish) === menit(record.finish);
    if (!sebelumnya || (!prosesSama && !kontinuDalamSilo(sebelumnya, record))) {
      aktif = {
        id: `PSTF-${record.siloId}-${record.id}`,
        siloId: Number(record.siloId),
        siloName: record.siloName,
        start: record.start,
        finish: record.finish,
        volumeLtr: 0,
        jumlahRecord: 0,
        records: [],
      };
      sesi.push(aktif);
    }
    aktif.finish = record.finish;
    aktif.volumeLtr += Number(record.volumeLtr ?? 0);
    aktif.jumlahRecord += 1;
    aktif.records.push({
      id: record.id,
      kode: record.kode,
      siloId: Number(record.siloId),
      siloName: record.siloName,
      receivingKode: record.receivingKode,
      supplierName: record.supplierName,
      start: record.start,
      finish: record.finish,
      volumeLtr: Number(record.volumeLtr ?? 0),
      status: record.status,
    });
    sebelumnya = record;
  }
  return sesi;
}

/** Hitung ulang secara dinamis agar data lama langsung mengikuti rule v7. */
export async function daftarSesi({ mulai, akhir, siloIds = [] }) {
  const [baris] = await pool.query(
    `SELECT p.id, p.kode, p.silo_tujuan_id AS siloId,
            p.prepast_start AS start, p.prepast_finish AS finish,
            p.vol_prepast_ltr AS volumeLtr, p.status_approval AS status,
            r.kode AS receivingKode, sup.supplier_name AS supplierName,
            s.silo_name AS siloName
       FROM prepast_record p
       LEFT JOIN receiving r ON r.id = p.receiving_id
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
       JOIN silo s ON s.id = p.silo_tujuan_id
      WHERE s.is_buffer = FALSE
        AND COALESCE(p.jenis_batch, 'PREPAST') = 'PREPAST'
        AND p.prepast_start IS NOT NULL AND p.prepast_finish IS NOT NULL
        AND p.prepast_finish <= ?
        AND p.status_approval IN (?, ?)
      ORDER BY p.prepast_start, p.prepast_finish, p.silo_tujuan_id, p.id`,
    [akhir, ...STATUS_NYATA],
  );

  let hasil = kelompokkan(baris).filter(
    (s) => new Date(s.finish) >= mulai && new Date(s.start) <= akhir,
  );
  if (siloIds.length) {
    const dipilih = new Set(siloIds.map(Number));
    hasil = hasil.filter((s) => dipilih.has(Number(s.siloId)));
  }
  return hasil;
}
