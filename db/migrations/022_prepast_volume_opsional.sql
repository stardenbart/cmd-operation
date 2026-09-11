-- ============================================================
-- 022_prepast_volume_opsional.sql
-- Volume Prepast boleh dilengkapi setelah record dibuat.
-- NULL berarti volume belum diketahui; record tetap GANTUNG dan belum
-- mengurangi buffer maupun menambah isi silo sampai volumenya dilengkapi.
-- ============================================================

ALTER TABLE prepast_record
  DROP CHECK ck_pst_remaining,
  DROP CHECK ck_pst_volume;

ALTER TABLE prepast_record
  MODIFY COLUMN vol_prepast_ltr DECIMAL(12,2) NULL
    COMMENT 'NULL = volume belum diisi dan record masih GANTUNG',
  MODIFY COLUMN qty_remaining_ltr DECIMAL(12,2) NULL
    COMMENT 'NULL selama volume belum diisi';

ALTER TABLE prepast_record
  ADD CONSTRAINT ck_pst_remaining CHECK (
    (vol_prepast_ltr IS NULL AND qty_remaining_ltr IS NULL)
    OR
    (vol_prepast_ltr IS NOT NULL
      AND qty_remaining_ltr >= 0
      AND qty_remaining_ltr <= vol_prepast_ltr)
  ),
  ADD CONSTRAINT ck_pst_volume CHECK (
    vol_prepast_ltr IS NULL OR vol_prepast_ltr > 0
  );

UPDATE prepast_record
   SET is_gantung = (
     silo_tujuan_id IS NULL
     OR vol_prepast_ltr IS NULL
     OR prepast_start IS NULL
     OR prepast_finish IS NULL
     OR flowrate_pst IS NULL
     OR temp_after_heater IS NULL
     OR temp_output_prd IS NULL
   )
 WHERE jenis_batch = 'PREPAST';
