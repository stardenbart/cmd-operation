-- ============================================================
-- 028_silo_sembunyikan_jika_penuh.sql
-- Preferensi tampilan per silo: sembunyikan dari dropdown pilih silo
-- (Prepast, Lengkapi Prepast) begitu sisanya 0 L. Murni kenyamanan tampilan
-- — silo yang disembunyikan tetap sah dipilih lewat API, dan tetap sah
-- menjadi tujuan yang sedang aktif (silo yang sudah dipilih pada baris
-- tertentu tidak pernah disembunyikan dari baris itu sendiri, lihat
-- frontend). Bawaan FALSE — perilaku lama (semua silo selalu tampil).
-- ============================================================

ALTER TABLE silo
  ADD COLUMN sembunyikan_jika_penuh BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'TRUE: disembunyikan dari dropdown pilih silo begitu sisanya 0 L'
    AFTER is_available;

CREATE OR REPLACE VIEW v_silo_volume AS
SELECT
  s.id                            AS silo_id,
  s.kode,
  s.silo_name,
  s.is_buffer,
  s.kapasitas_maks_ltr,
  CASE WHEN s.toleransi_aktif THEN s.toleransi_ltr ELSE 0 END AS toleransi_ltr,
  s.kapasitas_maks_ltr
    + CASE WHEN s.toleransi_aktif THEN s.toleransi_ltr ELSE 0 END
                                   AS kapasitas_dengan_toleransi_ltr,
  s.standing_time_anchor,
  s.monitoring_interval_jam,
  s.urutan,
  s.sembunyikan_jika_penuh,
  COALESCE(v.vol_aktual_ltr, 0)   AS vol_aktual_ltr,
  COALESCE(v.jumlah_batch, 0)     AS jumlah_batch_aktif,
  COALESCE(v.vol_tak_dikenal_ltr, 0) AS vol_tak_dikenal_ltr,
  CASE WHEN COALESCE(v.vol_aktual_ltr, 0) > 0
       THEN ROUND(COALESCE(v.vol_tak_dikenal_ltr, 0) / v.vol_aktual_ltr * 100, 0)
       ELSE 0 END                 AS persen_tak_dikenal,
  GREATEST(s.kapasitas_maks_ltr - COALESCE(v.vol_aktual_ltr, 0), 0) AS vol_tersedia_ltr,
  GREATEST(
    s.kapasitas_maks_ltr
      + CASE WHEN s.toleransi_aktif THEN s.toleransi_ltr ELSE 0 END
      - COALESCE(v.vol_aktual_ltr, 0),
    0
  )                               AS vol_tersedia_toleransi_ltr,
  CASE WHEN s.kapasitas_maks_ltr > 0
       THEN ROUND(COALESCE(v.vol_aktual_ltr, 0) / s.kapasitas_maks_ltr * 100, 0)
       ELSE 0 END                 AS persen_isi,
  COALESCE(v.vol_aktual_ltr, 0) > s.kapasitas_maks_ltr AS dalam_toleransi
FROM silo s
LEFT JOIN (
  SELECT silo_id AS sid, SUM(qty_remaining_ltr) AS vol_aktual_ltr,
         COUNT(*) AS jumlah_batch, 0 AS vol_tak_dikenal_ltr
  FROM receiving
  WHERE status_fifo = 'ACTIVE'
    AND qty_remaining_ltr > 0
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_id
  UNION ALL
  SELECT silo_tujuan_id, SUM(qty_remaining_ltr), COUNT(*),
         SUM(CASE WHEN supplier_id IS NULL THEN qty_remaining_ltr ELSE 0 END)
  FROM prepast_record
  WHERE status_fifo = 'ACTIVE'
    AND qty_remaining_ltr > 0
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_tujuan_id
) v ON v.sid = s.id
WHERE s.is_active = TRUE;
