/**
 * Alokasi FIFO — BR-04 & BR-05
 *
 * Menentukan batch prepast mana yang dipakai untuk memenuhi suatu transfer,
 * dengan urutan first-in-first-out: yang paling lama masuk silo, keluar duluan.
 *
 * FUNGSI MURNI. Tanpa I/O, tanpa akses basis data, tanpa jam sistem.
 * Sifat itu disengaja — inilah bagian paling berisiko di seluruh sistem
 * (jalur kritis E.9), sehingga harus dapat diuji tuntas tanpa infrastruktur.
 *
 * Pemanggil bertanggung jawab mengunci baris (SELECT ... FOR UPDATE) sebelum
 * memanggil fungsi ini, agar dua transfer bersamaan dari silo yang sama tidak
 * mengalokasikan volume yang sama dua kali (M-5).
 */

/**
 * Seluruh aritmetika dilakukan dalam bilangan bulat perseratus liter.
 *
 * Alasannya: aritmetika desimal biner meleset (0.1 + 0.2 = 0.30000000000000004),
 * dan pada sistem yang menjumlahkan ribuan alokasi, kesalahan sekecil itu
 * menumpuk menjadi liter yang tercipta atau lenyap dari ketiadaan.
 */
const SKALA = 100;

const keSkala = (liter) => Math.round(liter * SKALA);
const dariSkala = (unit) => unit / SKALA;

/**
 * @typedef {object} BatchPrepast
 * @property {number} id
 * @property {string} kode
 * @property {number} supplierId
 * @property {number} qtyRemainingLtr
 * @property {Date}   prepastFinish
 *
 * @typedef {object} Alokasi
 * @property {number}  prepastId
 * @property {string}  prepastKode
 * @property {number}  supplierId
 * @property {number}  qtyAvailable  sisa batch sebelum alokasi
 * @property {number}  qtyAllocated
 * @property {number}  qtyAfter      sisa batch sesudah alokasi
 * @property {boolean} willClose     TRUE bila sisanya menjadi nol (BR-08)
 * @property {number}  urutanFifo    1 = paling lama
 *
 * @typedef {object} HasilAlokasi
 * @property {Alokasi[]} allocations
 * @property {number}    totalAllocated
 * @property {number}    unallocated       sisa yang tidak dapat dipenuhi
 * @property {boolean}   isFullyAllocated  BR-05 — submit hanya boleh bila TRUE
 */

/**
 * Mengurutkan batch menurut FIFO.
 *
 * Pemecah seri `id` bersifat WAJIB, bukan kelengkapan. Power Apps tidak
 * menetapkannya, sehingga dua batch berwaktu selesai sama urutannya
 * bergantung pada urutan pengembalian SharePoint — yang tidak dijamin
 * dan dapat berubah antar pemanggilan (uji T-5.7).
 */
function urutkanFifo(batches) {
  return [...batches].sort((a, b) => {
    const selisih = a.prepastFinish - b.prepastFinish;
    return selisih !== 0 ? selisih : a.id - b.id;
  });
}

/**
 * Membagi volume transfer ke batch-batch prepast menurut urutan FIFO.
 *
 * @param {BatchPrepast[]} batches  Batch aktif di silo asal
 * @param {number} volumeLtr        Volume yang diminta, dalam liter
 * @returns {HasilAlokasi}
 * @throws {TypeError} bila volume bukan angka positif
 */
export function allocateFifo(batches, volumeLtr) {
  if (typeof volumeLtr !== 'number' || !Number.isFinite(volumeLtr) || volumeLtr <= 0) {
    throw new TypeError(
      `Volume transfer harus angka positif, diterima: ${volumeLtr}`,
    );
  }

  let sisaDiminta = keSkala(volumeLtr);
  const allocations = [];

  for (const batch of urutkanFifo(batches)) {
    if (sisaDiminta <= 0) break;

    const tersedia = keSkala(batch.qtyRemainingLtr);

    // Batch bersisa nol — atau negatif, yang berarti data rusak — dilewati
    // tanpa menghasilkan baris alokasi kosong (T-5.6).
    if (tersedia <= 0) continue;

    const dialokasikan = Math.min(tersedia, sisaDiminta);
    const sesudah = tersedia - dialokasikan;

    allocations.push({
      prepastId: batch.id,
      prepastKode: batch.kode,
      supplierId: batch.supplierId,
      qtyAvailable: dariSkala(tersedia),
      qtyAllocated: dariSkala(dialokasikan),
      qtyAfter: dariSkala(sesudah),
      willClose: sesudah === 0,
      urutanFifo: allocations.length + 1,
    });

    sisaDiminta -= dialokasikan;
  }

  const totalTeralokasi = keSkala(volumeLtr) - sisaDiminta;

  return {
    allocations,
    totalAllocated: dariSkala(totalTeralokasi),
    unallocated: dariSkala(sisaDiminta),
    isFullyAllocated: sisaDiminta === 0,
  };
}
