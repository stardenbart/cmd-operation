/**
 * Validasi pecahan multi-silo — FR-29, BR-06
 *
 * FUNGSI MURNI. Memeriksa satu kali input prepast yang menuju beberapa silo.
 *
 * Aritmetika dilakukan dalam bilangan bulat perseratus liter, alasan yang
 * sama seperti pada allocateFifo: 0.1 + 0.2 tidak sama dengan 0.3 dalam
 * desimal biner, dan kesalahan sekecil itu menumpuk menjadi liter yang
 * tercipta dari ketiadaan.
 */

/**
 * Error validasi yang membawa KODE ATURAN.
 *
 * Kode harus menunjuk aturan yang benar-benar dilanggar. Melaporkan
 * "silo tidak ditemukan" sebagai BR-06 menyesatkan pembaca log maupun
 * pengguna — BR-06 adalah soal volume melebihi batch induk, bukan soal
 * silo yang tidak dikenal.
 */
class PecahanError extends TypeError {
  constructor(kode, message, detail = null) {
    super(message);
    this.name = 'PecahanError';
    this.kode = kode;
    this.detail = detail;
  }
}

const SKALA = 100;
const keSkala = (l) => Math.round(l * SKALA);
const dariSkala = (u) => u / SKALA;

/**
 * @typedef {object} Pecahan
 * @property {number} siloId
 * @property {number} volumeLtr
 *
 * @param {Pecahan[]} pecahan
 * @param {number} sisaBatchLtr        sisa volume batch induk (BR-06)
 * @param {Map<number, number>} kapasitasTersisa  siloId → liter tersedia
 * @returns {{totalLtr: number, sisaTakTeralokasi: number, pecahan: Pecahan[]}}
 */
export { PecahanError };

export function validasiPecahan(
  pecahan,
  sisaBatchLtr,
  kapasitasTersisa,
  sisaBatasKeras = null,
) {
  if (!Array.isArray(pecahan) || pecahan.length === 0) {
    throw new PecahanError('FR-29.1', 'Isi minimal satu silo tujuan');
  }

  const sisaBatch = keSkala(sisaBatchLtr ?? 0);
  if (sisaBatch <= 0) {
    throw new PecahanError(
      'BR-06',
      'Batch induk sudah habis — tidak ada sisa yang dapat diprepast',
    );
  }

  // FR-29.5 — silo tidak boleh berulang.
  // Di UI, silo yang sudah dipilih dihilangkan dari baris berikutnya sehingga
  // keadaan ini mustahil; pemeriksaan di sini menutup jalur API langsung.
  const terlihat = new Set();
  for (const p of pecahan) {
    if (terlihat.has(p.siloId)) {
      throw new PecahanError(
        'FR-29.5',
        `Silo yang sama tidak boleh diisi lebih dari satu kali (silo id ${p.siloId})`,
        { siloId: p.siloId },
      );
    }
    terlihat.add(p.siloId);
  }

  let total = 0;
  const melampauiNominal = [];

  for (const p of pecahan) {
    const volume = keSkala(p.volumeLtr ?? 0);

    if (volume <= 0) {
      throw new PecahanError(
        'FR-29.1',
        `Volume untuk silo id ${p.siloId} harus lebih besar dari nol`,
        { siloId: p.siloId },
      );
    }

    if (!kapasitasTersisa.has(p.siloId)) {
      throw new PecahanError(
        'SILO_NOT_FOUND',
        `Silo id ${p.siloId} tidak ditemukan atau tidak tersedia sebagai tujuan prepast`,
        { siloId: p.siloId },
      );
    }

    // FR-29.7 — tiap baris dibatasi kapasitas silo tujuannya masing-masing.
    //
    // BR-24: batas KERAS adalah kapasitas nominal ditambah toleransi. Volume
    // di antara keduanya diterima tetapi ditandai, sehingga kelebihan yang
    // sah tetap terlihat di dashboard alih-alih lewat tanpa jejak.
    const sisaNominal = keSkala(kapasitasTersisa.get(p.siloId));

    // Batas keras dibaca LANGSUNG, tidak dijumlahkan dari sisa nominal.
    //
    // Menjumlahkan sisaNominal + toleransi keliru karena sisaNominal
    // di-clamp ke 0 oleh GREATEST() di VIEW: silo yang sudah melampaui
    // nominal akan tampak masih memiliki toleransi penuh, sehingga
    // toleransinya terhitung dua kali dan silo dapat terisi jauh melewati
    // batas fisiknya.
    const batasKeras = sisaBatasKeras?.has(p.siloId)
      ? keSkala(sisaBatasKeras.get(p.siloId))
      : sisaNominal;

    if (volume > batasKeras) {
      throw new PecahanError(
        'FR-29.7',
        `Volume ${p.volumeLtr} L melebihi kapasitas silo id ${p.siloId} ` +
          `(sisa nominal ${dariSkala(sisaNominal)} L, batas keras ` +
          `${dariSkala(batasKeras)} L)`,
        {
          siloId: p.siloId,
          sisaNominalLtr: dariSkala(sisaNominal),
          batasKerasLtr: dariSkala(batasKeras),
        },
      );
    }

    if (volume > sisaNominal) {
      melampauiNominal.push({
        siloId: p.siloId,
        volumeLtr: p.volumeLtr,
        sisaNominalLtr: dariSkala(sisaNominal),
        kelebihanLtr: dariSkala(volume - sisaNominal),
      });
    }

    total += volume;
  }

  // BR-06 — total tidak boleh melebihi sisa batch induk
  if (total > sisaBatch) {
    throw new PecahanError(
      'BR-06',
      `Total ${dariSkala(total)} L melebihi sisa batch induk ${dariSkala(sisaBatch)} L`,
      { totalLtr: dariSkala(total), sisaBatchLtr: dariSkala(sisaBatch) },
    );
  }

  return {
    totalLtr: dariSkala(total),
    sisaTakTeralokasi: dariSkala(sisaBatch - total),
    pecahan: pecahan.map((p) => ({ siloId: p.siloId, volumeLtr: p.volumeLtr })),
    // Baris yang isinya melampaui kapasitas nominal namun masih di dalam
    // toleransi (BR-24). Kosong berarti seluruhnya di dalam nominal.
    melampauiNominal,
  };
}
