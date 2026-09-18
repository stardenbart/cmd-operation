-- ============================================================
-- 034_operator_signature.sql
-- Tanda tangan digital operator - kolom Paraf Halaman 1 form GMP.
--
-- Menggantikan QR pada kolom Paraf: gambar tanda tangan disimpan SEKALI
-- per operator (digambar sendiri di halaman profil mereka), dipakai ulang
-- untuk setiap record yang mereka kerjakan - bukan digambar ulang tiap
-- transaksi. Disimpan langsung sebagai PNG di database (bukan berkas
-- eksternal), konsisten dengan sistem ini yang on-prem tanpa dependensi
-- storage luar. MEDIUMBLOB cukup luas (16MB) untuk gambar tanda tangan
-- yang sesungguhnya cuma beberapa KB.
-- ============================================================

ALTER TABLE operator
  ADD COLUMN signature_image MEDIUMBLOB NULL
    COMMENT 'PNG tanda tangan digital, digambar sendiri oleh operator - dipakai di kolom Paraf form GMP',
  ADD COLUMN signature_updated_at DATETIME NULL
    COMMENT 'Kapan tanda tangan ini terakhir disimpan/diganti';
