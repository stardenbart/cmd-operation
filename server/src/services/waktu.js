/**
 * Logika waktu — BR-09, BR-11
 *
 * FUNGSI MURNI. Tidak memanggil jam sistem — waktu selalu diterima sebagai
 * argumen, supaya perilakunya dapat diuji tanpa bergantung pada saat
 * pengujian dijalankan.
 */

const SEMENIT = 60_000;
const SEJAM = 60;
const SEHARI = 1440;

function pastikanTanggal(nilai, nama) {
  if (!(nilai instanceof Date) || Number.isNaN(nilai.getTime())) {
    throw new TypeError(`${nama} harus berupa tanggal yang sah, diterima: ${nilai}`);
  }
}

/**
 * Mendeteksi kebutuhan rollover tengah malam — BR-11.
 *
 * Kasusnya nyata: prepast mulai 23:30 dan selesai 01:15, tetapi operator
 * mengisi tanggal yang sama karena masih dalam shift yang sama.
 *
 * Fungsi ini hanya MENDETEKSI dan MENYARANKAN — tidak menerapkan.
 * Power Apps menggeser tanggal secara diam-diam; di sini penggeseran menuntut
 * konfirmasi eksplisit (FR-13.2), karena menggeser tanggal transaksi tanpa
 * sepengetahuan operator adalah cara yang baik untuk membuat catatan mutu
 * bertanggal salah tanpa ada yang menyadarinya.
 *
 * @param {Date} mulai
 * @param {Date} selesai
 * @returns {{perluRollover: boolean, saranSelesai: Date|null, alasan: string|null}}
 */
export function deteksiRollover(mulai, selesai) {
  pastikanTanggal(mulai, 'Waktu mulai');
  pastikanTanggal(selesai, 'Waktu selesai');

  if (selesai.getTime() > mulai.getTime()) {
    return { perluRollover: false, saranSelesai: null, alasan: null };
  }

  const selisihJam = (mulai.getTime() - selesai.getTime()) / (SEMENIT * SEJAM);

  // Lebih dari 24 jam ke belakang bukan kasus tengah malam — itu salah input,
  // dan menambah satu hari tidak akan memperbaikinya.
  if (selisihJam > 24) {
    return {
      perluRollover: false,
      saranSelesai: null,
      alasan: 'selisih terlalu jauh untuk rollover tengah malam',
    };
  }

  const saran = new Date(selesai.getTime() + SEHARI * SEMENIT);
  return { perluRollover: true, saranSelesai: saran, alasan: null };
}

/**
 * Selisih dua waktu dalam menit penuh.
 * @returns {number|null} null bila salah satu kosong
 */
export function selisihMenit(dari, sampai) {
  if (!dari || !sampai) return null;
  pastikanTanggal(dari, 'Waktu awal');
  pastikanTanggal(sampai, 'Waktu akhir');
  return Math.floor((sampai.getTime() - dari.getTime()) / SEMENIT);
}

/**
 * Standing time terformat — BR-09.
 *
 *   >= 1 hari : "2h 3j 15m"
 *   >= 1 jam  : "3j 15m"
 *   lainnya   : "15 menit"
 *
 * Anchor kosong maupun nilai negatif ditampilkan "-". Negatif berarti jam
 * server melenceng atau waktu transfer diisi sebelum anchor; menampilkan
 * "-45 menit" lebih menyesatkan daripada mengakui nilainya tidak diketahui.
 */
export function formatStandingTime(menit) {
  if (menit === null || menit === undefined || Number.isNaN(menit) || menit < 0) {
    return '-';
  }

  const total = Math.floor(menit);

  if (total >= SEHARI) {
    const hari = Math.floor(total / SEHARI);
    const jam = Math.floor((total % SEHARI) / SEJAM);
    return `${hari}h ${jam}j ${total % SEJAM}m`;
  }

  if (total >= SEJAM) {
    return `${Math.floor(total / SEJAM)}j ${total % SEJAM}m`;
  }

  return `${total} menit`;
}

