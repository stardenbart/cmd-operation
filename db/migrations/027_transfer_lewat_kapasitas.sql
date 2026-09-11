-- ============================================================
-- 027_transfer_lewat_kapasitas.sql
-- Pindah Silo tidak lagi diblokir keras oleh kapasitas silo tujuan
-- (keputusan operasional, September 2026) — lihat transfer.js.
-- Kolom ini mencatat SETIAP transfer yang volumenya melampaui bahkan
-- batas keras (kapasitas + toleransi) tujuan, supaya masih dapat
-- ditelusuri/ditinjau SPV & QA lewat Data List maupun Export, bukan
-- hilang begitu saja menjadi angka biasa tanpa jejak.
-- ============================================================

ALTER TABLE transfer
  ADD COLUMN melampaui_kapasitas BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'TRUE bila volume Pindah Silo melampaui batas keras (kapasitas+toleransi) silo tujuan saat disimpan'
    AFTER vol_akt_silo_ltr,
  ADD INDEX idx_trf_lewat_kapasitas (melampaui_kapasitas);
