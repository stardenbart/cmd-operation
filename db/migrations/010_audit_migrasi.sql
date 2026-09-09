-- ============================================================
-- 010  Jejak audit untuk migrasi data
-- ============================================================
--
-- Setelah cutover, basis data ini memuat ribuan catatan mutu yang TIDAK
-- dibuat oleh siapa pun lewat aplikasi. Tanpa satu entri pun di audit_log,
-- tidak ada bukti DI DALAM basis data tentang dari mana catatan itu berasal,
-- kapan dipindahkan, berapa yang ditolak, dan apa hasil verifikasinya.
--
-- Laporan pengecualian dan laporan verifikasi memang disimpan sebagai berkas,
-- tetapi berkas dapat hilang, tertimpa, atau tertinggal saat basis datanya
-- dipulihkan ke tempat lain. 21 CFR Part 11 §11.10(e) menuntut jejaknya
-- melekat pada datanya sendiri.
--
-- Nilai enum ditambahkan di UJUNG. Di MySQL 8 penambahan di ujung hanya
-- mengubah metadata, sehingga tabel yang sudah berisi tidak perlu ditulis
-- ulang. Menyisipkannya di tengah akan menggeser nilai ordinal baris yang
-- sudah ada.
-- ============================================================

ALTER TABLE audit_log
  MODIFY COLUMN action ENUM(
    'CREATE','UPDATE','APPROVE','REJECT','VOID','CORRECT',
    'COMPLETE_DRAFT','REQUEST_EDIT','GRANT_EDIT','DENY_EDIT',
    'FINALIZE_SO','LOGIN_OK','LOGIN_FAILED','PIN_RESET',
    'MIGRATE'
  ) NOT NULL;
