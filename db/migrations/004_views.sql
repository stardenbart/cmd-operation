-- ============================================================
-- 004_views.sql — VIEW turunan
-- PRD Bagian 8.3
--
-- Menggantikan pola filter empat-kondisi yang di Power Apps disalin
-- >30 kali di seluruh YAML, sebagian sudah tidak sinkron (B-9, M-8).
-- ============================================================

-- --- Volume aktual per silo (BR-01) ---
-- Buffer  : dihitung dari sisa RECEIVING
-- Silo    : dihitung dari sisa PREPAST
-- Keduanya tidak pernah bertumpuk pada silo_id yang sama, karena buffer
-- hanya menerima receiving dan silo penyimpanan hanya menerima prepast.
CREATE OR REPLACE VIEW v_silo_volume AS
SELECT
  s.id                            AS silo_id,
  s.kode,
  s.silo_name,
  s.is_buffer,
  s.kapasitas_maks_ltr,
  s.standing_time_anchor,
  s.monitoring_interval_jam,
  s.urutan,
  COALESCE(v.vol_aktual_ltr, 0)   AS vol_aktual_ltr,
  COALESCE(v.jumlah_batch, 0)     AS jumlah_batch_aktif,
  GREATEST(s.kapasitas_maks_ltr - COALESCE(v.vol_aktual_ltr, 0), 0) AS vol_tersedia_ltr,
  CASE WHEN s.kapasitas_maks_ltr > 0
       THEN ROUND(COALESCE(v.vol_aktual_ltr, 0) / s.kapasitas_maks_ltr * 100, 0)
       ELSE 0 END                 AS persen_isi
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


-- --- Status monitoring per silo (FR-2.3, BR-10) ---
-- Ambang berasal dari KOLOM silo.monitoring_interval_jam, bukan dari
-- perbandingan nama silo. Inilah yang mencabut akar B-19.
CREATE OR REPLACE VIEW v_silo_monitoring_status AS
SELECT
  sv.silo_id,
  sv.kode,
  sv.silo_name,
  sv.vol_aktual_ltr,
  sv.monitoring_interval_jam,
  m.time_check                AS last_check_at,
  m.ph_check                  AS last_ph,
  m.temp_check                AS last_temp,
  TIMESTAMPDIFF(MINUTE, m.time_check, UTC_TIMESTAMP()) AS menit_sejak_cek,
  CASE
    WHEN sv.vol_aktual_ltr <= 0            THEN 'KOSONG'
    WHEN m.time_check IS NULL              THEN 'BELUM_PERNAH'
    WHEN TIMESTAMPDIFF(MINUTE, m.time_check, UTC_TIMESTAMP())
         > sv.monitoring_interval_jam * 60 THEN 'PERLU_DICEK'
    ELSE 'OK'
  END                         AS status_cek,
  CASE
    WHEN sv.standing_time_anchor IS NULL THEN NULL
    ELSE TIMESTAMPDIFF(MINUTE, sv.standing_time_anchor, UTC_TIMESTAMP())
  END                         AS standing_time_menit
FROM v_silo_volume sv
LEFT JOIN monitoring m
  ON m.id = (
    SELECT m2.id FROM monitoring m2
    WHERE m2.silo_id = sv.silo_id
      AND m2.status_approval NOT IN ('Rejected','REVISED','VOIDED')
    ORDER BY m2.time_check DESC, m2.id DESC
    LIMIT 1
  );


-- --- Antrean buffer siap prepast (FR-5.1) ---
-- Urut FIFO menaik: yang paling lama diterima, diprepast duluan (BR-04).
CREATE OR REPLACE VIEW v_buffer_queue AS
SELECT
  r.id, r.kode, r.supplier_id, sup.supplier_name,
  r.qty_kg, r.berat_jenis, r.qty_ltr, r.qty_remaining_ltr,
  r.nilai_ts, r.finish_time, r.status_approval, r.buffer_status
FROM receiving r
JOIN supplier sup ON sup.id = r.supplier_id
JOIN silo s       ON s.id = r.silo_id
WHERE s.is_buffer = TRUE
  AND r.status_fifo = 'ACTIVE'
  AND r.qty_remaining_ltr > 0
  AND r.status_approval NOT IN ('Rejected','REVISED','VOIDED')
ORDER BY r.finish_time ASC, r.id ASC;


-- --- Batch prepast siap ditransfer, urut FIFO (BR-04) ---
-- Pemecah seri `id` bersifat WAJIB: Power Apps tidak menetapkannya, sehingga
-- dua batch berwaktu selesai sama urutannya bergantung pada urutan
-- pengembalian SharePoint — yang tidak dijamin (uji T-5.7).
CREATE OR REPLACE VIEW v_fifo_queue AS
SELECT
  p.id, p.kode, p.silo_tujuan_id, p.supplier_id, sup.supplier_name,
  p.vol_prepast_ltr, p.qty_remaining_ltr, p.prepast_finish, p.nilai_ts
FROM prepast_record p
JOIN supplier sup ON sup.id = p.supplier_id
WHERE p.status_fifo = 'ACTIVE'
  AND p.qty_remaining_ltr > 0
  AND p.status_approval NOT IN ('Rejected','REVISED','VOIDED')
ORDER BY p.prepast_finish ASC, p.id ASC;


-- --- Antrean approval gabungan lintas modul (FR-16.1) ---
CREATE OR REPLACE VIEW v_approval_queue AS
SELECT 'receiving' AS modul, r.id, r.kode, r.created_at, r.operator_id,
       CONCAT(sup.supplier_name, ' — ', FORMAT(r.qty_ltr, 0), ' L') AS ringkasan
FROM receiving r JOIN supplier sup ON sup.id = r.supplier_id
WHERE r.status_approval = 'Pending Approval'
UNION ALL
SELECT 'prepast', p.id, p.kode, p.created_at, p.operator_id,
       CONCAT(sup.supplier_name, ' → ', s.silo_name, ' — ', FORMAT(p.vol_prepast_ltr, 0), ' L')
FROM prepast_record p JOIN supplier sup ON sup.id = p.supplier_id
                      JOIN silo s ON s.id = p.silo_tujuan_id
WHERE p.status_approval = 'Pending Approval' AND p.prepast_finish IS NOT NULL
UNION ALL
SELECT 'transfer', t.id, t.kode, t.created_at, t.operator_id,
       CONCAT(s.silo_name, ' — ', FORMAT(t.vol_ltr, 0), ' L')
FROM transfer t JOIN silo s ON s.id = t.silo_asal_id
WHERE t.status_approval = 'Pending Approval' AND t.trf_time IS NOT NULL
UNION ALL
SELECT 'monitoring', m.id, m.kode, m.created_at, m.operator_id,
       CONCAT(s.silo_name, ' — pH ', m.ph_check, ', ', m.temp_check, '°C')
FROM monitoring m JOIN silo s ON s.id = m.silo_id
WHERE m.status_approval = 'Pending Approval';
