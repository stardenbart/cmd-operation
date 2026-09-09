-- ============================================================
-- 002_transaksi.sql — Tabel transaksi
-- PRD Bagian 8.2
--
-- Seluruh DATETIME disimpan UTC (A-4). Konversi zona di lapis aplikasi.
-- Kolom waktu boleh NULL = record draft / GANTUNG (BR-23).
-- ============================================================

-- --- RECEIVING ---
-- Penerimaan dari supplier. Selalu masuk buffer 000 (BR-02).
CREATE TABLE IF NOT EXISTS receiving (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode               VARCHAR(30) NOT NULL UNIQUE COMMENT 'RCV-20260825-001',
  supplier_id        BIGINT NOT NULL,
  silo_id            BIGINT NOT NULL COMMENT 'Selalu buffer (BR-02)',
  qty_kg             DECIMAL(12,2) NOT NULL,
  berat_jenis        DECIMAL(8,4)  NOT NULL,
  qty_ltr            DECIMAL(12,2) NOT NULL COMMENT 'FLOOR(kg/bj) — BR-03',
  qty_remaining_ltr  DECIMAL(12,2) NOT NULL,
  nilai_ts           DECIMAL(8,2)  NULL,
  -- Kolom "Waktu Penerimaan Mulai" ADA di form GMP tetapi secara prosedur
  -- tidak diisi (D-10). Hanya waktu selesai yang dicatat.
  finish_time        DATETIME NOT NULL,
  operator_id        BIGINT NOT NULL,
  status_approval    ENUM('Pending Approval','Approved','Rejected',
                          'Edit Requested','REVISED','VOIDED') NOT NULL
                          DEFAULT 'Pending Approval',
  status_fifo        ENUM('ACTIVE','CLOSED')  NOT NULL DEFAULT 'ACTIVE',
  buffer_status      ENUM('IN_BUFFER','IN_PREPAST','COMPLETED') NOT NULL DEFAULT 'IN_BUFFER',
  cmd_source         ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1',
  correction_ref_id  BIGINT NULL COMMENT 'Record lama yang digantikan (BR-12)',
  rejection_comment  TEXT NULL,
  approved_by_id     BIGINT NULL,
  approved_at        DATETIME NULL,
  remarks            TEXT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rcv_supplier   FOREIGN KEY (supplier_id)       REFERENCES supplier(id),
  CONSTRAINT fk_rcv_silo       FOREIGN KEY (silo_id)           REFERENCES silo(id),
  CONSTRAINT fk_rcv_operator   FOREIGN KEY (operator_id)       REFERENCES operator(id),
  CONSTRAINT fk_rcv_approver   FOREIGN KEY (approved_by_id)    REFERENCES operator(id),
  CONSTRAINT fk_rcv_correction FOREIGN KEY (correction_ref_id) REFERENCES receiving(id),
  CONSTRAINT ck_rcv_remaining  CHECK (qty_remaining_ltr >= 0 AND qty_remaining_ltr <= qty_ltr),
  CONSTRAINT ck_rcv_positif    CHECK (qty_kg > 0 AND berat_jenis > 0),
  -- Index utama antrean FIFO buffer (FR-5.1)
  INDEX idx_rcv_fifo (silo_id, status_fifo, status_approval, finish_time),
  INDEX idx_rcv_status (status_approval),
  INDEX idx_rcv_finish (finish_time)
) ENGINE=InnoDB;

