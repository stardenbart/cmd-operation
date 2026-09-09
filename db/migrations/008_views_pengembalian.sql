-- ============================================================
-- 008_views_pengembalian.sql - VIEW menyertakan pengembalian
--
-- Pengembalian menambah volume silo seperti batch lain, sehingga ia ikut
-- terhitung di v_silo_volume tanpa perubahan. Yang ditambahkan adalah
-- kemampuan MELIHAT berapa banyak volume yang asal-usulnya tidak diketahui.
--
-- Angka itu penting karena setiap batch produksi yang mengambil dari silo
-- berisi volume tak dikenal akan mewarisi keterputusan telusur tersebut.
-- Menyembunyikannya berarti keterputusan itu baru ketahuan saat penarikan
-- produk, yaitu saat paling mahal.
-- ============================================================

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
  -- BR-25 - volume yang tidak dapat ditelusuri ke supplier mana pun
  COALESCE(v.vol_tak_dikenal_ltr, 0) AS vol_tak_dikenal_ltr,
  CASE WHEN COALESCE(v.vol_aktual_ltr, 0) > 0
       THEN ROUND(COALESCE(v.vol_tak_dikenal_ltr, 0) / v.vol_aktual_ltr * 100, 0)
       ELSE 0 END                 AS persen_tak_dikenal,
  GREATEST(s.kapasitas_maks_ltr - COALESCE(v.vol_aktual_ltr, 0), 0) AS vol_tersedia_ltr,
  GREATEST(
    s.kapasitas_maks_ltr + s.toleransi_ltr - COALESCE(v.vol_aktual_ltr, 0), 0
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
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_id
  UNION ALL
  SELECT silo_tujuan_id, SUM(qty_remaining_ltr), COUNT(*),
         SUM(CASE WHEN supplier_id IS NULL THEN qty_remaining_ltr ELSE 0 END)
  FROM prepast_record
  WHERE status_fifo = 'ACTIVE'
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_tujuan_id
) v ON v.sid = s.id
WHERE s.is_active = TRUE;


-- Antrean FIFO: pengembalian ikut serta seperti batch lain.
-- LEFT JOIN karena supplier boleh kosong; nama ditampilkan apa adanya
-- sebagai "tidak diketahui" di lapis tampilan, bukan diganti nama semu.
CREATE OR REPLACE VIEW v_fifo_queue AS
SELECT
  p.id, p.kode, p.jenis_batch, p.silo_tujuan_id, p.supplier_id,
  sup.supplier_name, p.keterangan_asal,
  p.vol_prepast_ltr, p.qty_remaining_ltr, p.prepast_finish, p.nilai_ts
FROM prepast_record p
LEFT JOIN supplier sup ON sup.id = p.supplier_id
WHERE p.status_fifo = 'ACTIVE'
  AND p.qty_remaining_ltr > 0
  AND p.status_approval NOT IN ('Rejected','REVISED','VOIDED')
ORDER BY p.prepast_finish ASC, p.id ASC;


-- Antrean approval: pengembalian muncul sebagai modulnya sendiri, bukan
-- menyamar sebagai prepast, karena yang disetujui SPV memang peristiwa
-- berbeda dengan pertimbangan berbeda.
CREATE OR REPLACE VIEW v_approval_queue AS
SELECT 'receiving' AS modul, r.id, r.kode, r.created_at, r.operator_id,
       CONCAT(sup.supplier_name, ' - ', FORMAT(r.qty_ltr, 0), ' L') AS ringkasan
FROM receiving r JOIN supplier sup ON sup.id = r.supplier_id
WHERE r.status_approval = 'Pending Approval'
UNION ALL
SELECT 'prepast', p.id, p.kode, p.created_at, p.operator_id,
       CONCAT(sup.supplier_name, ' ke ', s.silo_name, ' - ', FORMAT(p.vol_prepast_ltr, 0), ' L')
FROM prepast_record p JOIN supplier sup ON sup.id = p.supplier_id
                      JOIN silo s ON s.id = p.silo_tujuan_id
WHERE p.status_approval = 'Pending Approval'
  AND p.jenis_batch = 'PREPAST'
  AND p.prepast_finish IS NOT NULL
UNION ALL
SELECT 'pengembalian', p.id, p.kode, p.created_at, p.operator_id,
       CONCAT('Kembali ke ', s.silo_name, ' - ', FORMAT(p.vol_prepast_ltr, 0), ' L',
              CASE WHEN p.supplier_id IS NULL THEN ' (asal tidak diketahui)' ELSE '' END)
FROM prepast_record p JOIN silo s ON s.id = p.silo_tujuan_id
WHERE p.status_approval = 'Pending Approval'
  AND p.jenis_batch = 'PENGEMBALIAN'
UNION ALL
SELECT 'transfer', t.id, t.kode, t.created_at, t.operator_id,
       CONCAT(s.silo_name, ' - ', FORMAT(t.vol_ltr, 0), ' L')
FROM transfer t JOIN silo s ON s.id = t.silo_asal_id
WHERE t.status_approval = 'Pending Approval' AND t.trf_time IS NOT NULL
UNION ALL
SELECT 'monitoring', m.id, m.kode, m.created_at, m.operator_id,
       CONCAT(s.silo_name, ' - pH ', m.ph_check, ', ', m.temp_check, ' C')
FROM monitoring m JOIN silo s ON s.id = m.silo_id
WHERE m.status_approval = 'Pending Approval';
