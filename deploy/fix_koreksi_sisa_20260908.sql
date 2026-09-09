-- Koreksi data akibat bug koreksi non-volume (8 Sep 2026).
--
-- Saat PST-20260905-009 (id 12318, SILO1) dan PST-20260905-010 (id 12319,
-- SILO2) dikoreksi hanya untuk mengisi flowrate/suhu, logika koreksi keliru
-- menyetel ulang qty_remaining_ltr ke volume penuh dan status_fifo ke ACTIVE.
-- Akibatnya volume yang SUDAH HABIS terpakai transfer muncul lagi di silo.
--
-- Sisa yang benar = vol_prepast_ltr - jumlah dialokasikan transfer non-void.
-- Untuk kedua record ini alokasi = volume penuh, jadi sisa benar = 0 (CLOSED).
--
-- Dijaga idempoten: hanya menyentuh baris yang MASIH bertanda korup
-- (status_fifo='ACTIVE' DAN qty_remaining_ltr = vol_prepast_ltr).

START TRANSACTION;

-- Audit BEFORE -> AFTER (CORRECT oleh Abdullah Farauk, id 10).
INSERT INTO audit_log (entity, entity_id, action, actor_id, before_json, after_json, reason)
SELECT 'prepast_record', p.id, 'CORRECT', 10,
  JSON_OBJECT('qty_remaining_ltr', p.qty_remaining_ltr, 'status_fifo', p.status_fifo),
  JSON_OBJECT('qty_remaining_ltr', GREATEST(p.vol_prepast_ltr - a.dipakai, 0),
              'status_fifo', IF(p.vol_prepast_ltr - a.dipakai > 0.001, 'ACTIVE', 'CLOSED')),
  'Perbaikan sisa/status FIFO: koreksi non-volume keliru mengembalikan volume yang sudah terpakai'
FROM prepast_record p
JOIN (
  SELECT ta.prepast_id, SUM(ta.qty_allocated) dipakai
  FROM transfer_allocation ta JOIN transfer t ON t.id = ta.transfer_id
  WHERE t.status_approval NOT IN ('VOIDED', 'REVISED', 'Rejected')
  GROUP BY ta.prepast_id
) a ON a.prepast_id = p.id
WHERE p.id IN (12318, 12319)
  AND p.status_fifo = 'ACTIVE'
  AND ABS(p.qty_remaining_ltr - p.vol_prepast_ltr) < 0.01;

UPDATE prepast_record p
JOIN (
  SELECT ta.prepast_id, SUM(ta.qty_allocated) dipakai
  FROM transfer_allocation ta JOIN transfer t ON t.id = ta.transfer_id
  WHERE t.status_approval NOT IN ('VOIDED', 'REVISED', 'Rejected')
  GROUP BY ta.prepast_id
) a ON a.prepast_id = p.id
   SET p.qty_remaining_ltr = GREATEST(p.vol_prepast_ltr - a.dipakai, 0),
       p.status_fifo = IF(p.vol_prepast_ltr - a.dipakai > 0.001, 'ACTIVE', 'CLOSED'),
       p.updated_at = p.updated_at
 WHERE p.id IN (12318, 12319)
   AND p.status_fifo = 'ACTIVE'
   AND ABS(p.qty_remaining_ltr - p.vol_prepast_ltr) < 0.01;

COMMIT;
