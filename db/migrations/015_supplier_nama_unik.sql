-- Nama supplier harus UNIK.
--
-- Master supplier sempat terisi ganda. 001_master_seed.sql memasukkan baris
-- dengan kode placeholder (AKB, AJI, ...), lalu 002_master_nyata.sql mengganti
-- kode itu menjadi kode SAP numerik dengan mencocokkan NAMA. Karena keunikan
-- selama ini hanya dijaga pada `kode`, menjalankan seed sekali lagi SETELAH
-- penggantian kode membuat 001 menyisipkan baris baru bernama sama - kode
-- 'AKB' sudah tidak ada lagi untuk memicu ON DUPLICATE KEY, sehingga satu
-- supplier muncul dua kali di dropdown Penerimaan.
--
-- Kunci unik pada nama menutup celah itu di pangkalnya: seed ulang mengenai
-- baris yang sudah ada lewat NAMANYA, bukan membuat kembar baru. Prasyaratnya
-- duplikat nama sudah dibersihkan lebih dulu; bila masih ada, ALTER ini gagal
-- dengan jelas - dan gagal memang benar, sebab keunikan tidak dapat ditegakkan
-- di atas data yang melanggarnya.
ALTER TABLE supplier
  ADD UNIQUE KEY uq_supplier_name (supplier_name);
