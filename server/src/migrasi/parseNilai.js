/**
 * Parsing nilai sumber - Fase 4, Bagian 11.2
 *
 * SATU ATURAN YANG MENGATUR SELURUH BERKAS INI:
 *
 *   Nilai yang tidak terbaca TIDAK PERNAH DITEBAK. Ia masuk laporan
 *   pengecualian dan barisnya ditolak.
 *
 * Alasannya bukan kehati-hatian umum. Data yang dimigrasikan adalah catatan
 * mutu: menebak satu jam penerimaan berarti menerbitkan form GMP dengan jam
 * yang tidak pernah terjadi, dan tidak akan ada yang tahu bedanya setelah
 * sistem lama dipensiunkan. Baris yang ditolak masih dapat diperbaiki manusia;
 * baris yang ditebak tidak dapat ditemukan lagi.
 */

/**
 * Format waktu SharePoint: `mm/dd/yyyy hh:mm` atau `mm/dd/yyyy`.
 *
 * Urutan bulan-hari, bukan hari-bulan. Itu terbaca dari flow export lama yang
 * membandingkan `substring(waktu, 0, 10)` dengan string berformat `MM/dd/yyyy`,
 * dan dari data: kolom pertama pada berkas contoh tidak pernah melewati 12.
 *
 * Ambiguitasnya nyata dan berbahaya - `06/08/2026` dapat berarti 6 Agustus
 * maupun 8 Juni - dan justru itulah B-16 yang membuat 11 dari 20 form Agustus
 * bertanggal salah. Karena itu formatnya DITETAPKAN, bukan dideteksi.
 */
const POLA_WAKTU = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i;

/** Format ISO, bila sumbernya sudah diekspor sebagai ISO. */
const POLA_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/i;

export class GagalParse extends Error {
  constructor(pesan, { kolom, nilai, jenis }) {
    super(pesan);
    this.name = 'GagalParse';
    this.kolom = kolom;
    this.nilai = nilai;
    this.jenis = jenis;
  }
}

const kosong = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Membentuk instant UTC dari jam dinding WIB tanpa bergantung pada TZ proses.
 * Import pertama pernah berjalan dengan TZ=UTC sehingga 23.16 WIB tersimpan
 * sebagai 23.16 UTC dan kemudian bergeser lagi saat ditampilkan.
 */
function dariKomponenWib(th, bl, hr, jm, mn, dt, kolom, nilai) {
  const tahun = Number(th);
  const bulan = Number(bl);
  const hari = Number(hr);
  const jam = Number(jm);
  const menit = Number(mn);
  const detik = Number(dt);
  const kalender = new Date(Date.UTC(tahun, bulan - 1, hari, jam, menit, detik));

  if (
    kalender.getUTCFullYear() !== tahun
    || kalender.getUTCMonth() !== bulan - 1
    || kalender.getUTCDate() !== hari
    || kalender.getUTCHours() !== jam
    || kalender.getUTCMinutes() !== menit
    || kalender.getUTCSeconds() !== detik
  ) {
    throw new GagalParse(
      `Tanggal "${nilai}" tidak ada pada kalender.`,
      { kolom, nilai, jenis: 'waktu' },
    );
  }

  return new Date(Date.UTC(tahun, bulan - 1, hari, jam - 7, menit, detik));
}

/**
 * Waktu setempat menjadi Date.
 *
 * Kolom DATETIME menyimpan UTC (A-4) dan driver yang mengubahnya, jadi di sini
 * cukup membangun Date pada zona SETEMPAT - itulah zona yang dipakai operator
 * saat mengetiknya.
 */
