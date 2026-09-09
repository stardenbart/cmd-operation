/**
 * Keputusan anchor standing time pada transfer — BR-09
 *
 * FUNGSI MURNI. Tidak menyentuh basis data, tidak memanggil jam sistem —
 * waktu transfer selalu diterima sebagai argumen.
 *
 * Standing time menjawab "sudah berapa lama susu ini berdiri di silo", dan
 * itu indikator mutu. Anchor yang keliru membuatnya melenceng tanpa pesan
 * error apa pun, jadi logikanya diisolasi agar dapat diuji tuntas.
 */

const JENIS_SAH = new Set(['PEMAKAIAN PRODUKSI', 'PINDAH SILO']);

// Perbandingan volume dilakukan dalam bilangan bulat perseratus liter, sama
// seperti allocateFifo — supaya "transfer penuh" tidak gagal terdeteksi
// karena 0.1 + 0.2 tidak persis 0.3 dalam desimal biner.
const keSkala = (l) => Math.round(l * 100);

/**
 * @param {object} p
 * @param {'PEMAKAIAN PRODUKSI'|'PINDAH SILO'} p.jenis
 * @param {number} p.volAktualAsal  volume silo asal sebelum transfer
 * @param {number} p.volTransfer
 * @param {Date|null} [p.anchorAsal]
 * @param {Date|null} [p.anchorTujuan] hanya relevan untuk PINDAH SILO
 * @param {Date} p.waktuTransfer
 * @returns {{resetAnchorAsal: boolean, anchorTujuanBaru: Date|null, transferPenuh: boolean}}
 */
export function putuskanAnchor({
  jenis,
  volAktualAsal,
  volTransfer,
  anchorAsal = null,
  anchorTujuan = null,
  waktuTransfer,
}) {
  if (!JENIS_SAH.has(jenis)) {
    throw new TypeError(`Jenis transfer tidak dikenal: ${jenis}`);
  }
  if (!(waktuTransfer instanceof Date) || Number.isNaN(waktuTransfer.getTime())) {
    throw new TypeError(`Waktu transfer harus berupa tanggal yang sah, diterima: ${waktuTransfer}`);
  }

  const aktual = keSkala(volAktualAsal);
  const dipindah = keSkala(volTransfer);

  if (dipindah > aktual) {
    throw new TypeError(
      `Volume transfer ${volTransfer} L melebihi volume aktual silo ${volAktualAsal} L`,
    );
  }

  const transferPenuh = dipindah === aktual;

  // Silo asal menjadi kosong → hitungan standing time berakhir.
  // Bila anchornya memang belum pernah di-set, tidak ada yang perlu direset.
  const resetAnchorAsal = transferPenuh && anchorAsal !== null;

  let anchorTujuanBaru = null;

  if (jenis === 'PINDAH SILO') {
    // Silo tujuan yang sudah punya anchor TIDAK ditimpa: susu lama di sana
    // sudah berdiri lebih dulu, dan menimpanya akan memuda-kan susu itu.
    if (anchorTujuan === null) {
      anchorTujuanBaru = transferPenuh
        // Seluruh isi berpindah wadah — susu yang sama, lama berdirinya
        // tidak berubah, jadi anchornya diwariskan.
        ? anchorAsal
        // Hanya sebagian yang berpindah. Silo asal masih berisi susu lama,
        // sehingga anchornya tidak boleh diwariskan; di wadah baru, susu
        // mulai berdiri sejak saat dipindahkan.
        : waktuTransfer;
    }
  }

  return { resetAnchorAsal, anchorTujuanBaru, transferPenuh };
}
