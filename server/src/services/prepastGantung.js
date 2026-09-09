/**
 * Kelengkapan record Prepast - satu sumber aturan "menggantung".
 *
 * Sebuah Prepast MENGGANTUNG (belum boleh disetujui, tampil di "Perlu
 * dilengkapi") bila salah satu data prosesnya belum ada. Semula hanya Waktu
 * Selesai; kini Flowrate, Temp After Heater, dan Temp Output juga - operator
 * boleh menyimpan lebih dulu lalu melengkapinya belakangan, persis seperti
 * waktu selesai yang boleh dikosongkan (BR-23).
 *
 * NOL adalah nilai ukur yang sah (suhu bisa saja rendah), jadi yang dihitung
 * "kosong" hanya null / undefined / string kosong - bukan angka nol.
 */
const kosong = (v) => v === null || v === undefined || v === '';

export const FIELD_KELENGKAPAN_PREPAST = Object.freeze([
  { key: 'prepastFinish', label: 'Waktu Selesai' },
  { key: 'flowrate', label: 'Flowrate' },
  { key: 'tempAfterHeater', label: 'Temp After Heater' },
  { key: 'tempOutput', label: 'Temp Output' },
]);

/**
 * Mengembalikan status beserta nama field yang masih harus dilengkapi.
 * Nilai nol tetap dianggap terisi; hanya NULL/undefined/string kosong yang
 * berarti operator belum memasukkan hasil pengukuran.
 */
export function statusKelengkapanPrepast(nilai) {
  const field = Object.prototype.hasOwnProperty.call(nilai ?? {}, 'prepastStart')
    ? [{ key: 'prepastStart', label: 'Waktu Mulai' }, ...FIELD_KELENGKAPAN_PREPAST]
    : FIELD_KELENGKAPAN_PREPAST;
  const fieldKosong = field
    .filter(({ key }) => kosong(nilai?.[key]))
    .map(({ key, label }) => ({ key, label }));

  return { isGantung: fieldKosong.length > 0, fieldKosong };
}

export function prepastPerluDilengkapi(nilai) {
  return statusKelengkapanPrepast(nilai).isGantung;
}
