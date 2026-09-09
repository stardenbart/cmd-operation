/**
 * Perbaikan nilai historis - Fase 4
 *
 * BERKAS INI ADALAH PENGECUALIAN TERHADAP ATURAN "TIDAK PERNAH MENEBAK".
 *
 * Aturan itu tetap berlaku di `parseNilai.js`: yang tidak terbaca ditolak.
 * Di sini, nilai yang SUDAH ditolak diberi satu kesempatan diperbaiki - dan
 * hanya bila perbaikannya dapat DITURUNKAN dari data yang selama ini dikelola,
 * bukan dikarang.
 *
 * TIGA SYARAT YANG MENGIKAT SETIAP PERBAIKAN DI SINI:
 *
 *  1. TUNGGAL.   Bila ada dua kemungkinan yang sama masuk akalnya, nilainya
 *                tetap ditolak. Perbaikan yang harus memilih di antara dua
 *                kandidat adalah tebakan yang menyamar.
 *
 *  2. TURUNAN.   Batas kewajaran tiap kolom dihitung dari sebaran nilai
 *                BERSIH di export yang sama, bukan dari angka yang diketik
 *                seseorang di berkas ini. Kalau prosesnya berubah, batasnya
 *                ikut berubah dengan sendirinya.
 *
 *  3. TERCATAT.  Tiap perbaikan masuk laporan pengecualian berikut nilai
 *                ASALNYA, dan menempel di kolom `remarks` barisnya. Catatan
 *                mutu yang diperbaiki harus dapat dikenali sebagai catatan
 *                yang diperbaiki, selamanya (ALCOA+ - original & attributable).
 */

import { GagalParse, parseAngka } from './parseNilai.js';

/* ------------------------------------------------------------------ */
/* Profil sebaran - syarat nomor 2                                     */
/* ------------------------------------------------------------------ */

/**
 * Kolom yang alat ukurnya melaporkan bilangan bulat.
 *
 * Timbangan dan flow meter tidak menghasilkan pecahan liter. Nilai berkoma
 * pada kolom ini, tanpa kecuali, adalah pemisah ribuan yang salah baca.
 */
const KOLOM_BULAT = new Set([
  'qty_kg', 'qty_remaining_ltr', 'vol_prepast_ltr', 'vol_ltr',
  'vol_akt_silo_ltr', 'val_aktual_snapshot_ltr', 'jumlah_awal_ltr',
]);

/** Persentil, dari deret yang sudah terurut. */
function persentil(urut, p) {
  if (urut.length === 0) return null;
  return urut[Math.min(urut.length - 1, Math.floor(p * urut.length))];
}

/**
 * Membangun batas kewajaran tiap kolom dari nilai BERSIHNYA sendiri.
 *
 * Yang dipakai hanya nilai yang lolos `parseAngka` - artinya sudah lolos batas
 * fisik kolomnya. Nol dibuang karena banyak kolom memakai nol sebagai "tidak
 * diisi", dan nol menarik batas bawah sampai ke titik yang membuat setiap
 * kandidat perbaikan terlihat masuk akal.
 *
 * Batasnya dilebarkan 20 persen ke bawah dan 25 persen ke atas: p1 dan p99
 * menggambarkan operasi normal, sedangkan yang diperiksa di sini adalah
 * kejadian yang memang tidak normal.
 */
export function bangunProfil(sumber) {
  const kumpul = new Map();

  for (const isi of Object.values(sumber)) {
    if (!isi?.data) continue;
    for (const baris of isi.data) {
      for (const [kolom, mentah] of Object.entries(baris)) {
        if (kolom.startsWith('_')) continue;
        let n;
        try {
          n = parseAngka(mentah, kolom);
        } catch {
          continue;
        }
        if (n === null || n === 0) continue;
        if (!kumpul.has(kolom)) kumpul.set(kolom, []);
        kumpul.get(kolom).push(n);
      }
    }
  }

  const profil = {};
  for (const [kolom, nilai] of kumpul) {
    if (nilai.length < 20) continue;
    nilai.sort((a, b) => a - b);
    profil[kolom] = {
      bawah: persentil(nilai, 0.01) * 0.8,
      atas: persentil(nilai, 0.99) * 1.25,
      jumlah: nilai.length,
    };
  }
  return profil;
}

/* ------------------------------------------------------------------ */
/* Angka                                                               */
/* ------------------------------------------------------------------ */

/** Titik sebagai pemisah ribuan: tepat tiga digit di belakangnya. */
const TITIK_RIBUAN = /^(-?\d{1,3})\.(\d{3})$/;