export function parseWaktu(nilai, kolom) {
  if (kosong(nilai)) return null;

  // Sumber berformat xlsx dapat memberi Date apa adanya
  if (nilai instanceof Date) {
    if (Number.isNaN(nilai.getTime())) {
      throw new GagalParse('Tanggal tidak sah', { kolom, nilai, jenis: 'waktu' });
    }
    return nilai;
  }

  const teks = String(nilai).trim();

  const iso = POLA_ISO.exec(teks);
  if (iso) {
    const [, th, bl, hr, jm = '0', mn = '0', dt = '0', zona] = iso;
    if (zona) {
      const eksplisit = new Date(teks.replace(' ', 'T'));
      if (!Number.isNaN(eksplisit.getTime())) return eksplisit;
    }
    return dariKomponenWib(th, bl, hr, jm, mn, dt, kolom, teks);
  }

  const m = POLA_WAKTU.exec(teks);
  if (!m) {
    throw new GagalParse(
      `Format waktu tidak dikenal: "${teks}". Diharapkan mm/dd/yyyy hh:mm atau ISO.`,
      { kolom, nilai: teks, jenis: 'waktu' },
    );
  }

  const [, bl, hr, th, jm = '0', mn = '0', dt = '0', ampm] = m;
  let jam = Number(jm);
  if (ampm) {
    const pm = ampm.toUpperCase() === 'PM';
    if (jam === 12) jam = pm ? 12 : 0;
    else if (pm) jam += 12;
  }

  const bulan = Number(bl);
  const hari = Number(hr);

  // Bulan di atas 12 berarti asumsi mm/dd salah untuk baris ini. Membalik
  // urutannya diam-diam akan membuat sebagian baris berformat lain dan
  // sebagian lagi tidak, dan campuran itu tidak dapat dideteksi kemudian.
  if (bulan < 1 || bulan > 12 || hari < 1 || hari > 31) {
    throw new GagalParse(
      `Tanggal "${teks}" tidak masuk akal sebagai mm/dd/yyyy. Perlu ditinjau manusia.`,
      { kolom, nilai: teks, jenis: 'waktu' },
    );
  }

  return dariKomponenWib(th, bl, hr, jam, mn, dt, kolom, teks);
}

/**
 * Bentuk angka yang dikenali, DIURUTKAN dari yang paling tegas.
 *
 * Koma dan titik sama-sama dapat berarti desimal maupun pemisah ribuan, dan
 * salah membacanya tidak menimbulkan galat - ia hanya menghasilkan angka yang
 * salah. Pada data sungguhan, `qty_kg` "9,949" berarti 9.949 kg; membacanya
 * sebagai 9,949 kg akan memusnahkan hampir sepuluh ribu liter tanpa jejak.
 *
 * Karena itu yang dikenali hanya bentuk yang TIDAK AMBIGU, dan sisanya
 * ditolak ke laporan alih-alih ditebak.
 */
const BENTUK_ANGKA = [
  // 1234 atau -12
  { pola: /^-?\d+$/, ubah: (t) => t },
  // 1,234,567.89 dan 1,234 - koma pemisah ribuan (kelompok tiga digit)
  { pola: /^-?\d{1,3}(,\d{3})+(\.\d+)?$/, ubah: (t) => t.replaceAll(',', '') },
  /*
   * 1.234.567,89 - titik pemisah ribuan, koma desimal.
   *
   * Menuntut DUA kelompok atau lebih, dan itu bukan kehati-hatian berlebih.
   * Dengan satu kelompok, "1.026" sama sahnya dibaca 1026 (titik ribuan)
   * maupun 1,026 (titik desimal) - dan pada data ini ia adalah berat jenis
   * 1,026. Membacanya 1026 akan membuat konversi kg ke liter menghasilkan
   * angka yang seribu kali terlalu kecil.
   */
  { pola: /^-?\d{1,3}(\.\d{3}){2,}(,\d+)?$/, ubah: (t) => t.replaceAll('.', '').replace(',', '.') },
  // 1.026 atau 12.54 - titik desimal
  { pola: /^-?\d+\.\d+$/, ubah: (t) => t },
];

/**
 * Bentuk yang AMBIGU: koma diikuti satu atau dua digit, mis. "1,5".
 *
 * Dapat berarti 1,5 (koma desimal) maupun angka yang pemisah ribuannya tidak
 * lengkap. Tidak ada cara memutuskannya dari nilainya sendiri, jadi ia ditolak
 * dan orang yang mengenal datanya yang memutuskan.
 */
