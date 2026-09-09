/**
 * Data real-time dashboard - sumber tunggal.
 *
 * Kartu silo, ringkasan stok, dan papan batch aktif dipakai DUA konsumen:
 * dashboard ber-login (routes/silo.js) dan tautan publik read-only
 * (routes/public.js). Kueri & perhitungan standing time harus SATU tempat -
 * dua definisi yang berbeda antara halaman berlogin dan halaman publik akan
 * menampilkan angka yang tidak konsisten untuk data yang sama.
 *
 * Hanya mode REAL-TIME yang ada di sini; snapshot historis (dengan filter
 * rentang) tetap khusus dashboard berlogin dan tinggal di route-nya.
 */

import { pool } from '../db/pool.js';
import { selisihMenit } from './waktu.js';
import { anchorSiloLangsung } from './standingSilo.js';

/** Kartu silo + ringkasan stok, real-time. */
export async function siloLive() {
  const [baris] = await pool.query(
    `SELECT v.silo_id, v.kode, v.silo_name, v.is_buffer, v.urutan,
            v.vol_aktual_ltr, v.jumlah_batch_aktif,
            v.kapasitas_maks_ltr, v.toleransi_ltr,
            v.kapasitas_dengan_toleransi_ltr, v.vol_tersedia_ltr,
            v.persen_isi, v.dalam_toleransi, v.standing_time_anchor,
            v.monitoring_interval_jam,
            m.last_check_at, m.last_ph, m.last_temp,
            m.menit_sejak_cek, m.status_cek, m.standing_time_menit
       FROM v_silo_volume v
       JOIN v_silo_monitoring_status m ON m.silo_id = v.silo_id
      ORDER BY v.urutan`,
  );

  // Anchor dihitung ulang dari batch AKTIF yang nyata (bukan kolom tersimpan
  // yang bisa basi, bukan pula rekonstruksi transfer yang rapuh).
  const saatIni = new Date();
  const anchorSaatIni = await anchorSiloLangsung();
  for (const b of baris) {
    if (b.is_buffer) continue;
    const a = Number(b.vol_aktual_ltr) > 0
      ? anchorSaatIni.get(Number(b.silo_id)) ?? null : null;
    b.standing_time_anchor = a;
    b.standing_time_menit = a ? Math.max(0, selisihMenit(a, saatIni)) : null;
  }

  const penyimpanan = baris.filter((b) => !b.is_buffer);
  return {
    data: baris,
    ringkasan: {
      totalVolLtr: penyimpanan.reduce((s, b) => s + Number(b.vol_aktual_ltr), 0),
      totalKapasitasLtr: penyimpanan.reduce((s, b) => s + Number(b.kapasitas_maks_ltr), 0),
      perluDicek: baris.filter((b) => b.status_cek === 'PERLU_DICEK').length,
      melampauiNominal: baris.filter((b) => b.dalam_toleransi).length,
    },
  };
}

/** Papan batch aktif per silo, real-time. */
export async function batchAktifLive() {
  const [baris] = await pool.query(
    `SELECT v.silo_id, v.kode AS silo_kode, v.silo_name,
            p.id AS prepast_id, p.kode AS batch_kode, p.jenis_batch,
            sup.supplier_name, p.qty_remaining_ltr, p.nilai_ts,
            p.prepast_finish,
            TIMESTAMPDIFF(MINUTE, p.prepast_finish, UTC_TIMESTAMP()) AS standing_menit,
            ms.standing_time_menit AS standing_silo_menit,
            sl.standing_time_anchor AS standing_silo_sejak
       FROM prepast_record p
       JOIN v_silo_volume v ON v.silo_id = p.silo_tujuan_id
       JOIN v_silo_monitoring_status ms ON ms.silo_id = p.silo_tujuan_id
       JOIN silo sl ON sl.id = p.silo_tujuan_id
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
      WHERE p.status_fifo = 'ACTIVE'
        AND p.qty_remaining_ltr > 0
        AND p.status_approval NOT IN ('Rejected', 'REVISED', 'VOIDED')
      ORDER BY v.urutan, p.prepast_finish ASC, p.id ASC`,
  );

  const saatIni = new Date();
  const anchorSaatIni = await anchorSiloLangsung();

  return baris.map((b) => ({
    siloId: b.silo_id,
    siloKode: b.silo_kode,
    siloName: b.silo_name,
    prepastId: b.prepast_id,
    batchKode: b.batch_kode,
    jenisBatch: b.jenis_batch,
    supplierName: b.supplier_name,
    volumeLtr: Number(b.qty_remaining_ltr),
    nilaiTs: b.nilai_ts === null ? null : Number(b.nilai_ts),
    prepastFinish: b.prepast_finish,
    standingMenit: b.standing_menit === null ? null : Number(b.standing_menit),
    standingSiloMenit: anchorSaatIni.get(Number(b.silo_id))
      ? Math.max(0, selisihMenit(anchorSaatIni.get(Number(b.silo_id)), saatIni))
      : null,
    prepastFinishIso: b.prepast_finish ? new Date(b.prepast_finish).toISOString() : null,
    standingSiloSejak: anchorSaatIni.get(Number(b.silo_id))?.toISOString() ?? null,
  }));
}