/**
 * Memperbaiki satu angka yang sudah ditolak `parseAngka`.
 *
 * Dua bentuk kerusakan, dan keduanya ditangani dengan cara yang berbeda karena
 * buktinya memang berbeda:
 *
 *   "20.403" pada qty_kg   Buktinya BENTUK. Kolomnya berisi bilangan bulat,
 *                          dan titik dengan tepat tiga digit di belakangnya
 *                          adalah pemisah ribuan. Tidak ada kandidat lain.
 *
 *   "670" pada ph_check    Buktinya SEBARAN. Bentuknya sah sempurna; yang
 *                          salah besarannya. Yang dicari adalah satu-satunya
 *                          pangkat sepuluh yang mendaratkannya di sebaran
 *                          kolomnya sendiri.
 *
 * @returns {{nilai: number, cara: string}|null} null bila tidak dapat dipastikan
 */
export function perbaikiAngka(mentah, kolom, profil) {
  const teks = String(mentah ?? '').trim().replace(/\s/g, '');
  if (teks === '') return null;

  const batas = profil?.[kolom];

  // Bentuk: titik pemisah ribuan pada kolom yang selalu bulat
  const m = TITIK_RIBUAN.exec(teks);
  if (m && KOLOM_BULAT.has(kolom)) {
    const n = Number(m[1] + m[2]);
    if (Number.isFinite(n) && (!batas || (n >= batas.bawah && n <= batas.atas))) {
      return { nilai: n, cara: `titik dibaca sebagai pemisah ribuan (${teks} -> ${n})` };
    }
  }

  // Sebaran: satu-satunya pangkat sepuluh yang mendarat di sebaran kolomnya
  if (!batas) return null;

  const dasar = Number(teks.replaceAll(',', ''));
  if (!Number.isFinite(dasar) || dasar === 0) return null;

  const cocok = [];
  for (const pangkat of [-1, -2, -3, 1, 2, 3]) {
    const n = dasar * 10 ** pangkat;
    if (n >= batas.bawah && n <= batas.atas) cocok.push({ n, pangkat });
  }

  // Syarat nomor 1: dua kandidat berarti tebakan, bukan perbaikan.
  if (cocok.length !== 1) return null;

  const { n, pangkat } = cocok[0];
  const arah = pangkat < 0 ? 'dibagi' : 'dikali';
  // Pembagian biner meninggalkan ekor (1279/100 = 12.790000000000001). Ekor itu
  // ikut tercetak di laporan dan membuat perbaikan yang benar terlihat serampangan.
  const rapi = Number(n.toPrecision(12));
  return {
    nilai: rapi,
    cara: `titik desimal dikembalikan: ${teks} ${arah} ${10 ** Math.abs(pangkat)} -> ${rapi}`,
  };
}

/* ------------------------------------------------------------------ */
/* Waktu                                                               */
/* ------------------------------------------------------------------ */

const POLA_MENIT_TERPOTONG = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d)$/;
const POLA_JAM_LEWAT = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})$/;
const POLA_TANPA_JAM = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+:?\s*)?$/;

/**
 * Memperbaiki satu waktu yang sudah ditolak `parseWaktu`.
 *
 * Tiga bentuk kerusakan yang ada di export sungguhan:
 *
 *   "07/18/2026 16:5"    Digit terakhir menitnya hilang. Yang dikembalikan
 *                        adalah menit bulat (16:50), sebab menit itulah yang
 *                        paling sering diketik - dan setiap kandidat lain
 *                        berselisih paling banyak sembilan menit, selisih yang
 *                        tidak dapat mengubah penilaian mutu apa pun.
 *
 *   "07/10/2026 29:46"   Jam 29 adalah jam HARI KERJA, bukan jam kalender:
 *                        pabrik ini bekerja melewati tengah malam dan sistem
 *                        lama meneruskan hitungan jamnya. 29:46 berarti 05:46
 *                        keesokan harinya. Ini pola yang sama dengan aturan
 *                        jangkar hari pada form GMP.
 *
 *   "06/23/2026 :"       Jamnya tidak pernah tercatat. Yang dipertahankan
 *                        TANGGALNYA - itulah yang menentukan baris ini masuk
 *                        form hari yang mana - dan jamnya menjadi 00:00 dengan
 *                        keterangan tegas bahwa jamnya tidak diketahui.
 *
 * @returns {{nilai: Date, cara: string}|null}
 */
