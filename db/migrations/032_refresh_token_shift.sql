-- ============================================================
-- 032_refresh_token_shift.sql
-- Sesi berakhir otomatis saat pergantian shift (WIB, lihat auth/shift.js).
--
-- shift_login mencatat shift SAAT LOGIN pertama kali dan dibawa apa adanya
-- (bukan dihitung ulang) tiap kali refresh token dirotasi — "shift asal
-- sesi" ini yang dibandingkan dengan shift saat ini pada tiap request
-- (wajibLogin) maupun saat refresh(). Begitu berbeda, sesi ditolak dan
-- operator harus login ulang — mencegah operator shift berikutnya diam-diam
-- meneruskan sesi shift sebelumnya yang lupa logout.
--
-- DEFAULT 0 untuk baris yang sudah ada (dari sebelum migrasi ini): 0 bukan
-- shift yang sah (1/2/3), sehingga sesi lama otomatis ditolak pada
-- pemakaian berikutnya — sekali saja, wajar untuk fitur keamanan baru.
-- ============================================================

ALTER TABLE refresh_token
  ADD COLUMN shift_login TINYINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Shift (1/2/3) saat sesi ini pertama login; dibawa apa adanya lewat rotasi refresh'
    AFTER user_agent;
