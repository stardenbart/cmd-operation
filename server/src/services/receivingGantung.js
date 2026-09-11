/** Satu sumber aturan kelengkapan Receiving. */

const kosong = (nilai) => nilai === null || nilai === undefined || nilai === '';

export const FIELD_KELENGKAPAN_RECEIVING = Object.freeze([
  { key: 'beratJenis', label: 'Berat Jenis' },
  { key: 'nilaiTs', label: 'Total Solid' },
]);

export function statusKelengkapanReceiving(nilai) {
  const fieldKosong = FIELD_KELENGKAPAN_RECEIVING
    .filter(({ key }) => kosong(nilai?.[key]))
    .map(({ key, label }) => ({ key, label }));

  return { isGantung: fieldKosong.length > 0, fieldKosong };
}