const AMBIGU = /^-?\d+,\d{1,2}$/;


/**
 * BATAS MASUK AKAL PER KOLOM - penjaga terakhir sebelum angka masuk basis data.
 *
 * Aturan bentuk di atas hanya dapat menolak yang tidak dapat dibaca. Ia tidak
 * dapat menolak yang terbaca dengan sempurna tetapi salah, dan justru itulah
 * yang ada di export sungguhan:
 *
 *   qty_kg  "20.403"   terbaca 20,403 kg  seharusnya 20403 kg   (6 baris)
 *   vol_ltr "12.007"   terbaca 12,007 L   seharusnya 12007 L    (4 baris)
 *   berat_jenis "10.26" terbaca 10,26     seharusnya 1,026      (1 baris)
 *   ph_check "670"     terbaca 670        seharusnya 6,70      (14 baris)
 *   temp_after_heater "853.00" terbaca 853 seharusnya 85,3      (4 baris)
 *   nilai_ts "1279"    terbaca 1279       seharusnya 12,79      (5 baris)
 *
 * Titik pada "20.403" dan pada "1.027" adalah karakter yang SAMA pada kolom
 * yang bentuknya SAMA; tidak ada aturan format yang dapat memisahkannya. Yang
 * dapat memisahkannya hanya kenyataan fisik: susu tidak pernah diterima 20 kg,
 * berat jenisnya tidak pernah 10, dan pH-nya tidak pernah 670.
 *
 * Yang di luar batas DITOLAK, bukan dibagi seratus. Membaginya berarti
 * menerbitkan catatan mutu berisi angka yang tidak pernah diukur siapa pun -
 * dan pada temp_after_heater, angka itulah yang menentukan apakah OPRP 81 C
 * terpenuhi.
 *
 * "bulat" untuk kolom yang alat ukurnya memang tidak pernah menghasilkan
 * pecahan: timbangan melaporkan kg utuh, flow meter melaporkan liter utuh.
 * Nilai berkoma pada kolom itu, tanpa kecuali, adalah pemisah yang salah baca.
 */
const BATAS_MASUK_AKAL = {
  /*
   * qty_kg dibatasi dari BAWAH, bukan dituntut bulat.
   *
   * Timbangan boleh saja melaporkan setengah kilogram, jadi menuntutnya
   * bulat akan menolak baris yang sah. Yang mustahil bukan pecahannya,
   * melainkan besarannya: susu tidak pernah diterima 20 kg. Batas bawah
   * itulah yang menangkap "20.403" tanpa ikut menolak "20,296.50".
   */
  qty_kg: { min: 50, maks: 60000, satuan: 'kg' },
  berat_jenis: { min: 1, maks: 1.1, satuan: '' },
  nilai_ts: { min: 0, maks: 100, satuan: '%' },
  qty_remaining_ltr: { min: 0, maks: 200000, bulat: true, satuan: 'L' },
  vol_prepast_ltr: { min: 0, maks: 200000, bulat: true, satuan: 'L' },
  vol_ltr: { min: 0, maks: 200000, bulat: true, satuan: 'L' },
  vol_akt_silo_ltr: { min: 0, maks: 200000, bulat: true, satuan: 'L' },
  val_aktual_snapshot_ltr: { min: 0, maks: 200000, bulat: true, satuan: 'L' },
  jumlah_awal_ltr: { min: 0, maks: 200000, bulat: true, satuan: 'L' },
  flowrate_pst: { min: 0, maks: 100, satuan: '' },
  temp_after_heater: { min: 0, maks: 150, satuan: 'C' },
  temp_output_prd: { min: 0, maks: 150, satuan: 'C' },
  temp_check: { min: -5, maks: 60, satuan: 'C' },
  ph_check: { min: 3, maks: 9, satuan: '' },
};

