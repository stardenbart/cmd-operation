-- Koreksi satu kali untuk waktu proses yang ditulis sebelum runtime resmi
-- memakai Asia/Jakarta pada 4 September 2026 03:53:58 UTC.
--
-- Sebelum cutover tersebut importer dan input datetime-local berjalan dengan
-- TZ=UTC. Jam dinding SharePoint/operator (WIB) karena itu tersimpan seolah-olah
-- UTC dan ketika dibaca UI bergeser lagi +7 jam. Yang dikoreksi hanya waktu
-- proses yang diketik operator; created_at, updated_at, approved_at, dan audit
-- adalah waktu sistem UTC yang sejak awal sudah benar.

START TRANSACTION;

SET @wib_runtime_cutover = TIMESTAMP('2026-09-04 03:53:58');

UPDATE receiving
   SET finish_time = DATE_SUB(finish_time, INTERVAL 7 HOUR),
       updated_at = updated_at
 WHERE created_at < @wib_runtime_cutover;

UPDATE prepast_record
   SET prepast_start  = IF(prepast_start  IS NULL, NULL, DATE_SUB(prepast_start,  INTERVAL 7 HOUR)),
       prepast_finish = IF(prepast_finish IS NULL, NULL, DATE_SUB(prepast_finish, INTERVAL 7 HOUR)),
       updated_at = updated_at
 WHERE created_at < @wib_runtime_cutover;

UPDATE transfer
   SET trf_time = IF(trf_time IS NULL, NULL, DATE_SUB(trf_time, INTERVAL 7 HOUR)),
       anchor_asal_sebelum = IF(
         anchor_asal_sebelum IS NULL,
         NULL,
         DATE_SUB(anchor_asal_sebelum, INTERVAL 7 HOUR)
       ),
       updated_at = updated_at
 WHERE created_at < @wib_runtime_cutover;

UPDATE monitoring
   SET time_check = DATE_SUB(time_check, INTERVAL 7 HOUR),
       updated_at = updated_at
 WHERE created_at < @wib_runtime_cutover;

-- Anchor merupakan turunan dari rangkaian proses di atas, bukan waktu sistem.
-- updated_at membatasi anchor legacy agar aktivitas pasca-cutover tidak digeser.
UPDATE silo
   SET standing_time_anchor = DATE_SUB(standing_time_anchor, INTERVAL 7 HOUR),
       updated_at = updated_at
 WHERE standing_time_anchor IS NOT NULL
   AND updated_at < @wib_runtime_cutover;

COMMIT;
