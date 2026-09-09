-- Koreksi satu kali: tanggal prepast maju 1 hari akibat salah input operator,
-- sedari PST-20260904-921 (6 Sep 2026). Prepast yang seharusnya selesai di
-- hari yang sama tercatat di hari berikutnya, lalu menjalar lewat kontinuitas
-- (start record berikutnya = finish record sebelumnya).
--
-- Aturan: kurangi 1 hari pada prepast_start / prepast_finish yang JELAS maju
-- sehari, yaitu yang jatuh >= 12 jam SETELAH waktu pencatatannya (created_at) -
-- karena waktu proses tak mungkin berada jauh di masa depan dari saat direkam.
-- Record yang sudah benar (mis. PST-20260905-011/012, dan Start PST-20260904-921)
-- otomatis tidak tersentuh karena tidak memenuhi syarat itu. Hasil koreksi
-- untuk 921 sama persis dengan yang operator coba simpan sendiri (start 21:59,
-- finish 21:49 WIB tanggal 4).
--
-- Penyimpanan UTC (A-4); nilai di sini UTC. Perubahan dicatat ke audit_log
-- sebagai CORRECT oleh Abdullah Farauk (operator id 10).

START TRANSACTION;

INSERT INTO audit_log (entity, entity_id, action, actor_id, before_json, after_json, reason)
SELECT 'prepast_record', p.id, 'CORRECT', 10,
  JSON_OBJECT(
    'prepast_start',  DATE_FORMAT(p.prepast_start,  '%Y-%m-%d %H:%i:%s'),
    'prepast_finish', DATE_FORMAT(p.prepast_finish, '%Y-%m-%d %H:%i:%s')),
  JSON_OBJECT(
    'prepast_start',  DATE_FORMAT(IF(TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_start) >=12, DATE_SUB(p.prepast_start, INTERVAL 1 DAY), p.prepast_start),  '%Y-%m-%d %H:%i:%s'),
    'prepast_finish', DATE_FORMAT(IF(TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_finish)>=12, DATE_SUB(p.prepast_finish,INTERVAL 1 DAY), p.prepast_finish), '%Y-%m-%d %H:%i:%s')),
  'Koreksi tanggal prepast maju 1 hari - salah input operator, sedari PST-20260904-921'
FROM prepast_record p
WHERE p.kode >= 'PST-20260904-921'
  AND COALESCE(p.jenis_batch,'PREPAST') = 'PREPAST'
  AND ( TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_start)  >= 12
     OR TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_finish) >= 12 );

UPDATE prepast_record p
   SET p.prepast_start  = IF(TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_start) >=12, DATE_SUB(p.prepast_start, INTERVAL 1 DAY), p.prepast_start),
       p.prepast_finish = IF(TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_finish)>=12, DATE_SUB(p.prepast_finish,INTERVAL 1 DAY), p.prepast_finish),
       p.updated_at = p.updated_at
 WHERE p.kode >= 'PST-20260904-921'
   AND COALESCE(p.jenis_batch,'PREPAST') = 'PREPAST'
   AND ( TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_start)  >= 12
      OR TIMESTAMPDIFF(HOUR,p.created_at,p.prepast_finish) >= 12 );

-- Anchor silo yang ikut maju sehari (anchor tak mungkin berada di masa depan).
UPDATE silo
   SET standing_time_anchor = DATE_SUB(standing_time_anchor, INTERVAL 1 DAY),
       updated_at = updated_at
 WHERE standing_time_anchor IS NOT NULL
   AND standing_time_anchor > UTC_TIMESTAMP();

COMMIT;
