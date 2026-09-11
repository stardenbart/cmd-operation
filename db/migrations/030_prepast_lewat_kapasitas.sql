-- ============================================================
-- 030_prepast_lewat_kapasitas.sql
-- Prepast tidak lagi diblokir keras oleh kapasitas silo tujuan
-- (keputusan operasional, September 2026, sama seperti Pindah Silo di
-- migrasi 027) — lihat pecahanSilo.js dan prepast.js.
-- Kolom ini mencatat SETIAP baris Prepast yang volumenya melampaui bahkan
-- batas keras (kapasitas + toleransi) silo tujuan, supaya masih dapat
-- ditelusuri/ditinjau SPV & QA lewat Data List maupun Export, bukan
-- hilang begitu saja menjadi angka biasa tanpa jejak.
-- ============================================================

ALTER TABLE prepast_record
  ADD COLUMN melampaui_kapasitas BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'TRUE bila volume Prepast melampaui batas keras (kapasitas+toleransi) silo tujuan saat disimpan'
    AFTER qty_remaining_ltr,
  ADD INDEX idx_pst_lewat_kapasitas (melampaui_kapasitas);
