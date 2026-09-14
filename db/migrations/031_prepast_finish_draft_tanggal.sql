-- ============================================================
-- 031_prepast_finish_draft_tanggal.sql
-- Ingat tanggal Waktu Selesai yang sempat diketik operator sebelum jamnya
-- diisi (BR-16). prepast_finish sendiri adalah satu kolom DATETIME — tidak
-- bisa menyimpan "tanggal saja" — sehingga tanpa kolom terpisah ini, tanggal
-- yang sudah diketik hilang begitu record disimpan dengan jam masih kosong.
--
-- Murni pengingat TAMPILAN. Tidak pernah dibaca oleh validasi, kapasitas,
-- FIFO, atau perhitungan apa pun — satu-satunya pemakainya adalah mengisi
-- ulang kotak Tanggal saat dialog "Lengkapi Prepast" dibuka kembali.
-- Dikosongkan lagi begitu prepast_finish sungguhan (tanggal+jam lengkap)
-- tersimpan, supaya tidak pernah menyimpang dari sumber kebenarannya.
-- ============================================================

ALTER TABLE prepast_record
  ADD COLUMN prepast_finish_draft_tanggal DATE NULL
    COMMENT 'BR-16 - tanggal Waktu Selesai yang sempat diketik sebelum jamnya diisi; pengingat tampilan saja, dikosongkan lagi begitu prepast_finish tersimpan'
    AFTER prepast_finish;
