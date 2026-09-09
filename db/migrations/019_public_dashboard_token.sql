-- Tautan publik dashboard (read-only) - berbagi tanpa login.
--
-- Dashboard operasional dapat dibagikan sebagai tautan bertoken: penerima
-- melihat kartu stok, visual silo, dan papan batch aktif TANPA masuk. Token
-- rahasia (tidak dapat ditebak) dan dapat DICABUT bila bocor - pencabutan
-- cukup menonaktifkan baris, jejaknya tetap ada. Hanya satu token aktif pada
-- satu waktu; memutar token menonaktifkan yang lama dan menerbitkan yang baru.

CREATE TABLE public_dashboard_token (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  token       VARCHAR(64) NOT NULL UNIQUE COMMENT 'Token acak URL-safe',
  aktif       BOOLEAN NOT NULL DEFAULT TRUE,
  dibuat_oleh BIGINT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (dibuat_oleh) REFERENCES operator(id),
  INDEX idx_pdt_aktif (aktif)
) ENGINE=InnoDB COMMENT='Token tautan publik dashboard, dapat dicabut';

-- Pencabutan = UPDATE aktif=FALSE (append-only secara semangat; tidak ada DELETE).
GRANT SELECT, INSERT, UPDATE ON `fm_receiving`.`public_dashboard_token` TO 'fm_app'@'%';
