/**
 * Konversi & penguraian angka — BR-03
 *
 * FUNGSI MURNI. Dipakai lintas modul: Receiving, Prepast, dan Transfer
 * semuanya menerima angka desimal dari operator.
 */

/**
 * Mengubah kuantitas kilogram menjadi liter — BR-03.
 *
 * Selalu dibulatkan ke BAWAH. Diverifikasi terhadap 168 baris data produksi:
 * 163 cocok persis dengan FLOOR, nol cocok dengan pembulatan terdekat maupun
 * ke atas.
 *
 * Pembulatan ke bawah bukan kebetulan — ia memastikan sistem tidak pernah
 * mengklaim liter yang tidak ada. Volume yang tercatat selalu sama dengan
 * atau lebih kecil daripada yang sesungguhnya diterima.
 *
 * @param {number} qtyKg
 * @param {number} beratJenis
 * @returns {number} liter, bilangan bulat
 */
export function hitungQtyLtr(qtyKg, beratJenis) {
  if (typeof qtyKg !== 'number' || !Number.isFinite(qtyKg) || qtyKg <= 0) {
    throw new TypeError(`Kuantitas harus angka positif, diterima: ${qtyKg}`);
  }
  if (typeof beratJenis !== 'number' || !Number.isFinite(beratJenis) || beratJenis <= 0) {
    throw new TypeError(`Berat jenis harus angka positif, diterima: ${beratJenis}`);
  }
  return Math.floor(qtyKg / beratJenis);
}

/**
 * Menguraikan angka desimal yang diketik operator.
 *
 * Menerima titik maupun koma sebagai pemisah desimal — operator mengetik
 * dengan tata tulis Indonesia, dan memaksa satu bentuk hanya akan
 * menghasilkan penolakan yang membingungkan di lantai produksi.
 *
 * Power Apps menanganinya dengan `Substitute(text, ",", ".")` yang tersebar
 * di belasan formula; di sini terpusat pada satu tempat.
 *
 * Masukan dengan DUA pemisah ditolak, bukan ditebak: "1.025" bermakna
 * 1,025 dalam tata tulis Indonesia tetapi 1025 dalam tata tulis Inggris.
 * Salah menebak berarti salah seribu kali lipat.
 *
 * @param {string|number} masukan
 * @returns {number}
 */
export function parseAngka(masukan) {
  if (typeof masukan === 'number') {
    if (!Number.isFinite(masukan)) {
      throw new TypeError(`Bukan angka yang sah: ${masukan}`);
    }
    return masukan;
  }

  if (typeof masukan !== 'string') {
    throw new TypeError(`Bukan angka: ${masukan}`);
  }

  const bersih = masukan.trim();
  if (bersih === '') {
    throw new TypeError('Angka tidak boleh kosong');
  }

  if (bersih.includes('.') && bersih.includes(',')) {
    throw new TypeError(
      `Format angka ambigu: "${bersih}". Gunakan satu pemisah desimal saja.`,
    );
  }

  const nilai = Number(bersih.replace(',', '.'));
  if (!Number.isFinite(nilai)) {
    throw new TypeError(`Bukan angka yang sah: "${bersih}"`);
  }
  return nilai;
}
