/**
 * Tata letak form GMP sebagai STRUKTUR DATA - F3-2, FR-28.7
 *
 * Satu definisi, dua penyaji: penyaji Excel menulis ke templatenya, penyaji
 * pratinjau merender HTML. Keduanya membaca berkas ini.
 *
 * Ini syarat arsitektural, bukan preferensi. Pratinjau yang dibangun terpisah
 * dari generator Excel pasti menyimpang seiring waktu, dan pratinjau yang
 * BERBOHONG lebih berbahaya daripada tidak ada pratinjau sama sekali: operator
 * memvalidasi apa yang ia lihat, lalu yang terbit sesuatu yang lain.
 *
 * Seluruh koordinat di sini diturunkan dari berkas hasil export sungguhan di
 * `reference/export-samples/`, bukan dari dugaan. Nomor barisnya tampak ganjil
 * (penerimaan mulai baris 10, transfer mulai baris 21) karena memang begitu
 * bentuk formnya.
 */

/** Kolom Excel 1-berbasis, dari huruf. */
export const keIndeks = (huruf) =>
  [...huruf.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);

/** Huruf kolom dari indeks 1-berbasis. */
export function keHuruf(indeks) {
  let n = indeks;
  let hasil = '';
  while (n > 0) {
    const sisa = (n - 1) % 26;
    hasil = String.fromCharCode(65 + sisa) + hasil;
    n = Math.floor((n - 1) / 26);
  }
  return hasil;
}

/**
 * Urutan silo pada form, MENURUT FORMNYA, bukan menurut basis data.
 *
 * Form memuat delapan kolom silo termasuk SILO4 dan SILO5 yang tidak dipakai
 * lagi. Keduanya tetap ada di sini: form terkendali tidak berubah bentuk hanya
 * karena sebuah silo berhenti dipakai, dan menghapus kolomnya akan menggeser
 * seluruh kolom di sebelah kanannya.
 */
export const URUTAN_SILO_FORM = ['1', '2', '3', '4', '5', '6', '25A', '25B'];

