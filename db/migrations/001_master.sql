-- ============================================================
-- 001_master.sql — Tabel master
-- PRD Bagian 8.2
-- ============================================================

-- --- Operator / User ---
CREATE TABLE IF NOT EXISTS operator (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode          VARCHAR(20)  NOT NULL UNIQUE COMMENT 'NIK / kode operator, eks SharePoint Title',
  nama_lengkap  VARCHAR(120) NOT NULL,
  pin_hash      VARCHAR(255) NOT NULL COMMENT 'argon2id — PIN plaintext tidak pernah disimpan (FR-1.1)',
  must_change_pin BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'TRUE setelah reset PIN (FR-26.2.5)',
  role          ENUM('Operator','SPV','Admin') NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts SMALLINT NOT NULL DEFAULT 0,
  locked_until  DATETIME NULL COMMENT 'Rate limit login (FR-1.5)',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_operator_active (is_active, nama_lengkap)
) ENGINE=InnoDB COMMENT='User aplikasi. Peran: matriks 2.10.1';

-- --- Supplier ---
CREATE TABLE IF NOT EXISTS supplier (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode          VARCHAR(20)  NOT NULL UNIQUE,
  supplier_name VARCHAR(150) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_supplier_active (is_active, supplier_name)
) ENGINE=InnoDB;

-- --- Silo ---
CREATE TABLE IF NOT EXISTS silo (
  id                      BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode                    VARCHAR(20)  NOT NULL UNIQUE COMMENT 'eks Title: 000, 1, 2, 25A, ...',
  silo_name               VARCHAR(80)  NOT NULL COMMENT 'Nama tampilan: SILO25A',
  qr_code_value           VARCHAR(80)  NOT NULL UNIQUE,
  kapasitas_maks_ltr      DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_buffer               BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'TRUE hanya untuk kode 000 (BR-02)',
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  is_available            BOOLEAN NOT NULL DEFAULT TRUE,
  -- B-19: ambang sebagai KOLOM, bukan perbandingan nama silo.
  -- Di Power Apps ambang 2 jam tidak pernah aktif karena membandingkan
  -- silo_name ke "SILO 25A" (berspasi) padahal nilainya "SILO25A".
  monitoring_interval_jam TINYINT NOT NULL DEFAULT 4 COMMENT 'BR-10 — 2 untuk SILO25A/25B',
  standing_time_anchor    DATETIME NULL COMMENT 'BR-09 — UTC',
  urutan                  SMALLINT NOT NULL DEFAULT 0 COMMENT 'Urutan tampil di form GMP & dashboard',
  notes                   TEXT NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_silo_active (is_active, urutan)
) ENGINE=InnoDB;

-- --- Tank produksi ---
-- Menggantikan colTankMaster yang di-hardcode di App.OnStart
CREATE TABLE IF NOT EXISTS tank_master (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  tank_name       VARCHAR(40) NOT NULL UNIQUE,
  qr_value        VARCHAR(40) NOT NULL UNIQUE,
  tank_trf_value  VARCHAR(40) NOT NULL,
  cmd_destination ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1' COMMENT 'BR-18',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  urutan          SMALLINT NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- --- Prefiks batch ---
-- Menggantikan field batch bebas-teks (B-20). Dikelola Admin (FR-26.1.5).
CREATE TABLE IF NOT EXISTS batch_prefix (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode        VARCHAR(10)  NOT NULL UNIQUE COMMENT 'HRC, FC, INK, FULLFM, SR',
  label       VARCHAR(80)  NOT NULL,
  is_standar  BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'TRUE untuk HRC & FC',
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  urutan      SMALLINT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- --- Template form GMP ---
-- Nomor dokumen & revisi sebagai data terkelola, bukan teks di template (C.7)
CREATE TABLE IF NOT EXISTS form_template (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode_form      VARCHAR(40)  NOT NULL COMMENT 'CMD1/FRM/PRD/01',
  revisi         VARCHAR(10)  NOT NULL COMMENT '02',
  berlaku_mulai  DATE         NOT NULL,
  berlaku_sampai DATE         NULL COMMENT 'NULL = masih berlaku',
  judul          VARCHAR(200) NOT NULL,
  keterangan     TEXT NULL COMMENT 'Catatan kaki, mis. *) Setting Temp. : 90oC, Min Temp. : 81oC',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_form (kode_form, revisi),
  INDEX idx_form_berlaku (berlaku_mulai, berlaku_sampai)
) ENGINE=InnoDB;

-- --- Sekuens ID ---
-- Menggantikan RandBetween(100,999) yang hanya punya 900 nilai per hari (M-4)
CREATE TABLE IF NOT EXISTS id_sequence (
  prefix      CHAR(3) NOT NULL COMMENT 'RCV, PST, TRF, MTR',
  tanggal     DATE    NOT NULL,
  last_number INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, tanggal)
) ENGINE=InnoDB;
