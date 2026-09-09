-- ============================================================
-- 003_audit.sql — Jejak audit
-- PRD 15.3.1 (syarat A-1..A-8), NFR-6
--
-- Memenuhi 21 CFR Part 11 sec.11.10(e): "record changes shall not obscure
-- previously recorded information", dan prinsip ALCOA+.
--
-- TIDAK PERNAH DIHAPUS (D-9). Tidak ada job pembersihan, tidak ada
-- pengarsipan berjadwal. Volume hanya ~65 MB/tahun.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  entity      VARCHAR(40) NOT NULL,
  entity_id   BIGINT NOT NULL,
  action      ENUM('CREATE','UPDATE','APPROVE','REJECT','VOID','CORRECT',
                   'COMPLETE_DRAFT','REQUEST_EDIT','GRANT_EDIT','DENY_EDIT',
                   'FINALIZE_SO','LOGIN_OK','LOGIN_FAILED','PIN_RESET') NOT NULL,
  -- A-3 Attributable: foreign key, bukan string nama bebas.
  -- Power Apps menyimpan nama_op sebagai teks — ambigu bila ada dua operator senama.
  actor_id    BIGINT NOT NULL,
  -- A-2: snapshot baris UTUH, bukan delta. Rekonstruksi tidak boleh
  -- bergantung pada rantai entri sebelumnya.
  before_json JSON NULL,
  after_json  JSON NULL,
  -- A-5: wajib untuk CORRECT & VOID. Ditegakkan di lapis service.
  reason      TEXT NULL,
  ip_address  VARCHAR(45) NULL,
  -- A-4 Contemporaneous: waktu SERVER (UTC), tidak pernah dikirim klien.
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES operator(id),
  INDEX idx_audit_entity (entity, entity_id, created_at),
  INDEX idx_audit_actor (actor_id, created_at),
  INDEX idx_audit_action (action, created_at)
) ENGINE=InnoDB COMMENT='Append-only. Lihat 004_grants.sql untuk pencabutan UPDATE/DELETE';

-- --- Refresh token ---
CREATE TABLE IF NOT EXISTS refresh_token (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  operator_id BIGINT NOT NULL,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  user_agent  VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rt_operator FOREIGN KEY (operator_id) REFERENCES operator(id) ON DELETE CASCADE,
  INDEX idx_rt_operator (operator_id, revoked_at),
  INDEX idx_rt_expiry (expires_at)
) ENGINE=InnoDB;

-- --- Kunci idempotensi ---
-- NFR-10: koneksi terputus tidak boleh menghasilkan submit ganda
CREATE TABLE IF NOT EXISTS idempotency_key (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  key_value    VARCHAR(64) NOT NULL UNIQUE,
  operator_id  BIGINT NOT NULL,
  endpoint     VARCHAR(120) NOT NULL,
  response_json JSON NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_idem_operator FOREIGN KEY (operator_id) REFERENCES operator(id),
  INDEX idx_idem_created (created_at)
) ENGINE=InnoDB;