export function perbaikiWaktu(mentah, kolom) {
  const teks = String(mentah ?? '').trim();
  if (teks === '') return null;

  const potong = POLA_MENIT_TERPOTONG.exec(teks);
  if (potong) {
    const [, bl, hr, th, jm, mn] = potong;
    const menit = Number(mn) * 10;
    if (Number(jm) > 23 || menit > 59) return null;
    return {
      nilai: new Date(+th, +bl - 1, +hr, +jm, menit),
      cara: `menit terpotong dilengkapi ke menit bulat (${teks} -> ${jm}:${String(menit).padStart(2, '0')})`,
    };
  }

  const lewat = POLA_JAM_LEWAT.exec(teks);
  if (lewat) {
    const [, bl, hr, th, jm, mn] = lewat;
    const jam = Number(jm);
    if (jam >= 24 && jam <= 47) {
      // Date menggulirkan tanggalnya sendiri saat jamnya melewati 24.
      const d = new Date(+th, +bl - 1, +hr, jam, +mn);
      return {
        nilai: d,
        cara: `jam hari kerja ${jam}:${mn} dibaca ${String(jam - 24).padStart(2, '0')}:${mn} keesokan harinya`,
      };
    }
    return null;
  }

  const tanpaJam = POLA_TANPA_JAM.exec(teks);
  if (tanpaJam) {
    const [, bl, hr, th] = tanpaJam;
    const bulan = Number(bl);
    const hari = Number(hr);
    if (bulan < 1 || bulan > 12 || hari < 1 || hari > 31) return null;
    const d = new Date(+th, bulan - 1, hari, 0, 0);
    if (d.getMonth() !== bulan - 1 || d.getDate() !== hari) return null;
    return {
      nilai: d,
      cara: `jam tidak tercatat di sistem lama; tanggal ${bl}/${hr}/${th} dipertahankan, jam menjadi 00:00`,
      jamTidakDiketahui: true,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Batch                                                               */
/* ------------------------------------------------------------------ */

/**
 * Prefiks yang dipakai per tanggal, diturunkan dari transfer lain hari itu.
 *
 * `CMD2` tidak ikut dihitung: ia batch utuh untuk transfer ke tank CMD 2,
 * bukan prefiks bernomor, sehingga kehadirannya tidak menunjukkan apa pun
 * tentang nomor batch produksi hari itu.
 */
export function bangunPrefiksHarian(barisTransfer) {
  const perHari = new Map();

  for (const b of barisTransfer) {
    const waktu = kunciHari(b.trf_time);
    const batch = String(b.batch ?? '').trim();
    if (!waktu || !batch) continue;

    const m = /^(\d+)?([A-Za-z]+)(\d+)?$/.exec(batch);
    if (!m) continue;
    const prefiks = m[2].toUpperCase();
    if (prefiks === 'CMD') continue;

    if (!perHari.has(waktu)) perHari.set(waktu, new Set());
    perHari.get(waktu).add(prefiks);
  }

  return perHari;
}

/**
 * Kunci tanggal yang sama untuk teks sumber maupun Date hasil parse.
 *
 * Prefiks dikumpulkan dari teks mentah (`06/27/2026 15:00`) tetapi dicari
 * kembali saat barisnya sudah menjadi Date. Tanpa kunci yang sama, pencarian
 * selalu meleset dan tidak ada satu pun batch yang diperbaiki - diam-diam.
 */
export function kunciHari(nilai) {
  if (nilai instanceof Date && !Number.isNaN(nilai.getTime())) {
    const b = String(nilai.getMonth() + 1).padStart(2, '0');
    const h = String(nilai.getDate()).padStart(2, '0');
    return `${nilai.getFullYear()}-${b}-${h}`;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(nilai ?? '').trim());
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Angka polos satu sampai dua digit - nomor batch tanpa prefiksnya. */
const NOMOR_POLOS = /^\d{1,2}$/;

/**
 * Memperbaiki batch yang tertulis sebagai angka polos.
 *
 * `"6"` pada 27 Juni berarti `HRC6`, sebab seluruh transfer bernomor hari itu
 * memakai prefiks HRC dan tidak ada prefiks lain yang bersaing. Bila hari itu
 * memakai dua prefiks, nomornya dapat menjadi milik keduanya dan batchnya
 * tetap tidak dipetakan.
 *
 * Angka empat digit seperti `"5000"` TIDAK diperbaiki: itu bukan nomor batch
 * yang kehilangan prefiks, melainkan volume yang salah kolom.
 */
export function perbaikiBatch(mentah, tanggalTeks, prefiksHarian) {
  const teks = String(mentah ?? '').trim();
  if (!NOMOR_POLOS.test(teks)) return null;

  const prefiks = prefiksHarian?.get(kunciHari(tanggalTeks));
  if (!prefiks || prefiks.size !== 1) return null;

  const p = [...prefiks][0];
  return {
    nilai: `${p}${Number(teks)}`,
    cara: `nomor batch tanpa prefiks; hari itu hanya prefiks ${p} yang dipakai`,
  };
}

/* ------------------------------------------------------------------ */
/* Penerapan                                                           */
/* ------------------------------------------------------------------ */

/**
 * Mencoba memperbaiki satu nilai yang gagal diparse.
 *
 * @param {GagalParse} err
 * @param {*} mentah nilai asli dari berkas sumber
 * @param {object} profil hasil bangunProfil()
 * @returns {{nilai: *, cara: string}|null}
 */
export function coba(err, mentah, profil) {
  if (!(err instanceof GagalParse)) return null;
  if (err.jenis === 'angka') return perbaikiAngka(mentah, err.kolom, profil);
  if (err.jenis === 'waktu') return perbaikiWaktu(mentah, err.kolom);
  return null;
}