-- --- PREPAST ---
-- Buffer -> silo penyimpanan. Satu penerimaan bisa pecah ke beberapa silo (FR-29):
-- N baris dengan variabel proses IDENTIK, hanya silo & volume yang berbeda (D-11).
CREATE TABLE IF NOT EXISTS prepast_record (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode               VARCHAR(30) NOT NULL UNIQUE COMMENT 'PST-20260825-001',
  receiving_id       BIGINT NULL COMMENT 'NULL bila anak hasil PINDAH SILO',
  parent_prepast_id  BIGINT NULL COMMENT 'Terisi bila anak hasil PINDAH SILO',
  supplier_id        BIGINT NOT NULL,
  silo_tujuan_id     BIGINT NOT NULL,
  vol_prepast_ltr    DECIMAL(12,2) NOT NULL,
  qty_remaining_ltr  DECIMAL(12,2) NOT NULL,
  prepast_start      DATETIME NULL COMMENT 'NULL = draft (BR-23)',
  prepast_finish     DATETIME NULL COMMENT 'NULL = draft. Kunci urutan FIFO (BR-04)',
  flowrate_pst       DECIMAL(8,2) NULL,
  -- OPRP: titik kendali keamanan pangan. Catatan kaki form: min 81 oC (FR-5.10)
  temp_after_heater  DECIMAL(6,2) NULL COMMENT 'OPRP — ambang minimum 81 oC',
  temp_output_prd    DECIMAL(6,2) NULL,
  nilai_ts           DECIMAL(8,2) NULL,
  operator_id        BIGINT NOT NULL,
  status_approval    ENUM('Pending Approval','Approved','Rejected',
                          'Edit Requested','REVISED','VOIDED') NOT NULL
                          DEFAULT 'Pending Approval',
  status_fifo        ENUM('ACTIVE','CLOSED') NOT NULL DEFAULT 'ACTIVE',
  cmd_source         ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1',
  is_gantung         BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'Turunan dari prepast_finish IS NULL',
  transfer_ref_id    BIGINT NULL COMMENT 'Transfer PINDAH SILO yang melahirkannya',
  correction_ref_id  BIGINT NULL,
  rejection_comment  TEXT NULL,
  remarks            TEXT NULL,
  approved_by_id     BIGINT NULL,
  approved_at        DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pst_receiving  FOREIGN KEY (receiving_id)      REFERENCES receiving(id),
  CONSTRAINT fk_pst_parent     FOREIGN KEY (parent_prepast_id) REFERENCES prepast_record(id),
  CONSTRAINT fk_pst_supplier   FOREIGN KEY (supplier_id)       REFERENCES supplier(id),
  CONSTRAINT fk_pst_silo       FOREIGN KEY (silo_tujuan_id)    REFERENCES silo(id),
  CONSTRAINT fk_pst_operator   FOREIGN KEY (operator_id)       REFERENCES operator(id),
  CONSTRAINT fk_pst_approver   FOREIGN KEY (approved_by_id)    REFERENCES operator(id),
  CONSTRAINT fk_pst_correction FOREIGN KEY (correction_ref_id) REFERENCES prepast_record(id),
  CONSTRAINT ck_pst_remaining  CHECK (qty_remaining_ltr >= 0 AND qty_remaining_ltr <= vol_prepast_ltr),
  CONSTRAINT ck_pst_volume     CHECK (vol_prepast_ltr > 0),
  -- Index utama alokasi FIFO transfer (BR-04). Urutan kolom mengikuti
  -- pola query: filter silo + status, lalu ORDER BY prepast_finish.
  INDEX idx_pst_fifo (silo_tujuan_id, status_fifo, status_approval, prepast_finish, id),
  INDEX idx_pst_receiving (receiving_id),
  INDEX idx_pst_status (status_approval),
  INDEX idx_pst_gantung (is_gantung)
) ENGINE=InnoDB;

