-- ============================================================
-- 012  Login dengan username dan password, menggantikan PIN
-- ============================================================
--
-- Sebelum ini, login berarti MEMILIH nama dari dropdown lalu mengetik PIN
-- enam digit. Dua masalahnya:
--
--   1. Daftar seluruh operator harus dikirim ke perangkat SEBELUM ada yang
--      login. Siapa pun yang membuka halaman login tahu siapa saja yang
--      bekerja di sini. Endpoint pemasok daftar itu ikut dihapus.
--   2. PIN enam digit hanya punya sejuta kemungkinan, dan dalam praktiknya
--      dipilih dari tanggal lahir atau nomor urut. Yang menahan serangan
--      hanyalah penguncian setelah lima kali gagal.
--
-- username DIISI DARI `kode`, bukan dibuat baru: kode itu sudah unik, sudah
-- dikenal operator, dan sudah tercetak di catatan mutu. Membuat username baru
-- berarti tiap operator harus mengingat dua penciri untuk dirinya sendiri.
--
-- password_hash SENGAJA dibuat NULL-able dan dibiarkan NULL. Tidak ada
-- password yang dapat diturunkan dari PIN lama - hash argon2id tidak dapat
-- dibalik, dan seandainya bisa, memindahkan PIN enam digit menjadi password
-- berarti mewarisi kelemahannya. Operator dengan password NULL tidak dapat
-- login sampai Admin meresetnya (FR-26.2.5), dan itu keadaan yang benar:
-- kredensial baru harus diterbitkan, bukan diwariskan.
--
-- pin_hash DIHAPUS di migrasi ini juga. Menyimpan hash yang tidak lagi
-- dipakai berarti menyimpan rahasia yang tidak ada gunanya lagi dijaga.
-- ============================================================

ALTER TABLE operator
  ADD COLUMN username VARCHAR(60) NULL COMMENT 'Nama login. Diisi dari kode saat migrasi 012' AFTER kode,
  ADD COLUMN password_hash VARCHAR(255) NULL COMMENT 'argon2id. NULL = belum pernah diterbitkan, wajib direset Admin' AFTER username,
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'TRUE setelah reset password (FR-26.2.5)' AFTER password_hash;

UPDATE operator SET username = kode WHERE username IS NULL;

-- Baru dijadikan UNIQUE dan NOT NULL setelah terisi, supaya ALTER-nya tidak
-- gagal pada tabel yang sudah berisi.
ALTER TABLE operator
  MODIFY COLUMN username VARCHAR(60) NOT NULL COMMENT 'Nama login',
  ADD UNIQUE KEY uq_operator_username (username);

-- Yang sebelumnya wajib ganti PIN, sekarang wajib ganti password. Nilainya
-- dipindahkan supaya keadaan "kredensial sementara" tidak hilang.
UPDATE operator SET must_change_password = must_change_pin;

ALTER TABLE operator
  DROP COLUMN pin_hash,
  DROP COLUMN must_change_pin;
