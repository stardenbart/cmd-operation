-- ============================================================
-- 013  Indeks waktu tunggal untuk pengurutan halaman data
-- ============================================================
--
-- Halaman Data memuat tiap modul terurut waktunya, terbaru dahulu - itu
-- tampilan default yang dibuka paling sering. Receiving dan transfer sudah
-- lancar: `idx_rcv_finish (finish_time)` dan `idx_trf_time (trf_time)`
-- membuat basis data cukup MENELUSURI indeks dari ujung (backward index
-- scan), tanpa mengurutkan apa pun.
--
-- Tiga modul lain tidak punya indeks yang sepadan:
--
--   monitoring        diurut time_check, tetapi satu-satunya indeks yang
--                     memuatnya adalah (silo_id, time_check) - berguna hanya
--                     bila silo-nya juga difilter. Untuk urutan murni,
--                     basis data terpaksa filesort.
--   prepast_record    diurut prepast_finish; idx_pst_fifo memuatnya di posisi
--                     KEEMPAT, terlalu dalam untuk dipakai mengurutkan.
--   pengembalian      modul yang sama, diurut prepast_start - tidak ada
--                     indeks yang memuatnya sama sekali.
--
-- Filesort pada beberapa ratus baris hari ini hanya sepersekian milidetik,
-- jadi ini BUKAN perbaikan yang mendesak. Yang membuatnya pantas ditambah
-- sekarang adalah pertumbuhannya: monitoring dan prepast bertambah tiap hari
-- selamanya, dan filesort tumbuh bersama jumlah barisnya sedangkan penelusuran
-- indeks tidak. Menambahkannya saat tabel masih kecil hampir tanpa biaya;
-- menambahkannya saat sudah jutaan baris berarti mengunci tabel produksi.
--
-- Kolom id TIDAK perlu disebut. Indeks sekunder InnoDB selalu diakhiri kunci
-- primer, sehingga (time_check) sudah setara (time_check, id) - cukup untuk
-- memenuhi "ORDER BY time_check DESC, id DESC" lewat backward scan.
-- ============================================================

CREATE INDEX idx_mon_time ON monitoring (time_check);
CREATE INDEX idx_pst_finish ON prepast_record (prepast_finish);
CREATE INDEX idx_pst_start ON prepast_record (prepast_start);
