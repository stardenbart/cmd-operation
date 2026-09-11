-- ============================================================
-- 024_receiving_bj_ts_opsional.sql
-- Berat Jenis dan Total Solid Receiving boleh dilengkapi belakangan.
-- Tanpa BJ, volume liter belum dapat dihitung dan tidak masuk stok buffer.
-- ============================================================

ALTER TABLE receiving
  DROP CHECK ck_rcv_remaining,
  DROP CHECK ck_rcv_positif;

ALTER TABLE receiving
  MODIFY COLUMN berat_jenis DECIMAL(8,4) NULL
    COMMENT 'NULL = Berat Jenis belum diukur',
  MODIFY COLUMN qty_ltr DECIMAL(12,2) NULL
    COMMENT 'FLOOR(kg/bj); NULL selama Berat Jenis belum diisi',
  MODIFY COLUMN qty_remaining_ltr DECIMAL(12,2) NULL
    COMMENT 'NULL selama volume liter belum dapat dihitung',
  ADD COLUMN is_gantung BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'TRUE bila Berat Jenis atau Total Solid belum diisi'
    AFTER cmd_source,
  ADD INDEX idx_rcv_gantung (is_gantung);

ALTER TABLE receiving
  ADD CONSTRAINT ck_rcv_remaining CHECK (
    (qty_ltr IS NULL AND qty_remaining_ltr IS NULL)
    OR
    (qty_ltr IS NOT NULL
      AND qty_remaining_ltr >= 0
      AND qty_remaining_ltr <= qty_ltr)
  ),
  ADD CONSTRAINT ck_rcv_positif CHECK (
    qty_kg > 0
    AND (berat_jenis IS NULL OR berat_jenis > 0)
    AND (
      (berat_jenis IS NULL AND qty_ltr IS NULL)
      OR (berat_jenis IS NOT NULL AND qty_ltr IS NOT NULL)
    )
  );

UPDATE receiving
   SET is_gantung = (berat_jenis IS NULL OR nilai_ts IS NULL);

-- Receiving yang belum lengkap tidak boleh muncul di antrean approval.
CREATE OR REPLACE VIEW v_approval_queue AS
SELECT 'receiving' AS modul, r.id, r.kode, r.created_at, r.operator_id,
       CONCAT(sup.supplier_name, ' - ', FORMAT(r.qty_ltr, 0), ' L') AS ringkasan
FROM receiving r JOIN supplier sup ON sup.id = r.supplier_id
WHERE r.status_approval = 'Pending Approval'
  AND r.is_gantung = FALSE
UNION ALL
SELECT 'prepast', p.id, p.kode, p.created_at, p.operator_id,
       CONCAT(sup.supplier_name, ' ke ', s.silo_name, ' - ', FORMAT(p.vol_prepast_ltr, 0), ' L')
FROM prepast_record p JOIN supplier sup ON sup.id = p.supplier_id
                      JOIN silo s ON s.id = p.silo_tujuan_id
WHERE p.status_approval = 'Pending Approval'
  AND p.jenis_batch = 'PREPAST'
  AND p.is_gantung = FALSE
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
