/**
 * Bentuk & normalisasi batch — BR-21
 *
 * FUNGSI MURNI.
 *
 * Bentuk kanonik: <PREFIKS><nomor> — huruf besar, tanpa spasi, tanpa nol
 * di depan. Contoh: HRC1, FC2, INK13. Transfer ke tank CMD 2 memakai batch
 * utuh `CMD2`; PINDAH SILO memakai `TF TO <silo>` yang dihasilkan sistem.
 *
 * Prefiks yang sah sesungguhnya dikelola Admin lewat tabel `batch_prefix`
 * (FR-26.1.5). Daftar di sini adalah cadangan untuk normalisasi data historis
 * dan untuk pengujian, bukan sumber kebenaran saat runtime.
 */

/** Prefiks yang muncul nyata di data. HC TIDAK termasuk — lapangan memakai HRC (D-13). */
export const PREFIKS_SAH = new Set(['HRC', 'FC', 'INK', 'FULLFM', 'SR', 'CMD2']);

/** Prefiks yang berdiri sendiri tanpa nomor. */
const TANPA_NOMOR = new Set(['CMD2']);

/** Sinonim yang ditemukan di data historis. */
const SINONIM = new Map([['INKUBASI', 'INK']]);

/**
 * Merakit batch dari prefiks dan nomor — jalur input baru.
 *
 * Di UI, prefiks dipilih dari dropdown dan nomor diisi terpisah (FR-30.3),
 * sehingga bentuk yang salah menjadi mustahil — bukan sekadar tidak
 * dianjurkan seperti pada field bebas-teks di Power Apps.
 */
export function bentukBatch(prefix, nomor) {
  const p = String(prefix ?? '').trim().toUpperCase();

  if (!PREFIKS_SAH.has(p)) {
    throw new TypeError(
      `Prefiks batch tidak terdaftar: "${prefix}". Sah: ${[...PREFIKS_SAH].join(', ')}`,
    );
  }

  if (TANPA_NOMOR.has(p)) {
    if (nomor !== undefined && nomor !== null && nomor !== '') {
      throw new TypeError(`Batch ${p} dipakai tanpa nomor`);
    }
    return p;
  }

  const n = Number(String(nomor ?? '').trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`Nomor batch harus bilangan bulat positif, diterima: ${nomor}`);
  }

  return `${p}${n}`;
}

/**
 * Batch mengikuti ATURAN tangkinya - BR-21.
 *
 * Tiga tangki berperilaku berbeda, dan bedanya sekarang tersimpan di
 * `tank_master.aturan_batch` (migrasi 011), bukan disimpulkan dari namanya.
 * Membandingkan nama akan diam-diam berhenti bekerja begitu tangkinya diganti
 * nama lewat Master Data - tanpa galat, hanya dengan meminta batch yang
 * seharusnya tidak diminta.
 *
 *   TETAP_CMD2   selalu `CMD2`. Prefiks dan nomor yang dikirim DIABAIKAN,
 *                bukan ditolak: kalaupun klien lama masih mengirimnya, batch
 *                yang tersimpan tetap benar.
 *   TANPA_BATCH  tidak berbatch. PENGOSONGAN SILO bukan produksi - susunya
 *                dibuang atau dikembalikan, jadi tidak ada batch produksi yang
 *                dapat disebut. Mengembalikan null, bukan string kosong: kolom
 *                `batch` memang NULL-able, dan string kosong akan terbaca
 *                sebagai batch bernama "" pada laporan.
 *   PILIH        prefiks dipilih, nomor diketik.
 *
 * @param {'PILIH'|'TETAP_CMD2'|'TANPA_BATCH'} aturan
 * @returns {string|null}
 */
export function batchUntukTank(aturan, prefix, nomor) {
  if (aturan === 'TETAP_CMD2') return 'CMD2';
  if (aturan === 'TANPA_BATCH') return null;

  if (aturan !== 'PILIH' && aturan !== undefined && aturan !== null) {
    throw new TypeError(`Aturan batch tangki tidak dikenal: "${aturan}"`);
  }
  return bentukBatch(prefix, nomor);
}

/** Batch untuk PINDAH SILO — dihasilkan sistem, bukan diketik operator. */
export function batchPindahSilo(namaSilo) {
  // Data nyata menulis "TF TO SILO6" tanpa spasi; nama silo di basis data
  // juga tanpa spasi (temuan B-19), tetapi spasi tetap dirapatkan agar
  // hasilnya seragam apa pun bentuk masukannya.
  return `TF TO ${String(namaSilo ?? '').replaceAll(' ', '').toUpperCase()}`;
}

