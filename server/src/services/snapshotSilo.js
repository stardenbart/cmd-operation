import { pool } from '../db/pool.js';
import { selisihMenit } from './waktu.js';
import { ambilAnchorSiloHistoris, batasiBatchPadaSiklus } from './standingSilo.js';

/**
 * Anchor = waktu masuk batch TERTUA yang masih benar-benar berisi susu.
 *
 * Inilah "silo mulai terisi pada siklus ini" versi BR-09 yang tahan terhadap
 * data transfer yang tidak lengkap: yang dihitung hanya susu yang nyata ada
 * sekarang, bukan hasil memutar ulang setiap transfer (yang gagal mendeteksi
 * silo kosong bila transfer pengurasnya tidak ikut terekspor).
 */
function anchorTerlamaBatch(daftar) {
  const waktu = daftar
    .map((b) => new Date(b.waktu_masuk_silo).getTime())
    .filter((n) => Number.isFinite(n));
  return waktu.length ? new Date(Math.min(...waktu)) : null;
}

/**
 * Rekonstruksi keadaan seluruh silo PADA suatu titik waktu `sampai`.
 *
 * SATU SUMBER, DIPAKAI DUA TEMPAT.
 *
 * Dashboard (mode historis) dan grafik standing time di Analitik sama-sama
 * bertanya "berapa isi tiap silo dan sudah berapa lama berdiri PADA akhir
 * rentang yang dipilih". Sebelumnya dashboard menghitungnya sendiri sementara
 * Analitik membaca view live yang selalu menghitung sampai SEKARANG - sehingga
 * memilih rentang bulan lalu tetap menampilkan standing time hari ini. Dengan
 * memusatkannya di sini, keduanya memakai kamus yang sama dan tidak mungkin
 * berbeda.
 *
 * Standing time diukur dari jangkar siklus isi silo (BR-09) sampai `sampai`,
 * bukan sampai jam sekarang. Volume, pengecekan, dan batch aktif semuanya
 * direkonstruksi ke titik waktu yang sama.
 */