/** Tanggal saja, sebagaimana dikirim `<input type="date">`. */
const POLA_TANGGAL = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Batas rentang tanggal untuk filter riwayat - FR-11.3, memperbaiki B-7.
 *
 * Dua kekeliruan yang tampak sepele tetapi membuat filter berbohong, dan
 * keduanya pernah nyata di sistem ini:
 *
 * 1. `new Date('2026-08-25')` di JavaScript berarti tengah malam **UTC**,
 *    bukan tengah malam di Jakarta. Waktu transaksi disimpan sebagai DATETIME
 *    tanpa zona, jadi batasnya bergeser tujuh jam: record pukul 03.00 pada
 *    tanggal itu ikut terbuang oleh batas bawah.
 * 2. Batas atas dari tanggal saja berarti AWAL hari, bukan akhirnya. Filter
 *    "25 Agustus sampai 25 Agustus" karena itu mengembalikan nol baris
 *    padahal ada enam. Filter yang mengembalikan nol tidak terlihat rusak,
 *    ia terlihat seperti tidak ada data, dan itulah bahayanya.
 *
 * Karena itu tanggal saja ditafsirkan sebagai HARI SETEMPAT: batas bawah
 * jatuh di 00.00.00.000 dan batas atas di 23.59.59.999. Nilai yang sudah
 * memuat jam dibiarkan apa adanya, sebab pemanggilnya jelas memaksudkan
 * saat tertentu.
 *
 * @param {string|Date} nilai
 * @param {'mulai'|'akhir'} sisi
 * @returns {Date}
 */
export function batasTanggal(nilai, sisi) {
  if (sisi !== 'mulai' && sisi !== 'akhir') {
    throw new TypeError(`Sisi batas harus 'mulai' atau 'akhir', diterima: ${sisi}`);
  }

  if (typeof nilai === 'string') {
    const cocok = POLA_TANGGAL.exec(nilai.trim());
    if (cocok) {
      const [, tahun, bulan, hari] = cocok.map(Number);
      return sisi === 'mulai'
        ? new Date(tahun, bulan - 1, hari, 0, 0, 0, 0)
        : new Date(tahun, bulan - 1, hari, 23, 59, 59, 999);
    }
  }

  const tanggal = nilai instanceof Date ? nilai : new Date(nilai);
  pastikanTanggal(tanggal, 'Batas tanggal');
  return tanggal;
}

/**
 * Menormalkan parameter waktu URL menjadi ISO UTC. Nilai tanpa offset berasal
 * dari datetime-local dan dimaknai sebagai WIB. Spasi sebelum offset juga
 * diterima karena tanda plus dapat berubah menjadi spasi pada query manual.
 */
export function normalisasiWaktuFilter(nilai) {
  if (nilai instanceof Date) {
    pastikanTanggal(nilai, 'Waktu filter');
    return nilai.toISOString();
  }
  if (typeof nilai !== 'string' || !nilai.trim()) {
    throw new TypeError('Waktu filter harus diisi');
  }

  let teks = nilai.trim().replace(/ (\d{2}:\d{2})$/, '+$1');
  const lokal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(teks);
  if (lokal) {
    if (/T\d{2}:\d{2}$/.test(teks)) teks += ':00';
    teks += '+07:00';
  }
  const tanggal = new Date(teks);
  pastikanTanggal(tanggal, 'Waktu filter');
  return tanggal.toISOString();
}

/**
 * Offset zona waktu setempat dalam bentuk yang dimengerti MySQL, mis. '+07:00'.
 *
 * Kolom DATETIME menyimpan UTC (A-4), sementara pengelompokan "per hari" pada
 * dashboard berarti hari SETEMPAT: shift malam yang berjalan melewati tengah
 * malam UTC tetap satu hari kerja bagi yang menjalankannya.
 *
 * Offsetnya dibaca dari jam sistem, bukan ditulis tetap, supaya sistem yang
 * dipasang di zona lain tidak diam-diam salah mengelompokkan. Jakarta tidak
 * mengenal daylight saving, jadi offsetnya tetap sepanjang tahun; di zona yang
 * mengenalnya, pengelompokan hari di sekitar pergantian DST akan bergeser satu
 * jam dan itu perlu ditangani tersendiri bila kelak relevan.
 */
export function offsetLokalMysql(saat = new Date()) {
  const menit = -saat.getTimezoneOffset();
  const tanda = menit >= 0 ? '+' : '-';
  const abs = Math.abs(menit);
  const jam = String(Math.floor(abs / 60)).padStart(2, '0');
  const sisa = String(abs % 60).padStart(2, '0');
  return `${tanda}${jam}:${sisa}`;
}
