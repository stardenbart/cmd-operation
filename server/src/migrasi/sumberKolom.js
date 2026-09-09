/**
 * Peta kolom SharePoint ke MySQL - Fase 4, Bagian 11.1 & 11.2
 *
 * Nama kolom di sini BUKAN tebakan. Seluruhnya dibaca dari pemanggilan
 * `Patch()` di definisi Power Apps (`reference/powerapps-yaml/`), yaitu tempat
 * aplikasi lama benar-benar menulis ke SharePoint.
 *
 * SATU PEMETAAN YANG PANTAS DIBACA DUA KALI:
 *
 *   receiving.finish_time  <-  start_time
 *
 * Itu bukan salah ketik. Kolom SharePoint bernama `start_time` menyimpan waktu
 * SELESAI penerimaan. Buktinya dua lapis: flow export lama menulis `start_time`
 * ke kolom form "Waktu Penerimaan - Selesai", dan pada seluruh 20 berkas hasil
 * export kolom "Mulai" kosong sedangkan "Selesai" terisi. Pemilik proses juga
 * menegaskan hanya ada satu waktu penerimaan (WF-1). Memetakannya ke
 * `start_time` yang baru akan memindahkan seluruh jam penerimaan ke kolom yang
 * tidak pernah dibaca siapa pun.
 */

/** Jenis nilai, menentukan cara parsing dan cara melaporkan kegagalannya. */
export const J = {
  teks: 'teks',
  angka: 'angka',
  waktu: 'waktu',
  tanggal: 'tanggal',
  pilihan: 'pilihan',
  json: 'json',
  boolean: 'boolean',
};

/**
 * Definisi tiap list.
 *
 * `kunciAlami` adalah kolom yang membuat migrasi IDEMPOTEN (T-23): dijalankan
 * dua kali menghasilkan keadaan yang sama, sebab baris dikenali dari kodenya,
 * bukan dari urutan pemuatan. Di SharePoint kolom itu `Title`.
 */