-- --- TRANSFER ---
CREATE TABLE IF NOT EXISTS transfer (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode                VARCHAR(30) NOT NULL UNIQUE COMMENT 'TRF-20260825-001',
  transfer_type       ENUM('PEMAKAIAN PRODUKSI','PINDAH SILO') NOT NULL,
  silo_asal_id        BIGINT NOT NULL,
  tank_id             BIGINT NULL COMMENT 'Diisi bila PEMAKAIAN PRODUKSI',
  silo_tujuan_id      BIGINT NULL COMMENT 'Diisi bila PINDAH SILO',
  vol_ltr             DECIMAL(12,2) NOT NULL,
  vol_akt_silo_ltr    DECIMAL(12,2) NOT NULL COMMENT 'Snapshot volume silo saat submit',
  batch               VARCHAR(80) NULL COMMENT 'Bentuk kanonik BR-21',
  trf_time            DATETIME NULL COMMENT 'NULL = draft (BR-23)',
  standing_time_menit INT NULL COMMENT 'BR-09',
  operator_id         BIGINT NOT NULL,
  status_approval     ENUM('Pending Approval','Approved','Rejected',
                           'Edit Requested','REVISED','VOIDED') NOT NULL
                           DEFAULT 'Pending Approval',
  cmd_destination     ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1',
  is_gantung          BOOLEAN NOT NULL DEFAULT FALSE,
  correction_ref_id   BIGINT NULL,
  rejection_comment   TEXT NULL,
  approved_by_id      BIGINT NULL,
  approved_at         DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_trf_asal       FOREIGN KEY (silo_asal_id)      REFERENCES silo(id),
  CONSTRAINT fk_trf_tujuan     FOREIGN KEY (silo_tujuan_id)    REFERENCES silo(id),
  CONSTRAINT fk_trf_tank       FOREIGN KEY (tank_id)           REFERENCES tank_master(id),
  CONSTRAINT fk_trf_operator   FOREIGN KEY (operator_id)       REFERENCES operator(id),
  CONSTRAINT fk_trf_approver   FOREIGN KEY (approved_by_id)    REFERENCES operator(id),
  CONSTRAINT fk_trf_correction FOREIGN KEY (correction_ref_id) REFERENCES transfer(id),
  -- BR-17: silo tujuan tidak boleh sama dengan silo asal
  CONSTRAINT ck_trf_tujuan     CHECK (silo_tujuan_id IS NULL OR silo_asal_id <> silo_tujuan_id),
  CONSTRAINT ck_trf_volume     CHECK (vol_ltr > 0),
  -- Tepat satu tujuan terisi, sesuai jenis transfernya
  CONSTRAINT ck_trf_jenis      CHECK (
    (transfer_type = 'PEMAKAIAN PRODUKSI' AND tank_id IS NOT NULL AND silo_tujuan_id IS NULL)
    OR
    (transfer_type = 'PINDAH SILO' AND silo_tujuan_id IS NOT NULL AND tank_id IS NULL)
  ),
  INDEX idx_trf_silo (silo_asal_id, trf_time),
  INDEX idx_trf_status (status_approval),
  INDEX idx_trf_time (trf_time)
) ENGINE=InnoDB;

-- --- ALOKASI FIFO ---
-- Menggantikan JSON string `supplier_fifo` (B-13, M-6).
-- Inilah yang membuat rollback dan pengecekan dependensi menjadi query biasa,
-- bukan substring match pada teks JSON.
CREATE TABLE IF NOT EXISTS transfer_allocation (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  transfer_id    BIGINT NOT NULL,
  prepast_id     BIGINT NOT NULL,
  supplier_id    BIGINT NOT NULL,
  qty_available  DECIMAL(12,2) NOT NULL COMMENT 'Sisa prepast sebelum alokasi',
  qty_allocated  DECIMAL(12,2) NOT NULL,
  qty_after      DECIMAL(12,2) NOT NULL COMMENT 'available - allocated',
  urutan_fifo    SMALLINT NOT NULL COMMENT 'Urutan alokasi, 1 = paling lama',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_alloc_transfer FOREIGN KEY (transfer_id) REFERENCES transfer(id) ON DELETE CASCADE,
  CONSTRAINT fk_alloc_prepast  FOREIGN KEY (prepast_id)  REFERENCES prepast_record(id),
  CONSTRAINT fk_alloc_supplier FOREIGN KEY (supplier_id) REFERENCES supplier(id),
  CONSTRAINT ck_alloc_positive CHECK (qty_allocated > 0),
  CONSTRAINT ck_alloc_after    CHECK (qty_after >= 0),
  UNIQUE KEY uq_alloc (transfer_id, prepast_id),
  -- Index untuk guard dependensi (BR-15): apakah prepast ini dipakai transfer?
  INDEX idx_alloc_prepast (prepast_id)
) ENGINE=InnoDB;

