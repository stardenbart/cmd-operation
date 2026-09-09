// Sumber tunggal bentuk field koreksi di sisi klien.
//
// Dipakai dua tempat: dialog koreksi langsung (SPV, atau operator atas
// record yang belum disetujui) dan dialog pengajuan permintaan koreksi
// (operator, atas record yang sudah disetujui). Keduanya harus menawarkan
// field yang sama persis, kalau tidak operator melihat pilihan berbeda
// hanya karena statusnya berbeda.

/**
 * Field yang boleh dikoreksi, per modul.
 *
 * Sengaja tidak sama untuk semua: mengubah volume transfer berarti menghitung
 * ulang alokasi FIFO, yang hakikatnya pembatalan dan pemasukan ulang. Field
 * itu karena itu tidak ditampilkan di sini, bukan ditampilkan lalu ditolak
 * server.
 */
export const FIELD = {
  receiving: [
    { k: 'supplierId', label: 'Supplier', jenis: 'pilihSupplier', dari: 'supplier_id' },
    { k: 'qtyKg', label: 'Kuantitas (kg)', jenis: 'angka', dari: 'qty_kg' },
    { k: 'beratJenis', label: 'Berat jenis', jenis: 'angka', dari: 'berat_jenis' },
    { k: 'nilaiTs', label: 'Total solid', jenis: 'angka', dari: 'nilai_ts' },
    { k: 'finishTime', label: 'Waktu selesai', jenis: 'waktu', dari: 'finish_time' },
    { k: 'remarks', label: 'Catatan', jenis: 'teks', dari: 'remarks' },
  ],
  prepast: [
    { k: 'volumeLtr', label: 'Volume (L)', jenis: 'angka', dari: 'vol_prepast_ltr' },
    { k: 'prepastStart', label: 'Mulai', jenis: 'waktu', dari: 'prepast_start' },
    { k: 'prepastFinish', label: 'Selesai', jenis: 'waktu', dari: 'prepast_finish' },
    { k: 'flowrate', label: 'Flowrate', jenis: 'angka', dari: 'flowrate_pst' },
    { k: 'tempAfterHeater', label: 'Temp after heater', jenis: 'angka', dari: 'temp_after_heater', bantuan: 'Ambang OPRP 81 C' },
    { k: 'tempOutput', label: 'Temp output', jenis: 'angka', dari: 'temp_output_prd' },
    { k: 'remarks', label: 'Catatan', jenis: 'teks', dari: 'remarks' },
  ],
  pengembalian: [
    { k: 'volumeLtr', label: 'Volume (L)', jenis: 'angka', dari: 'vol_prepast_ltr' },
    { k: 'prepastStart', label: 'Waktu kembali', jenis: 'waktu', dari: 'prepast_start' },
    // prepast_finish adalah KUNCI URUTAN FIFO pada pengembalian: kapan susu
    // meninggalkan silo. Nilainya memang lebih awal daripada waktu kembali.
    {
      k: 'prepastFinish',
      label: 'Waktu keluar silo',
      jenis: 'waktu',
      dari: 'prepast_finish',
      bantuan: 'Menentukan urutan pemakaian. Boleh lebih awal dari waktu kembali.',
    },
  ],
  transfer: [
    { k: 'trfTime', label: 'Waktu transfer', jenis: 'waktu', dari: 'trf_time' },
    { k: 'tankId', label: 'Tank tujuan', jenis: 'pilihTank', dari: 'tank_id' },
    { k: 'batchPrefix', label: 'Prefiks batch', jenis: 'pilihPrefiks', dari: null },
    { k: 'batchNomor', label: 'Nomor batch', jenis: 'teks', dari: null },
  ],
  monitoring: [
    { k: 'ph', label: 'pH', jenis: 'angka', dari: 'ph_check' },
    { k: 'temp', label: 'Suhu (C)', jenis: 'angka', dari: 'temp_check' },
    { k: 'timeCheck', label: 'Waktu cek', jenis: 'waktu', dari: 'time_check' },
  ],
};