export const LIST = Object.freeze({
  receiving: {
    berkas: 'FM_Receiving_Penerimaan',
    tabel: 'receiving',
    kunciAlami: 'kode',
    kolom: [
      { dari: 'id_receiving', ke: 'kode', jenis: J.teks, wajib: true },
      { dari: 'supplier_display_name', ke: '_supplier_nama', jenis: J.teks },
      { dari: 'supplier', ke: '_supplier_kode', jenis: J.teks },
      { dari: 'silo_number', ke: '_silo_kode', jenis: J.teks },
      { dari: 'silo_display_name', ke: '_silo_nama', jenis: J.teks },
      { dari: 'qty_kg', ke: 'qty_kg', jenis: J.angka, wajib: true },
      { dari: 'berat_jenis', ke: 'berat_jenis', jenis: J.angka, wajib: true },
      { dari: 'nilai_ts', ke: 'nilai_ts', jenis: J.angka },
      { dari: 'qty_remaining_ltr', ke: 'qty_remaining_ltr', jenis: J.angka },
      // NOT NULL di skema - lihat catatan wajib di bawah
      { dari: 'finish_time', ke: 'finish_time', jenis: J.waktu, wajib: true },
      { dari: 'nama_op', ke: '_operator_nama', jenis: J.teks },
      { dari: 'status_approval', ke: 'status_approval', jenis: J.pilihan },
      { dari: 'status_fifo', ke: 'status_fifo', jenis: J.pilihan },
      { dari: 'buffer_status', ke: 'buffer_status', jenis: J.pilihan },
      { dari: 'cmd_source', ke: 'cmd_source', jenis: J.pilihan },
      { dari: 'correction_ref', ke: '_correction_ref', jenis: J.teks },
    ],
  },

  prepast: {
    berkas: 'FM_Prepast_Record',
    tabel: 'prepast_record',
    kunciAlami: 'kode',
    kolom: [
      { dari: 'prepast_id', ke: 'kode', jenis: J.teks, wajib: true },
      { dari: 'id_receiving', ke: '_receiving_kode', jenis: J.teks },
      { dari: 'supplier_code', ke: '_supplier_kode', jenis: J.teks },
      { dari: 'supplier_display_name', ke: '_supplier_nama', jenis: J.teks },
      { dari: 'silo_tujuan', ke: '_silo_kode', jenis: J.teks },
      { dari: 'silo_tujuan_display', ke: '_silo_nama', jenis: J.teks },
      { dari: 'vol_prepast_ltr', ke: 'vol_prepast_ltr', jenis: J.angka, wajib: true },
      { dari: 'qty_remaining_ltr', ke: 'qty_remaining_ltr', jenis: J.angka },
      { dari: 'prepast_start', ke: 'prepast_start', jenis: J.waktu },
      { dari: 'prepast_finish', ke: 'prepast_finish', jenis: J.waktu },
      { dari: 'flowrate_pst', ke: 'flowrate_pst', jenis: J.angka },
      { dari: 'temp_after_heater', ke: 'temp_after_heater', jenis: J.angka },
      { dari: 'temp_output_prd', ke: 'temp_output_prd', jenis: J.angka },
      { dari: 'nilai_ts', ke: 'nilai_ts', jenis: J.angka },
      { dari: 'nama_op', ke: '_operator_nama', jenis: J.teks },
      { dari: 'status_approval', ke: 'status_approval', jenis: J.pilihan },
      { dari: 'status_fifo', ke: 'status_fifo', jenis: J.pilihan },
      { dari: 'cmd_source', ke: 'cmd_source', jenis: J.pilihan },
      { dari: 'transfer_ref', ke: '_transfer_ref', jenis: J.teks },
      { dari: 'correction_ref', ke: '_correction_ref', jenis: J.teks },
      { dari: 'remarks', ke: 'remarks', jenis: J.teks },
    ],
  },

  transfer: {
    berkas: 'FM_Receiving_Transfer',
    tabel: 'transfer',
    kunciAlami: 'kode',
    kolom: [
      { dari: 'trf_id', ke: 'kode', jenis: J.teks, wajib: true },
      { dari: 'transfer_type', ke: 'transfer_type', jenis: J.pilihan, wajib: true },
      { dari: 'silo_number', ke: '_silo_asal_kode', jenis: J.teks },
      { dari: 'silo_display_name', ke: '_silo_asal_nama', jenis: J.teks },
      { dari: 'tank_trf_qr_value', ke: '_tank_qr', jenis: J.teks },
      /*
       * Pada PINDAH SILO, kolom ini memuat NAMA SILO TUJUAN, bukan tank.
       * Terlihat di data: tank_trf 'SILO6' dengan batch 'TF TO SILO6'.
       * Kolom silo_tujuan tidak ikut terekspor, jadi inilah satu-satunya
       * petunjuk tujuannya.
       */
      { dari: 'tank_trf', ke: '_tank_nama', jenis: J.teks },
      { dari: 'vol_ltr', ke: 'vol_ltr', jenis: J.angka, wajib: true },
      { dari: 'vol_akt_silo_ltr', ke: 'vol_akt_silo_ltr', jenis: J.angka },
      { dari: 'batch', ke: '_batch_mentah', jenis: J.teks },
      { dari: 'trf_time', ke: 'trf_time', jenis: J.waktu },
      { dari: 'standing_time_menit', ke: 'standing_time_menit', jenis: J.angka },
      { dari: 'nama_op', ke: '_operator_nama', jenis: J.teks },
      { dari: 'status_approval', ke: 'status_approval', jenis: J.pilihan },
      { dari: 'cmd_destination', ke: 'cmd_destination', jenis: J.pilihan },
      { dari: 'correction_ref', ke: '_correction_ref', jenis: J.teks },
      // Dibongkar menjadi baris transfer_allocation (F4-4)
      { dari: 'supplier_fifo', ke: '_supplier_fifo', jenis: J.json },
    ],
  },

  monitoring: {
    berkas: 'FM_Receiving_Monitoring',
    tabel: 'monitoring',
    kunciAlami: 'kode',
    kolom: [
      { dari: 'checking_id', ke: 'kode', jenis: J.teks, wajib: true },
      { dari: 'silo_number', ke: '_silo_kode', jenis: J.teks },
      { dari: 'silo_display_name', ke: '_silo_nama', jenis: J.teks },
      { dari: 'ph_check', ke: 'ph_check', jenis: J.angka },
      { dari: 'temp_check', ke: 'temp_check', jenis: J.angka },
      // NOT NULL di skema
      { dari: 'time_check', ke: 'time_check', jenis: J.waktu, wajib: true },
      { dari: 'supplier_list', ke: 'supplier_list', jenis: J.teks },
      { dari: 'val_aktual_snapshot_ltr', ke: 'val_aktual_snapshot_ltr', jenis: J.angka },
      { dari: 'nama_op', ke: '_operator_nama', jenis: J.teks },
      { dari: 'status_approval', ke: 'status_approval', jenis: J.pilihan },
      { dari: 'correction_ref', ke: '_correction_ref', jenis: J.teks },
    ],
  },

  stockOpname: {
    berkas: 'FM_Stock_Opname',
    tabel: 'stock_opname',
    kunciAlami: '_kunci_periode_silo',
    kolom: [
      { dari: 'periode', ke: 'periode', jenis: J.teks, wajib: true },
      { dari: 'silo_number', ke: '_silo_kode', jenis: J.teks, wajib: true },
      { dari: 'jumlah_awal_ltr', ke: 'jumlah_awal_ltr', jenis: J.angka },
    ],
  },
});