-- --- MONITORING ---
CREATE TABLE IF NOT EXISTS monitoring (
  id                      BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode                    VARCHAR(30) NOT NULL UNIQUE COMMENT 'MTR-20260825-001',
  silo_id                 BIGINT NOT NULL,
  ph_check                DECIMAL(5,2) NOT NULL,
  temp_check              DECIMAL(6,2) NOT NULL,
  time_check              DATETIME NOT NULL,
  supplier_list           TEXT NULL COMMENT 'Snapshot supplier aktif saat pengecekan',
  val_aktual_snapshot_ltr DECIMAL(12,2) NULL,
  operator_id             BIGINT NOT NULL,
  status_approval         ENUM('Pending Approval','Approved','Rejected',
                               'Edit Requested','REVISED','VOIDED') NOT NULL
                               DEFAULT 'Pending Approval',
  correction_ref_id       BIGINT NULL,
  rejection_comment       TEXT NULL,
  approved_by_id          BIGINT NULL,
  approved_at             DATETIME NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_mon_silo       FOREIGN KEY (silo_id)           REFERENCES silo(id),
  CONSTRAINT fk_mon_operator   FOREIGN KEY (operator_id)       REFERENCES operator(id),
  CONSTRAINT fk_mon_approver   FOREIGN KEY (approved_by_id)    REFERENCES operator(id),
  CONSTRAINT fk_mon_correction FOREIGN KEY (correction_ref_id) REFERENCES monitoring(id),
  INDEX idx_mon_silo_time (silo_id, time_check DESC),
  INDEX idx_mon_status (status_approval)
) ENGINE=InnoDB;

-- --- STOCK OPNAME ---
-- UNIQUE (periode, silo) memperbaiki upsert yang rusak di Power Apps (B-2)
CREATE TABLE IF NOT EXISTS stock_opname (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  periode          CHAR(7) NOT NULL COMMENT 'YYYY-MM',
  silo_id          BIGINT NOT NULL,
  jumlah_awal_ltr  DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_finalized     BOOLEAN NOT NULL DEFAULT FALSE COMMENT 'BR-20 — read-only setelah final',
  operator_id      BIGINT NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_so_silo     FOREIGN KEY (silo_id)     REFERENCES silo(id),
  CONSTRAINT fk_so_operator FOREIGN KEY (operator_id) REFERENCES operator(id),
  UNIQUE KEY uq_so (periode, silo_id)
) ENGINE=InnoDB;

-- --- PERMINTAAN KOREKSI ---
-- WF-3: perubahan yang diusulkan menyertai permintaannya, sehingga record asli
-- TETAP Approved sampai penggantinya siap (FR-15).
CREATE TABLE IF NOT EXISTS correction_request (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  entity        ENUM('receiving','prepast','transfer','monitoring') NOT NULL,
  entity_id     BIGINT NOT NULL,
  requested_by  BIGINT NOT NULL,
  reason        TEXT NOT NULL,
  payload_json  JSON NOT NULL COMMENT 'Field yang diubah beserta nilai barunya',
  status        ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by   BIGINT NULL,
  reviewed_at   DATETIME NULL,
  review_note   TEXT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_creq_requester FOREIGN KEY (requested_by) REFERENCES operator(id),
  CONSTRAINT fk_creq_reviewer  FOREIGN KEY (reviewed_by)  REFERENCES operator(id),
  INDEX idx_creq (entity, entity_id, status)
) ENGINE=InnoDB;

-- --- BATCH TRACEABILITY ---
-- Di luar cakupan Fase 1 (D-1). Tabel disiapkan agar data historis
-- dapat dimigrasikan read-only tanpa kehilangan apa pun.
CREATE TABLE IF NOT EXISTS batch_traceability (
  id                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode                 VARCHAR(40) NULL,
  batch_produk_jadi    VARCHAR(80) NULL,
  batch_produksi       VARCHAR(80) NULL,
  id_produk            VARCHAR(80) NULL,
  id_receiving_list    TEXT NULL,
  supplier_composition TEXT NULL,
  silo_kode            VARCHAR(20) NULL,
  tank_trf             VARCHAR(40) NULL,
  trf_id               VARCHAR(40) NULL,
  cmd_source           VARCHAR(10) NULL,
  status_trace         VARCHAR(40) NULL,
  tanggal_produksi     DATE NULL,
  legacy_payload       JSON NULL COMMENT 'Salinan mentah dari SharePoint',
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trace_batch (batch_produk_jadi),
  INDEX idx_trace_tanggal (tanggal_produksi)
) ENGINE=InnoDB COMMENT='Read-only Fase 1. Modul aktif menyusul (L-2)';
