-- ============================================================
-- 005_grants.sql — Hak akses append-only untuk audit_log
-- PRD 15.3.1 syarat A-1
--
-- Dijalankan sebagai root. User aplikasi hanya boleh INSERT & SELECT
-- pada audit_log — tidak ada UPDATE/DELETE, termasuk untuk peran Admin
-- di dalam aplikasi. Penghapusan hanya mungkin lewat DBA dengan
-- prosedur terpisah.
--
-- Catatan: MySQL tidak mendukung REVOKE pada tabel yang haknya berasal
-- dari grant tingkat database. Karena itu hak diberikan per tabel,
-- bukan dengan GRANT ALL pada seluruh database.
-- ============================================================

-- Cabut hak menyeluruh yang diberikan saat container diinisialisasi.
--
-- Perhatikan garis bawah yang di-escape: `fm\_receiving`.
-- Pada pola nama database, MySQL memperlakukan `_` sebagai wildcard satu
-- karakter, sehingga entrypoint Docker menyimpan grant dalam bentuk
-- ter-escape. REVOKE dengan `fm_receiving` (tanpa escape) tidak cocok
-- dengan pola tersimpan dan gagal dengan "There is no such grant defined".
REVOKE ALL PRIVILEGES ON `fm\_receiving`.* FROM 'fm_app'@'%';

-- Hak penuh pada tabel transaksi & master
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`operator`            TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`supplier`            TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`silo`                TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`tank_master`         TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`batch_prefix`        TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`form_template`       TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`id_sequence`         TO 'fm_app'@'%';

GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`receiving`           TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`prepast_record`      TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`transfer`            TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`transfer_allocation` TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`monitoring`          TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`stock_opname`        TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`correction_request`  TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`refresh_token`       TO 'fm_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`idempotency_key`     TO 'fm_app'@'%';
GRANT SELECT, INSERT                 ON `fm_receiving`.`batch_traceability`  TO 'fm_app'@'%';

-- ┌─────────────────────────────────────────────────────────┐
-- │  APPEND-ONLY: audit_log hanya menerima INSERT & SELECT   │
-- │  Tidak ada UPDATE. Tidak ada DELETE. Ini yang membuat    │
-- │  jejak audit memenuhi 21 CFR Part 11 sec.11.10(e).       │
-- └─────────────────────────────────────────────────────────┘
GRANT SELECT, INSERT ON `fm_receiving`.`audit_log` TO 'fm_app'@'%';

-- VIEW hanya dibaca
GRANT SELECT ON `fm_receiving`.`v_silo_volume`             TO 'fm_app'@'%';
GRANT SELECT ON `fm_receiving`.`v_silo_monitoring_status`  TO 'fm_app'@'%';
GRANT SELECT ON `fm_receiving`.`v_buffer_queue`            TO 'fm_app'@'%';
GRANT SELECT ON `fm_receiving`.`v_fifo_queue`              TO 'fm_app'@'%';
GRANT SELECT ON `fm_receiving`.`v_approval_queue`          TO 'fm_app'@'%';

FLUSH PRIVILEGES;
