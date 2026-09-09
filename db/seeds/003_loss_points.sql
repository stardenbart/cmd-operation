-- 27 titik losses FM - FR-35.3.
--
-- Idempoten: ON DUPLICATE KEY UPDATE menyegarkan atribut deskriptif, tetapi
-- TIDAK menyentuh `aktif` - status itu ditoggle Admin di layar setting dan
-- seed ulang tidak boleh mengembalikannya. LP-01 di-seed aktif=FALSE (D-21).
INSERT INTO loss_point (kode, nama, kategori, volume_liter, satuan, calculation_type, aktif) VALUES
  ('LP-01','TF ke Tanki Timbang','receiving',1.8,'per_penarikan','fixed_per_record',FALSE),
  ('LP-02','TF Tanki Timbang ke Silo 7','receiving',1.8,'per_penarikan','fixed_per_record',TRUE),
  ('LP-03','Dorongan Awal Silo 7 -> Silo 1','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-04','Dorongan Awal Silo 7 -> Silo 2','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-05','Dorongan Awal Silo 7 -> Silo 3','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-06','Dorongan Awal Silo 7 -> Silo 6','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-07','Dorongan Awal Silo 7 -> Silo 25A','prepast',45.0,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-08','Dorongan Awal Silo 7 -> Silo 25B','prepast',45.0,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-09','Dorongan Akhir Silo 1','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-10','Dorongan Akhir Silo 2','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-11','Dorongan Akhir Silo 3','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-12','Dorongan Akhir Silo 6','prepast',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-13','Dorongan Akhir Silo 25A','prepast',45.0,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-14','Dorongan Akhir Silo 25B','prepast',45.0,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-15','Switching Silo 1','switching',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-16','Switching Silo 2','switching',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-17','Switching Silo 3','switching',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-18','Switching Silo 6','switching',4.5,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-19','Switching Silo 25A','switching',45.0,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-20','Switching Silo 25B','switching',45.0,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-21','Sisa tertahan Silo 7 (Buffer)','buffer',25.4,'per_transfer','fixed_per_frequency_prepast',TRUE),
  ('LP-22','Penarikan dari Silo 25A','penarikan',28.0,'per_penarikan','fixed_per_record',TRUE),
  ('LP-23','Penarikan dari Silo 25B','penarikan',35.0,'per_penarikan','fixed_per_record',TRUE),
  ('LP-24','Penarikan dari Silo 1','penarikan',2.8,'per_penarikan','fixed_per_record',TRUE),
  ('LP-25','Penarikan dari Silo 2','penarikan',0.8,'per_penarikan','fixed_per_record',TRUE),
  ('LP-26','Penarikan dari Silo 3','penarikan',1.8,'per_penarikan','fixed_per_record',TRUE),
  ('LP-27','Penarikan dari Silo 6','penarikan',2.5,'per_penarikan','fixed_per_record',TRUE)
ON DUPLICATE KEY UPDATE
  nama = VALUES(nama), kategori = VALUES(kategori), volume_liter = VALUES(volume_liter),
  satuan = VALUES(satuan), calculation_type = VALUES(calculation_type);