/**
 * Status SharePoint ke ENUM MySQL.
 *
 * Nilai yang tidak dikenal TIDAK dipetakan ke nilai bawaan. Menebak status
 * approval berarti menebak apakah sebuah catatan mutu sudah disetujui, dan itu
 * bukan tebakan yang boleh dilakukan diam-diam.
 */
export const PETA_STATUS = Object.freeze({
  'Pending Approval': 'Pending Approval',
  Approved: 'Approved',
  Rejected: 'Rejected',
  REVISED: 'REVISED',
  VOIDED: 'VOIDED',
  'Edit Requested': 'Edit Requested',
});

export const PETA_FIFO = Object.freeze({ ACTIVE: 'ACTIVE', CLOSED: 'CLOSED' });

/**
 * ENUM lain yang nilainya datang dari sumber.
 *
 * Divalidasi di lapis migrasi, bukan diserahkan ke MySQL. MySQL dalam mode
 * longgar menerima nilai asing sebagai string kosong TANPA berkata apa-apa,
 * dan status yang kosong pada catatan mutu tidak dapat dibedakan dari status
 * yang memang belum diisi. Yang tidak dikenal karena itu masuk laporan.
 *
 * Ejaan lama yang sudah diketahui dipetakan, bukan ditolak: sumbernya berjalan
 * bertahun-tahun dan istilahnya sempat berganti.
 */
export const PETA_BUFFER = Object.freeze({
  IN_BUFFER: 'IN_BUFFER',
  IN_PREPAST: 'IN_PREPAST',
  COMPLETED: 'COMPLETED',
  // Ejaan lama yang setara
  PREPASTED: 'COMPLETED',
  DONE: 'COMPLETED',
});

export const PETA_CMD = Object.freeze({ CMD1: 'CMD1', CMD2: 'CMD2' });

export const PETA_JENIS_TRANSFER = Object.freeze({
  'PEMAKAIAN PRODUKSI': 'PEMAKAIAN PRODUKSI',
  'PINDAH SILO': 'PINDAH SILO',
});
