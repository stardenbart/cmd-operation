-- ============================================================
-- 006_toleransi_silo.sql — Toleransi kapasitas silo (BR-24)
--
-- Tiap silo dapat menampung sampai 1.000 L di atas kapasitas nominalnya.
-- Kapasitas nominal adalah angka rancangan; toleransi adalah kelebihan
-- yang masih dapat diterima secara fisik.
--
-- Dipisahkan menjadi kolom sendiri, bukan ditambahkan ke kapasitas_maks_ltr,
-- karena keduanya menjawab pertanyaan berbeda:
--   kapasitas_maks_ltr  -> dasar perhitungan persen isi & pelaporan
--   toleransi_ltr       -> batas keras penolakan input
-- Menggabungkannya akan membuat silo 25.000 L tampak 96% penuh saat
-- berisi 25.000 L, padahal secara nominal ia sudah tepat penuh.
-- ============================================================

ALTER TABLE silo
  ADD COLUMN toleransi_ltr DECIMAL(12,2) NOT NULL DEFAULT 1000
    COMMENT 'BR-24 — kelebihan yang masih dapat diterima di atas kapasitas nominal'
    AFTER kapasitas_maks_ltr;

-- VIEW dibangun ulang agar membedakan tiga besaran:
--   vol_tersedia_ltr        -> sampai kapasitas NOMINAL (untuk tampilan)
--   vol_tersedia_toleransi  -> sampai kapasitas + toleransi (batas keras input)
--   persen_isi              -> tetap terhadap NOMINAL, sehingga >100% terlihat
CREATE OR REPLACE VIEW v_silo_volume AS
SELECT
  s.id                            AS silo_id,
  s.kode,
  s.silo_name,
  s.is_buffer,
  s.kapasitas_maks_ltr,
  s.toleransi_ltr,
  s.kapasitas_maks_ltr + s.toleransi_ltr AS kapasitas_dengan_toleransi_ltr,
  s.standing_time_anchor,
  s.monitoring_interval_jam,
  s.urutan,
  COALESCE(v.vol_aktual_ltr, 0)   AS vol_aktual_ltr,
  COALESCE(v.jumlah_batch, 0)     AS jumlah_batch_aktif,
  GREATEST(s.kapasitas_maks_ltr - COALESCE(v.vol_aktual_ltr, 0), 0) AS vol_tersedia_ltr,
  GREATEST(
    s.kapasitas_maks_ltr + s.toleransi_ltr - COALESCE(v.vol_aktual_ltr, 0), 0
  )                               AS vol_tersedia_toleransi_ltr,
  CASE WHEN s.kapasitas_maks_ltr > 0
       THEN ROUND(COALESCE(v.vol_aktual_ltr, 0) / s.kapasitas_maks_ltr * 100, 0)
       ELSE 0 END                 AS persen_isi,
  -- TRUE bila isinya sudah melampaui kapasitas nominal namun masih di dalam
  -- toleransi — keadaan yang sah tetapi patut ditandai di dashboard.
  COALESCE(v.vol_aktual_ltr, 0) > s.kapasitas_maks_ltr AS dalam_toleransi
FROM silo s
LEFT JOIN (
  SELECT silo_id AS sid, SUM(qty_remaining_ltr) AS vol_aktual_ltr, COUNT(*) AS jumlah_batch
  FROM receiving
  WHERE status_fifo = 'ACTIVE'
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_id
  UNION ALL
  SELECT silo_tujuan_id, SUM(qty_remaining_ltr), COUNT(*)
  FROM prepast_record
  WHERE status_fifo = 'ACTIVE'
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_tujuan_id
) v ON v.sid = s.id
WHERE s.is_active = TRUE;
