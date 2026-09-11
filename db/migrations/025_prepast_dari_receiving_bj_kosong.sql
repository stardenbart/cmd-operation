-- ============================================================
-- 025_prepast_dari_receiving_bj_kosong.sql
-- Receiving tanpa Berat Jenis tetap bisa dipilih untuk Prepast.
-- Volumenya belum diketahui (qty_remaining_ltr NULL) — bukan berarti habis.
-- Volume Prepast-nya sendiri wajib menyusul lewat pelengkapan setelah Berat
-- Jenis Receiving diisi (ditegakkan di lapis aplikasi, bukan di sini).
-- ============================================================

CREATE OR REPLACE VIEW v_buffer_queue AS
SELECT
  r.id, r.kode, r.supplier_id, sup.supplier_name,
  r.qty_kg, r.berat_jenis, r.qty_ltr, r.qty_remaining_ltr,
  r.nilai_ts, r.finish_time, r.status_approval, r.buffer_status
FROM receiving r
JOIN supplier sup ON sup.id = r.supplier_id
JOIN silo s       ON s.id = r.silo_id
WHERE s.is_buffer = TRUE
  AND r.status_fifo = 'ACTIVE'
  AND (r.qty_remaining_ltr > 0 OR r.qty_remaining_ltr IS NULL)
  AND r.status_approval NOT IN ('Rejected','REVISED','VOIDED')
ORDER BY r.finish_time ASC, r.id ASC;