export const REV02 = Object.freeze({
  kode: 'rev02',
  dokumen: {
    nomor: 'CMD1/FRM/PRD/01',
    revisi: '02',
    berlaku: '11 Maret 2025',
    judul: 'Penerimaan, Pre-Pasteurisasi, Pemakaian dan Monitoring Susu Segar',
  },
  berkasTemplate: 'CMD1_FRM_PRD_01_rev02.xlsx',

  halaman1: Object.freeze({
    sheet: 'Receiving_Prepast',
    judul: 'Halaman 1 - Penerimaan & Prepasteurisasi',
    selTanggal: 'C6',
    barisPertama: 10,
    /** 17 baris tersedia (10 sampai 26). Lebih dari itu perlu berkas kedua. */
    kapasitasBaris: 17,
    /**
     * Kolom "Mulai" penerimaan (C) sengaja TIDAK dipetakan.
     *
     * Form menyediakannya, tetapi tidak pernah diisi, dan pemilik proses
     * menegaskan hanya ada satu waktu penerimaan (WF-1). Kolomnya dibiarkan
     * kosong seperti pada seluruh berkas contoh, bukan diisi nilai tebakan.
     */
    kolom: Object.freeze([
      { kunci: 'nomor', huruf: 'A', label: 'No.', jenis: 'nomor', dariTemplate: true },
      { kunci: 'supplier', huruf: 'B', label: 'Supplier FM', jenis: 'teks' },
      { kunci: 'terimaSelesai', huruf: 'D', label: 'Waktu Penerimaan Selesai', jenis: 'jam' },
      { kunci: 'qtyKg', huruf: 'E', label: 'Jumlah (Kg)', jenis: 'angka' },
      { kunci: 'beratJenis', huruf: 'F', label: 'BJ', jenis: 'angka', desimal: 3 },
      { kunci: 'nilaiTs', huruf: 'G', label: 'TS', jenis: 'angka', desimal: 1 },
      { kunci: 'qtyLtr', huruf: 'H', label: 'Jumlah (Lt)', jenis: 'angka' },
      { kunci: 'prepastMulai', huruf: 'I', label: 'Prepast Mulai', jenis: 'jam' },
      { kunci: 'prepastSelesai', huruf: 'J', label: 'Prepast Selesai', jenis: 'jam' },
      { kunci: 'flowrate', huruf: 'K', label: 'Flowrate', jenis: 'angka', desimal: 1 },
      { kunci: 'tempAfterHeater', huruf: 'L', label: 'Temp After Heater (OPRP)', jenis: 'angka', desimal: 1 },
      { kunci: 'tempOutput', huruf: 'M', label: 'Temp Output Produk', jenis: 'angka', desimal: 1 },
      { kunci: 'silo', huruf: 'N', label: 'Disimpan di Silo No', jenis: 'teks' },
      { kunci: 'operator', huruf: 'O', label: 'Dikerjakan Oleh', jenis: 'teks' },
    ]),
    /** Ambang OPRP diambil dari catatan kaki form, bukan dari angka hafalan. */
    catatanKaki: { sel: 'A27', teks: '*) Setting Temp. : 90oC, Min Temp. : 81oC' },
    oprpTempMin: 81,
  }),

  halaman2: Object.freeze({
    sheet: 'Monitoring_Transfer',
    judul: 'Halaman 2 - Monitoring & Pemakaian',
    selTanggal: 'C6',

    monitoring: Object.freeze({
      barisPertama: 10,
      /** Tujuh slot, berlabel "4 jam I" sampai "4 jam VII" di kolom A. */
      kapasitasSlot: 7,
      barisOperator: 18,
      /** Kolom B. Tiap silo tiga kolom: jam, suhu, pH. */
      kolomPertama: keIndeks('B'),
      kolomPerSilo: 3,
      subKolom: Object.freeze(['jam', 'suhu', 'ph']),
      urutanSilo: URUTAN_SILO_FORM,
    }),

    transfer: Object.freeze({
      barisPertama: 21,
      /** Tiga baris per silo, jadi 21 slot transfer per silo. */
      barisPerSilo: 3,
      /** Kolom D. Tiap slot tiga kolom: jam, batch, volume. */
      kolomPertama: keIndeks('D'),
      kolomPerSlot: 3,
      slotPerBaris: 7,
      subKolom: Object.freeze(['jam', 'batch', 'volume']),
      urutanSilo: URUTAN_SILO_FORM,
      /** Kolom saldo awal, ditunda ke L-1 (D-15). Belum diisi. */
      kolomJumlahAwal: keIndeks('B'),
    }),
  }),
});

/** Kapasitas transfer per silo, dihitung dari tata letaknya. */
export const kapasitasTransferPerSilo = (t) => t.barisPerSilo * t.slotPerBaris;

/**
 * Alamat sel untuk satu nilai monitoring.
 *
 * @param {number} indeksSilo  posisi silo pada urutan form
 * @param {number} indeksSlot  0 sampai kapasitasSlot-1
 * @param {'jam'|'suhu'|'ph'} sub
 */
export function selMonitoring(m, indeksSilo, indeksSlot, sub) {
  const kolom = m.kolomPertama + indeksSilo * m.kolomPerSilo + m.subKolom.indexOf(sub);
  return { baris: m.barisPertama + indeksSlot, kolom };
}

/**
 * Alamat sel untuk satu transfer.
 *
 * Slot mengalir mendatar dulu (7 per baris), baru turun ke baris berikutnya
 * dari silo yang sama. Urutan ini penting: membacanya kolom-dulu akan
 * menempatkan transfer kedua di baris kedua, padahal pada form ia berada di
 * sebelah kanan transfer pertama.
 */
export function selTransfer(t, indeksSilo, indeksSlot, sub) {
  const barisDalamSilo = Math.floor(indeksSlot / t.slotPerBaris);
  const posisiDalamBaris = indeksSlot % t.slotPerBaris;
  return {
    baris: t.barisPertama + indeksSilo * t.barisPerSilo + barisDalamSilo,
    kolom: t.kolomPertama + posisiDalamBaris * t.kolomPerSlot + t.subKolom.indexOf(sub),
  };
}

/** Revisi yang berlaku menurut tanggal data (FR-12.7). */
const REVISI = [{ mulai: '2025-03-11', tataLetak: REV02 }];

export function tataLetakUntuk(tanggalIso) {
  const berlaku = REVISI.filter((r) => r.mulai <= tanggalIso).at(-1) ?? REVISI[0];
  return berlaku.tataLetak;
}