/** Menguji satu angka terhadap batas kolomnya. Melempar bila di luar batas. */
export function periksaBatas(n, kolom) {
  const b = BATAS_MASUK_AKAL[kolom];
  if (!b) return n;

  if (b.bulat && !Number.isInteger(n)) {
    throw new GagalParse(
      `${kolom} = ${n} berkoma, padahal kolom ini selalu bilangan bulat. `
      + 'Hampir pasti pemisah ribuan terbaca sebagai koma desimal. Perbaiki di '
      + 'sumber, jangan ditebak di sini.',
      { kolom, nilai: n, jenis: 'angka' },
    );
  }

  if (n < b.min || n > b.maks) {
    throw new GagalParse(
      `${kolom} = ${n}${b.satuan} di luar batas masuk akal `
      + `(${b.min}${b.satuan} sampai ${b.maks}${b.satuan}). Perlu ditinjau manusia.`,
      { kolom, nilai: n, jenis: 'angka' },
    );
  }

  return n;
}

export function parseAngka(nilai, kolom) {
  if (kosong(nilai)) return null;

  if (typeof nilai === 'number') {
    if (!Number.isFinite(nilai)) {
      throw new GagalParse('Angka tidak berhingga', { kolom, nilai, jenis: 'angka' });
    }
    return periksaBatas(nilai, kolom);
  }

  const teks = String(nilai).trim().replace(/\s/g, '');

  if (AMBIGU.test(teks)) {
    throw new GagalParse(
      `Angka "${teks}" ambigu: koma dapat berarti desimal maupun pemisah ribuan. `
      + 'Ekspor ulang dengan format angka yang tegas.',
      { kolom, nilai: teks, jenis: 'angka' },
    );
  }

  const bentuk = BENTUK_ANGKA.find((b) => b.pola.test(teks));
  if (!bentuk) {
    // Termasuk nilai galat Excel seperti #NUM! dan #VALUE!
    throw new GagalParse(`Bukan angka: "${teks}"`, { kolom, nilai: teks, jenis: 'angka' });
  }

  const n = Number(bentuk.ubah(teks));
  if (!Number.isFinite(n)) {
    throw new GagalParse(`Bukan angka: "${teks}"`, { kolom, nilai: teks, jenis: 'angka' });
  }
  return periksaBatas(n, kolom);
}

export function parseTeks(nilai) {
  if (kosong(nilai)) return null;
  return String(nilai).trim();
}

export function parseBoolean(nilai) {
  if (kosong(nilai)) return null;
  const t = String(nilai).trim().toLowerCase();
  if (['true', '1', 'ya', 'yes'].includes(t)) return true;
  if (['false', '0', 'tidak', 'no'].includes(t)) return false;
  return null;
}

/**
 * `supplier_fifo` adalah JSON yang ditulis Power Apps sebagai teks - F4-4.
 *
 * Elemennya menjadi baris `transfer_allocation`, dan inilah transformasi paling
 * kritis di seluruh migrasi: tanpanya, penelusuran "susu ini dari supplier
 * mana" hilang untuk seluruh riwayat.
 */
export function parseFifo(nilai, kolom) {
  if (kosong(nilai)) return [];

  if (Array.isArray(nilai)) return nilai;

  const teks = String(nilai).trim();
  let urai;
  try {
    urai = JSON.parse(teks);
  } catch {
    throw new GagalParse(
      `supplier_fifo bukan JSON yang sah: "${teks.slice(0, 80)}"`,
      { kolom, nilai: teks.slice(0, 200), jenis: 'json' },
    );
  }

  if (!Array.isArray(urai)) {
    throw new GagalParse('supplier_fifo bukan array', { kolom, nilai: teks.slice(0, 200), jenis: 'json' });
  }
  return urai;
}

/** Parse satu nilai menurut jenis kolomnya. */
export function parseMenurutJenis(jenis, nilai, kolom) {
  switch (jenis) {
    case 'waktu':
    case 'tanggal':
      return parseWaktu(nilai, kolom);
    case 'angka':
      return parseAngka(nilai, kolom);
    case 'boolean':
      return parseBoolean(nilai);
    case 'json':
      return parseFifo(nilai, kolom);
    default:
      return parseTeks(nilai);
  }
}
