-- PRD v7: jejak konfirmasi/override kontinuitas pada saat input.
-- Pengelompokan sesi tetap dihitung dari start/finish + silo agar retroaktif.
ALTER TABLE prepast_record
  ADD COLUMN continuity_previous_id BIGINT NULL AFTER prepast_finish,
  ADD COLUMN continuity_override BOOLEAN NOT NULL DEFAULT FALSE AFTER continuity_previous_id,
  ADD COLUMN continuity_override_reason VARCHAR(500) NULL AFTER continuity_override,
  ADD CONSTRAINT fk_pst_continuity_previous
    FOREIGN KEY (continuity_previous_id) REFERENCES prepast_record(id),
  ADD INDEX idx_pst_continuity (silo_tujuan_id, prepast_start, prepast_finish, id);