export async function snapshotSilo(sampai) {
  const [master] = await pool.query(
    `SELECT id AS silo_id, kode, silo_name, is_buffer, urutan,
            kapasitas_maks_ltr, 1000 AS toleransi_ltr, monitoring_interval_jam
       FROM silo WHERE is_active = TRUE ORDER BY urutan`,
  );
  const [batchSemua] = await pool.query(
    `SELECT p.id, p.kode, p.silo_tujuan_id AS silo_id, p.jenis_batch,
            sup.supplier_name, p.nilai_ts, p.prepast_finish,
            CASE WHEN p.jenis_batch = 'PENGEMBALIAN'
                 THEN p.prepast_start ELSE p.prepast_finish END AS waktu_masuk_silo,
            GREATEST(p.vol_prepast_ltr - COALESCE(SUM(
              CASE WHEN t.trf_time <= ? AND t.status_approval IN ('Approved','Pending Approval')
                   THEN ta.qty_allocated ELSE 0 END
            ), 0), 0) AS sisa
       FROM prepast_record p
       LEFT JOIN transfer_allocation ta ON ta.prepast_id = p.id
       LEFT JOIN transfer t ON t.id = ta.transfer_id
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
      WHERE p.prepast_finish <= ?
        AND p.status_approval IN ('Approved','Pending Approval')
      GROUP BY p.id, p.kode, p.silo_tujuan_id, p.jenis_batch,
               sup.supplier_name, p.nilai_ts, p.prepast_start, p.prepast_finish
      HAVING sisa > 0
      ORDER BY p.silo_tujuan_id, p.prepast_finish, p.id`,
    [sampai, sampai],
  );

  // Batch sebelum transfer penuh terakhir tidak boleh hidup kembali hanya
  // karena alokasi FIFO historisnya tidak lengkap. Transfer dengan volume
  // sama dengan snapshot volume aktual adalah bukti eksplisit silo kosong.
  const [kosongTerakhir] = await pool.query(
    `SELECT t.silo_asal_id AS silo_id, MAX(t.trf_time) AS saat_kosong
       FROM transfer t
      WHERE t.trf_time <= ?
        AND t.status_approval IN ('Approved','Pending Approval')
        AND ROUND(t.vol_ltr * 100) = ROUND(t.vol_akt_silo_ltr * 100)
      GROUP BY t.silo_asal_id`,
    [sampai],
  );
  const batchHistoris = batasiBatchPadaSiklus(batchSemua, kosongTerakhir);

  const [terakhir] = await pool.query(
    `SELECT UNIX_TIMESTAMP(MAX(waktu)) * 1000 AS waktu_ms FROM (
       SELECT MAX(finish_time) AS waktu FROM receiving
       UNION ALL SELECT MAX(prepast_finish) FROM prepast_record
       UNION ALL SELECT MAX(trf_time) FROM transfer
     ) seluruh_waktu`,
  );
  const waktuTerakhirMentah = terakhir[0]?.waktu_ms;
  const waktuTerakhirMs = Number(waktuTerakhirMentah);
  const snapshotSetelahTransaksiTerakhir = waktuTerakhirMentah !== null
    && waktuTerakhirMentah !== undefined && Number.isFinite(waktuTerakhirMs)
    && new Date(sampai).getTime() >= waktuTerakhirMs;

  const [buffer] = snapshotSetelahTransaksiTerakhir
    ? await pool.query(
      `SELECT r.silo_id, r.qty_remaining_ltr AS sisa
         FROM receiving r
        WHERE r.status_fifo = 'ACTIVE' AND r.qty_remaining_ltr > 0
          AND r.status_approval NOT IN ('Rejected','REVISED','VOIDED')`,
    )
    : await pool.query(
      `SELECT r.silo_id, GREATEST(r.qty_ltr - COALESCE(SUM(
              CASE WHEN p.prepast_finish <= ? AND p.status_approval IN ('Approved','Pending Approval')
                   THEN p.vol_prepast_ltr ELSE 0 END
            ), 0), 0) AS sisa
       FROM receiving r
       LEFT JOIN prepast_record p ON p.receiving_id = r.id
      WHERE r.finish_time <= ? AND r.status_approval IN ('Approved','Pending Approval')
      GROUP BY r.id, r.silo_id, r.qty_ltr
      HAVING sisa > 0`,
      [sampai, sampai],
    );
  /*
   * Batch silo pada snapshot ini.
   *
   * LIVE (snapshot >= transaksi terakhir): pakai keadaan FIFO LANGSUNG -
   * batch yang status_fifo-nya masih ACTIVE dan qty_remaining-nya > 0. Inilah
   * susu yang benar-benar ada di silo menurut mesin FIFO aplikasi; batch lama
   * yang sudah terkuras ditandai CLOSED walau data transfer impornya tak
   * lengkap, sehingga tidak ikut menyeret anchor ke masa lalu.
   *
   * HISTORIS: pakai rekonstruksi (batasiBatchPadaSiklus), sebab qty_remaining
   * hanya menggambarkan keadaan SEKARANG, bukan pada titik waktu lampau.
   */
  let batch = batchHistoris;
  if (snapshotSetelahTransaksiTerakhir) {
    const [batchLive] = await pool.query(
      `SELECT p.id, p.kode, p.silo_tujuan_id AS silo_id, p.jenis_batch,
              sup.supplier_name, p.nilai_ts, p.prepast_finish,
              CASE WHEN p.jenis_batch = 'PENGEMBALIAN'
                   THEN p.prepast_start ELSE p.prepast_finish END AS waktu_masuk_silo,
              p.qty_remaining_ltr AS sisa
         FROM prepast_record p
         LEFT JOIN supplier sup ON sup.id = p.supplier_id
        WHERE p.status_fifo = 'ACTIVE' AND p.qty_remaining_ltr > 0
          AND p.status_approval NOT IN ('Rejected','REVISED','VOIDED')
        ORDER BY p.silo_tujuan_id, waktu_masuk_silo, p.id`,
    );
    batch = batchLive;
  }

  const [monitoring] = await pool.query(
    `SELECT m.silo_id, m.time_check AS last_check_at, m.ph_check AS last_ph,
            m.temp_check AS last_temp
       FROM monitoring m
      WHERE m.time_check <= ? AND m.status_approval IN ('Approved','Pending Approval')
        AND m.id = (SELECT m2.id FROM monitoring m2
                     WHERE m2.silo_id = m.silo_id AND m2.time_check <= ?
                       AND m2.status_approval IN ('Approved','Pending Approval')
                     ORDER BY m2.time_check DESC, m2.id DESC LIMIT 1)`,
    [sampai, sampai],
  );
  const mon = new Map(monitoring.map((m) => [Number(m.silo_id), m]));
  // Anchor historis (rekonstruksi transfer) hanya dipakai untuk snapshot lampau;
  // saat live, anchor diambil dari batch aktif yang nyata (anchorTerlamaBatch).
  const anchorHistoris = snapshotSetelahTransaksiTerakhir
    ? null : await ambilAnchorSiloHistoris(sampai);
  return {
    batch,
    silos: master.map((s) => {
      const daftar = s.is_buffer
        ? buffer.filter((b) => Number(b.silo_id) === Number(s.silo_id))
        : batch.filter((b) => Number(b.silo_id) === Number(s.silo_id));
      const volume = daftar.reduce((n, b) => n + Number(b.sisa), 0);
      const awal = s.is_buffer || volume <= 0
        ? null
        : snapshotSetelahTransaksiTerakhir
          ? anchorTerlamaBatch(daftar)
          : anchorHistoris.get(Number(s.silo_id)) ?? null;
      const m = mon.get(Number(s.silo_id));
      const sejakCek = m ? Math.floor((new Date(sampai) - new Date(m.last_check_at)) / 60_000) : null;
      return {
        ...s,
        vol_aktual_ltr: volume,
        jumlah_batch_aktif: daftar.length,
        kapasitas_dengan_toleransi_ltr: Number(s.kapasitas_maks_ltr) + Number(s.toleransi_ltr),
        vol_tersedia_ltr: Math.max(Number(s.kapasitas_maks_ltr) - volume, 0),
        persen_isi: Number(s.kapasitas_maks_ltr) ? volume / Number(s.kapasitas_maks_ltr) * 100 : 0,
        dalam_toleransi: volume > Number(s.kapasitas_maks_ltr),
        standing_time_anchor: awal,
        standing_time_menit: awal
          ? Math.max(0, selisihMenit(new Date(awal), sampai))
          : null,
        last_check_at: m?.last_check_at ?? null,
        last_ph: m?.last_ph ?? null,
        last_temp: m?.last_temp ?? null,
        menit_sejak_cek: sejakCek,
        status_cek: volume <= 0 ? 'KOSONG' : !m ? 'BELUM_PERNAH'
          : sejakCek >= Number(s.monitoring_interval_jam) * 60 ? 'PERLU_DICEK' : 'OK',
      };
    }),
  };
}
