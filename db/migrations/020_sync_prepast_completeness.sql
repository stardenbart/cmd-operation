-- ============================================================
-- 020_sync_prepast_completeness.sql
-- Sinkronisasi status GANTUNG Prepast dengan empat data proses yang boleh
-- dilengkapi belakangan. Nilai yang sudah ada tidak diubah.
-- ============================================================

-- Waktu mulai tetap wajib untuk data baru. Pemeriksaan prepast_start di sini
-- hanya menjaga record legacy yang dahulu boleh disimpan sebagai draft penuh.
UPDATE prepast_record
   SET is_gantung = (
     prepast_start IS NULL
     OR prepast_finish IS NULL
     OR flowrate_pst IS NULL
     OR temp_after_heater IS NULL
     OR temp_output_prd IS NULL
   )
 WHERE jenis_batch = 'PREPAST';

-- Record tanpa waktu selesai belum punya kunci FIFO dan tidak boleh ditransfer.
-- Record yang finish-nya sudah ada tetap mewakili susu fisik di silo walaupun
-- pengukuran lain masih ditagih lewat Dashboard.
CREATE OR REPLACE VIEW v_fifo_queue AS
SELECT
  p.id, p.kode, p.jenis_batch, p.silo_tujuan_id, p.supplier_id,
  sup.supplier_name, p.keterangan_asal,
  p.vol_prepast_ltr, p.qty_remaining_ltr, p.prepast_finish, p.nilai_ts
FROM prepast_record p
LEFT JOIN supplier sup ON sup.id = p.supplier_id
WHERE p.status_fifo = 'ACTIVE'
  AND p.qty_remaining_ltr > 0
  AND p.prepast_finish IS NOT NULL
  AND p.status_approval NOT IN ('Rejected','REVISED','VOIDED')
ORDER BY p.prepast_finish ASC, p.id ASC;

-- Seluruh field proses harus lengkap sebelum Prepast masuk antrean approval.
CREATE OR REPLACE VIEW v_approval_queue AS
SELECT 'receiving' AS modul, r.id, r.kode, r.created_at, r.operator_id,
       CONCAT(sup.supplier_name, ' - ', FORMAT(r.qty_ltr, 0), ' L') AS ringkasan
FROM receiving r JOIN supplier sup ON sup.id = r.supplier_id
WHERE r.status_approval = 'Pending Approval'
UNION ALL
SELECT 'prepast', p.id, p.kode, p.created_at, p.operator_id,
       CONCAT(sup.supplier_name, ' ke ', s.silo_name, ' - ', FORMAT(p.vol_prepast_ltr, 0), ' L')
FROM prepast_record p JOIN supplier sup ON sup.id = p.supplier_id
                      JOIN silo s ON s.id = p.silo_tujuan_id
WHERE p.status_approval = 'Pending Approval'
  AND p.jenis_batch = 'PREPAST'
  AND p.is_gantung = FALSE
UNION ALL
SELECT 'pengembalian', p.id, p.kode, p.created_at, p.operator_id,
       CONCAT('Kembali ke ', s.silo_name, ' - ', FORMAT(p.vol_prepast_ltr, 0), ' L',
              CASE WHEN p.supplier_id IS NULL THEN ' (asal tidak diketahui)' ELSE '' END)
FROM prepast_record p JOIN silo s ON s.id = p.silo_tujuan_id
WHERE p.status_approval = 'Pending Approval'
  AND p.jenis_batch = 'PENGEMBALIAN'
UNION ALL
SELECT 'transfer', t.id, t.kode, t.created_at, t.operator_id,
       CONCAT(s.silo_name, ' - ', FORMAT(t.vol_ltr, 0), ' L')
FROM transfer t JOIN silo s ON s.id = t.silo_asal_id
WHERE t.status_approval = 'Pending Approval' AND t.trf_time IS NOT NULL
UNION ALL
SELECT 'monitoring', m.id, m.kode, m.created_at, m.operator_id,
       CONCAT(s.silo_name, ' - pH ', m.ph_check, ', ', m.temp_check, ' C')
FROM monitoring m JOIN silo s ON s.id = m.silo_id
WHERE m.status_approval = 'Pending Approval';
