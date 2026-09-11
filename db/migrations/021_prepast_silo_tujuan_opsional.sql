-- ============================================================
-- 021_prepast_silo_tujuan_opsional.sql
-- Silo tujuan Prepast boleh dilengkapi setelah record dibuat.
-- Record tanpa silo tetap berstatus GANTUNG dan tidak masuk FIFO/approval.
-- ============================================================

ALTER TABLE prepast_record
  MODIFY COLUMN silo_tujuan_id BIGINT NULL
  COMMENT 'NULL = silo tujuan belum ditentukan dan record masih GANTUNG';

UPDATE prepast_record
   SET is_gantung = (
     silo_tujuan_id IS NULL
     OR prepast_start IS NULL
     OR prepast_finish IS NULL
     OR flowrate_pst IS NULL
     OR temp_after_heater IS NULL
     OR temp_output_prd IS NULL
   )
 WHERE jenis_batch = 'PREPAST';
