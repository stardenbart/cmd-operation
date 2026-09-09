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

export function prepastPerluDilengkapi({ prepastFinish, flowrate, tempAfterHeater, tempOutput }) {
  return kosong(prepastFinish) || kosong(flowrate) || kosong(tempAfterHeater) || kosong(tempOutput);
}