/**
 * Menormalkan batch historis ke bentuk kanonik — dipakai migrasi (F4-6).
 *
 * Mengembalikan `{ batch, keterangan }`. Nilai yang tidak dapat dipetakan
 * mengembalikan `batch: null` dan teks aslinya di `keterangan` — sengaja
 * TIDAK ditebak, karena menebak justru menyamarkan salah input. Nilai
 * semacam itu masuk laporan pengecualian untuk ditinjau manusia (T-4).
 */
export function normalisasiBatch(mentah) {
  if (mentah === null || mentah === undefined) return { batch: null, keterangan: null };

  const asli = String(mentah).trim();
  if (asli === '') return { batch: null, keterangan: null };

  const besar = asli.toUpperCase();

  // Batch PINDAH SILO dihasilkan sistem — diteruskan apa adanya
  if (besar.startsWith('TF TO ')) {
    return { batch: `TF TO ${besar.slice(6).replaceAll(' ', '')}`, keterangan: null };
  }

  // Keterangan produk yang menumpang di field batch dipisahkan:
  // "11ink 240ml", "13 ink (FullFm)", "14ink full fm"
  let keterangan = null;
  let inti = besar;

  const dalamKurung = asli.match(/\(([^)]+)\)/);
  if (dalamKurung) {
    keterangan = dalamKurung[1].trim();
    inti = besar.replace(/\([^)]*\)/, '').trim();
  }

  // Ukuran kemasan, mis. "240ml". TIDAK memakai batas kata di depan angka:
  // pada "10 INK240ML" tidak ada batas kata antara K dan 2, sehingga pola
  // ber-\b tidak cocok sama sekali — celah yang baru terlihat saat menguji
  // normalizer ini terhadap 336 nilai batch nyata.
  const ukuran = inti.match(/(\d+)\s*ML\b/);
  if (ukuran) {
    keterangan = asli.match(/(\d+)\s*ml\b/i)?.[0]?.trim() ?? ukuran[0];
    inti = inti.replace(ukuran[0], '').trim();
  }

  // "full fm" diperlakukan sebagai KETERANGAN hanya bila ia bukan prefiks
  // FULLFM itu sendiri. Tanpa penjagaan ini, "10 fullfm" kehilangan
  // prefiksnya dan menyisakan "10" yang tidak cocok pola apa pun.
  const fullFmAdalahPrefiks = /^(\d*)FULLFM(\d*)$/.test(inti.replaceAll(' ', ''));
  if (!fullFmAdalahPrefiks) {
    const fullFm = inti.match(/\bFULL\s*FM\b/);
    if (fullFm) {
      keterangan = keterangan ?? 'FullFm';
      inti = inti.replace(fullFm[0], '').trim();
    }
  }

  // Awalan "B", "B.", "B " yang tidak konsisten di data dibuang
  inti = inti.replace(/^B[.\s]*/, '').trim();

  // Rapatkan seluruh spasi: "3 FC" -> "3FC", "HRC 4" -> "HRC4"
  inti = inti.replaceAll(' ', '');

  if (SINONIM.has(inti)) {
    return { batch: SINONIM.get(inti), keterangan };
  }

  // Sinonim yang membawa nomor: "INKUBASI1" -> "INK1"
  for (const [panjang, pendek] of SINONIM) {
    const depan = inti.match(new RegExp(`^${panjang}(\\d+)$`));
    if (depan) return { batch: `${pendek}${Number(depan[1])}`, keterangan };
    const belakang = inti.match(new RegExp(`^(\\d+)${panjang}$`));
    if (belakang) return { batch: `${pendek}${Number(belakang[1])}`, keterangan };
  }

  if (TANPA_NOMOR.has(inti)) {
    return { batch: inti, keterangan };
  }

  // Bentuk kanonik: PREFIKS lalu nomor
  const kanonik = inti.match(/^([A-Z]+)(\d+)$/);
  if (kanonik && PREFIKS_SAH.has(kanonik[1])) {
    return { batch: `${kanonik[1]}${Number(kanonik[2])}`, keterangan };
  }

  // Bentuk terbalik: nomor lalu PREFIKS — 55 dari 336 pencatatan
  const terbalik = inti.match(/^(\d+)([A-Z]+)$/);
  if (terbalik) {
    const prefiks = SINONIM.get(terbalik[2]) ?? terbalik[2];
    if (PREFIKS_SAH.has(prefiks)) {
      return { batch: `${prefiks}${Number(terbalik[1])}`, keterangan };
    }
  }

  // Prefiks tanpa nomor sama sekali
  if (PREFIKS_SAH.has(inti)) {
    return { batch: inti, keterangan };
  }

  return { batch: null, keterangan: asli };
}
