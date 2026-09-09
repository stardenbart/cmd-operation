-- Losses Management - FR-35.
--
-- Master 27 titik losses pada proses FM. Tiap titik punya volume tetap yang
-- tercatat saat proses berjalan, dan cara menghitung frekuensinya
-- (calculation_type). Perubahan konfigurasi di-snapshot ke loss_point_version
-- agar laporan historis tetap merujuk konfigurasi yang berlaku saat itu (BR-28).

CREATE TABLE loss_point (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  kode             VARCHAR(10) NOT NULL UNIQUE COMMENT 'e.g. LP-01',
  nama             VARCHAR(120) NOT NULL COMMENT 'Nama titik loss',
  kategori         ENUM('receiving','prepast','switching','buffer','penarikan') NOT NULL,
  volume_liter     DECIMAL(8,2) NOT NULL COMMENT 'Volume loss per satuan',
  satuan           ENUM('per_penarikan','per_transfer') NOT NULL COMMENT 'Kapan loss terjadi',
  calculation_type ENUM('fixed_per_record','fixed_per_frequency_prepast','manual_input')
                   NOT NULL DEFAULT 'fixed_per_record' COMMENT 'Cara menghitung frekuensi',
  aktif            BOOLEAN NOT NULL DEFAULT TRUE,
  catatan          TEXT DEFAULT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_lp_kategori (kategori),
  INDEX idx_lp_aktif (aktif)
) ENGINE=InnoDB COMMENT='Master 27 titik losses FM (FR-35.1)';

CREATE TABLE loss_point_version (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  snapshot      JSON NOT NULL COMMENT 'Salinan seluruh loss_point aktif saat snapshot diambil',
  berlaku_sejak TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dibuat_oleh   BIGINT NOT NULL,
  catatan       VARCHAR(255) DEFAULT NULL,

  FOREIGN KEY (dibuat_oleh) REFERENCES operator(id),
  INDEX idx_lpv_berlaku (berlaku_sejak)
) ENGINE=InnoDB COMMENT='Versi historis konfigurasi loss point (FR-35.2, BR-28)';

-- Hak user aplikasi atas tabel baru (lihat 005_grants.sql). loss_point disunting
-- Admin lewat aplikasi; loss_point_version append-only (SELECT + INSERT saja).
GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`loss_point`         TO 'fm_app'@'%';
GRANT SELECT, INSERT                 ON `fm_receiving`.`loss_point_version` TO 'fm_app'@'%';
