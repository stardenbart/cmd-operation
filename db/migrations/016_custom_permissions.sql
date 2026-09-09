-- Peran baru Viewer (FR-34.1) - baca-saja. Ditambahkan ke ENUM peran.
ALTER TABLE operator
  MODIFY COLUMN role ENUM('Operator','SPV','Admin','Viewer') NOT NULL;

-- Hak akses custom per user (FR-34.2).
--
-- Array aksi TAMBAHAN di luar matriks peran (BR-27, aditif saja). NULL berarti
-- tidak ada tambahan - peran murni. Disimpan sebagai JSON agar satu kolom cukup
-- menampung jumlah aksi yang berubah-ubah tanpa tabel penghubung.
ALTER TABLE operator
  ADD COLUMN custom_permissions JSON DEFAULT NULL
  COMMENT 'Array aksi tambahan di luar matriks peran, mis. ["export:jalankan","stock_opname:kelola"]';

-- Jejak audit perubahan hak akses custom (FR-34.3.3) butuh nilai action baru.
ALTER TABLE audit_log
  MODIFY COLUMN action ENUM(
    'CREATE','UPDATE','APPROVE','REJECT','VOID','CORRECT',
    'COMPLETE_DRAFT','REQUEST_EDIT','GRANT_EDIT','DENY_EDIT',
    'FINALIZE_SO','LOGIN_OK','LOGIN_FAILED','PIN_RESET',
    'MIGRATE','HAK_AKSES'
  ) NOT NULL;
