/**
 * Penyaji Excel form GMP - F3-3, FR-12.2, FR-28.7
 *
 * Menulis model dari `formData.js` ke dalam template terkendali. Templatenya
 * berkas biner, bukan digambar ulang: merge, gaya, lebar kolom, dan pengaturan
 * cetaknya bagian dari dokumen yang disahkan.
 *
 * Penyaji ini dan penyaji pratinjau membaca tata letak yang SAMA
 * (`formLayout.js`), sehingga pratinjau tidak dapat menyimpang dari berkasnya.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import QRCode from 'qrcode';
import {
  keIndeks, selMonitoring, selTransfer, tataLetakUntuk,
} from './formLayout.js';
import { tautanApprovalHarian } from './approvalShare.js';
import { ambilTandaTangan } from './signature.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR_TEMPLATE = join(__dirname, '..', '..', '..', 'db', 'templates');

/**
 * Excel menyimpan jam sebagai pecahan hari.
 *
 * Ini inti perbaikan B-16. Flow lama mengirim tanggal dan jam sebagai TEKS,
 * sehingga Excel menafsirkannya menurut lokal: `06/08/2026` menjadi 8 Juni,
 * bukan 6 Agustus, dan 11 dari 20 berkas Agustus memuat tanggal yang salah.
 * Nilai numerik tidak dapat ditafsirkan ulang oleh siapa pun.
 */
const keSerialJam = (jam) => (jam ? (jam.jam * 60 + jam.menit) / 1440 : null);

/**
 * Tanggal sebagai objek Date, bukan string.
 *
 * Dibangun pada tengah hari UTC dengan sengaja: tanggal yang dibangun pada
 * tengah malam dapat bergeser satu hari saat Excel atau pembaca lain
 * menerapkan zona waktu, dan pergeseran satu hari pada catatan mutu berarti
 * form bertanggal salah.
 */
function keTanggalExcel(tanggalIso) {
  const [tahun, bulan, hari] = tanggalIso.split('-').map(Number);
  return new Date(Date.UTC(tahun, bulan - 1, hari, 12, 0, 0));
}

const FORMAT_JAM = 'hh:mm';
const FORMAT_TANGGAL = 'dd/mm/yyyy';
const FORMAT_UMUM = 'General';

/**
 * Menulis satu sel. Sel kosong DIBIARKAN kosong (B-26).
 *
 * Gaya selnya disalin lebih dahulu, dan itu wajib, bukan kehati-hatian.
 * ExcelJS menyimpan gaya sebagai objek BERSAMA antar sel yang gayanya identik;
 * menetapkan `numFmt` mengubah objek itu di tempat, sehingga seluruh sel yang
 * ikut memakainya berubah juga. Gejalanya terlihat saat diuji: menetapkan
 * format jam pada kolom "Jam Transfer" membuat kolom "Volume" di sebelahnya
 * ikut berformat jam, dan volume 9.000 liter tercetak sebagai tanggal di
 * tahun 1924.
 *
 * Format SELALU ditetapkan, termasuk `General`. Membiarkan sel mewarisi format
 * dari template berarti bergantung pada gaya sel yang kebetulan ada di sana.
 */
function tulis(ws, baris, kolom, nilai, format = FORMAT_UMUM) {
  if (nilai === null || nilai === undefined || nilai === '') return;
  const sel = ws.getCell(baris, kolom);
  sel.style = { ...sel.style };
  sel.value = nilai;
  sel.numFmt = format;
}

/**
 * Ukuran QR dalam piksel. Tinggi baris data di template 52,5pt (~70px pada
 * 96dpi yang dipakai ExcelJS untuk `ext`) - 60px menyisakan sedikit jarak di
 * atas/bawah sel, bukan menempel pas ke tepinya.
 *
 * SENGAJA memakai `ext` eksplisit, bukan membiarkan ExcelJS mengepas ke
 * rentang tl/br: percobaan pertama memakai tl+br saja menghasilkan QR yang
 * tampil di ukuran piksel ASLI PNG-nya (96x96), jauh lebih tinggi dari satu
 * baris (~70px) sehingga tumpang tindih ke baris berikutnya. `ext` eksplisit
 * memastikan ukuran tampil, terlepas dari bagaimana pembaca xlsx menafsirkan
 * anchor dua-sel itu.
 */
const UKURAN_QR_PX = 60;

/**
 * Menyisipkan QR. `ukuran` boleh ditimpa per pemanggil - Halaman 2 memakai
 * ukuran lebih besar dari bawaan (lihat diperiksaOleh.ukuranQr di
 * formLayout.js), sebab ruangnya di sana memang lebih lega.
 */
async function tulisQr(wb, ws, baris, kolom, teks, ukuran = UKURAN_QR_PX) {
  const png = await QRCode.toBuffer(teks, { type: 'png', margin: 0, width: ukuran });
  const imageId = wb.addImage({ buffer: png, extension: 'png' });
  ws.addImage(imageId, {
    tl: { col: kolom - 1, row: baris - 1 },
    ext: { width: ukuran, height: ukuran },
    editAs: 'oneCell',
  });
}

/**
 * Ukuran tampil tanda tangan di kolom Paraf, mempertahankan rasio kanvas
 * gambar di frontend (lihat DialogTandaTangan.jsx, kanvas 300x120 - rasio
 * 2,5:1). Tinggi baris ~70px membatasi; 55px tinggi menyisakan jarak
 * atas-bawah, lebarnya (55*2.5=137,5px) muat jauh di dalam lebar kolom
 * Paraf (~278px), tidak perlu menyentuh kolom di sebelahnya.
 */
const TINGGI_TANDA_TANGAN_PX = 55;
const RASIO_TANDA_TANGAN = 300 / 120;

/** MDW (Maximum Digit Width) font Calibri 11 default - dipakai Excel sendiri
 * untuk mengonversi lebar kolom (satuan karakter) ke piksel. */
const MDW = 7;
const PX_KE_EMU = 9525;

/** Lebar kolom ExcelJS (satuan karakter) -> piksel, rumus resmi Microsoft. */
function lebarKolomKePx(lebarKarakter) {
  return Math.floor(((256 * lebarKarakter + Math.floor(128 / MDW)) / 256) * MDW);
}

/** Tinggi baris ExcelJS (satuan poin) -> piksel (96 DPI). */
function tinggiBarisKePx(poin) {
  return Math.round((poin * 96) / 72);
}

/**
 * Menyisipkan gambar tanda tangan - lihat services/signature.js.
 *
 * Di-tengah-kan di dalam sel (bukan menempel pojok kiri-atas): kolom Paraf
 * jauh lebih lebar daripada gambarnya, jadi tanpa offset gambarnya terlihat
 * nyempil di sudut alih-alih rapi di tengah sel.
 */
function tulisTandaTangan(wb, ws, baris, kolom, png) {
  const lebarGambar = Math.round(TINGGI_TANDA_TANGAN_PX * RASIO_TANDA_TANGAN);
  const tinggiGambar = TINGGI_TANDA_TANGAN_PX;

  const lebarSelPx = lebarKolomKePx(ws.getColumn(kolom).width);
  const tinggiSelPx = tinggiBarisKePx(ws.getRow(baris).height);

  const colOff = Math.max(0, Math.round(((lebarSelPx - lebarGambar) / 2) * PX_KE_EMU));
  const rowOff = Math.max(0, Math.round(((tinggiSelPx - tinggiGambar) / 2) * PX_KE_EMU));

  const imageId = wb.addImage({ buffer: png, extension: 'png' });
  ws.addImage(imageId, {
    // ExcelJS mengabaikan colOff/rowOff kalau dipasangkan dengan col/row -
    // Anchor (doc/anchor.js) hanya membaca colOff/rowOff lewat kunci
    // nativeCol/nativeColOff/nativeRow/nativeRowOff (satuan EMU langsung).
    tl: {
      nativeCol: kolom - 1, nativeColOff: colOff, nativeRow: baris - 1, nativeRowOff: rowOff,
    },
    ext: { width: lebarGambar, height: tinggiGambar },
    editAs: 'oneCell',
  });
}

/**
 * Mengisi sel "Diperiksa Oleh" (Halaman 2).
 *
 * Run "Spv Produksi Shift 1/2/3 :" dari template dibuang (diminta
 * pengguna) - namanya menyambung langsung ke "Diperiksa Oleh,". Run lain
 * (spasi awal, "Diperiksa Oleh," sendiri) dipertahankan apa adanya. QR
 * ditaruh di kolom kosong pada baris yang sama.
 */
async function tulisDiperiksaOleh(wb, ws, def, namaList, tautan) {
  const sel = ws.getCell(def.sel);
  const asli = sel.value?.richText ?? [{ text: String(sel.value ?? '') }];
  const tanpaShift = asli.filter((r) => !r.text.includes('Spv Produksi'));
  if (namaList.length > 0) {
    const gayaTerakhir = tanpaShift.at(-1)?.font;
    tanpaShift.push({ font: gayaTerakhir, text: ` ${namaList.join(', ')}` });
  }
  sel.value = { richText: tanpaShift };
  await tulisQr(wb, ws, def.baris, def.kolomQr, tautan, def.ukuranQr);
}

/**
 * @param {object} model  keluaran modelForm()
 * @returns {Promise<Buffer>} berkas xlsx
 */
export async function bangunBerkas(model) {
  const { tataLetak } = model;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(DIR_TEMPLATE, tataLetak.berkasTemplate));

  const h1def = tataLetak.halaman1;
  const h2def = tataLetak.halaman2;
  const ws1 = wb.getWorksheet(h1def.sheet);
  const ws2 = wb.getWorksheet(h2def.sheet);
  if (!ws1 || !ws2) throw new Error('Template form tidak memuat sheet yang diharapkan');

  const tanggal = keTanggalExcel(model.tanggal);
  for (const [ws, def] of [[ws1, h1def], [ws2, h2def]]) {
    const sel = ws.getCell(def.selTanggal);
    sel.style = { ...sel.style };
    sel.value = tanggal;
    sel.numFmt = FORMAT_TANGGAL;
  }

  // ---- Halaman 1 ----
  const kolomPerKunci = new Map(
    h1def.kolom.filter((k) => !k.dariTemplate).map((k) => [k.kunci, k]),
  );

  // Cache per operator_id - banyak baris kerap dikerjakan operator yang
  // sama, tidak perlu ambil gambar tanda tangannya berulang-ulang.
  const cacheTandaTangan = new Map();
  async function tandaTanganUntuk(operatorId) {
    if (!cacheTandaTangan.has(operatorId)) {
      cacheTandaTangan.set(operatorId, await ambilTandaTangan(operatorId));
    }
    return cacheTandaTangan.get(operatorId);
  }

  const barisTerbit = model.halaman1.slice(0, h1def.kapasitasBaris);
  for (let i = 0; i < barisTerbit.length; i += 1) {
    const b = barisTerbit[i];
    const baris = h1def.barisPertama + i;
    for (const [kunci, def] of kolomPerKunci) {
      const nilai = b[kunci];
      // Tata letak menyimpan huruf kolom karena itu yang terbaca manusia saat
      // dicocokkan dengan formnya; ExcelJS menuntut indeks.
      const kolom = keIndeks(def.huruf);
      if (def.jenis === 'jam') {
        tulis(ws1, baris, kolom, keSerialJam(nilai), FORMAT_JAM);
      } else if (def.jenis === 'tanda-tangan') {
        // nilai di sini adalah operator_id (lihat formData.js). Record baru
        // tidak mungkin dibuat tanpa tanda tangan (BR ditegakkan di
        // receiving.buat()), tapi record LAMA dari sebelum fitur ini ada
        // bisa saja belum punya - selnya dibiarkan kosong, bukan gagal
        // seluruh export.
        if (nilai) {
          const png = await tandaTanganUntuk(nilai);
          if (png) tulisTandaTangan(wb, ws1, baris, kolom, png);
        }
      } else {
        tulis(ws1, baris, kolom, nilai);
      }
    }
  }

  // ---- Halaman 2: monitoring ----
  const m = h2def.monitoring;
  model.halaman2.monitoring.forEach((silo, indeksSilo) => {
    silo.slot.slice(0, m.kapasitasSlot).forEach((cek, indeksSlot) => {
      const jam = selMonitoring(m, indeksSilo, indeksSlot, 'jam');
      const suhu = selMonitoring(m, indeksSilo, indeksSlot, 'suhu');
      const ph = selMonitoring(m, indeksSilo, indeksSlot, 'ph');
      tulis(ws2, jam.baris, jam.kolom, keSerialJam(cek.jam), FORMAT_JAM);
      tulis(ws2, suhu.baris, suhu.kolom, cek.suhu);
      tulis(ws2, ph.baris, ph.kolom, cek.ph);
    });

    if (silo.operator) {
      const kolom = m.kolomPertama + indeksSilo * m.kolomPerSilo;
      tulis(ws2, m.barisOperator, kolom, silo.operator);
    }
  });

  // ---- Halaman 2: transfer ----
  const t = h2def.transfer;
  const kapasitas = t.barisPerSilo * t.slotPerBaris;
  model.halaman2.transfer.forEach((silo, indeksSilo) => {
    silo.slot.slice(0, kapasitas).forEach((trf, indeksSlot) => {
      const jam = selTransfer(t, indeksSilo, indeksSlot, 'jam');
      const batch = selTransfer(t, indeksSilo, indeksSlot, 'batch');
      const volume = selTransfer(t, indeksSilo, indeksSlot, 'volume');

      /**
       * Penanda silo kosong ditulis sebagai `0 / 0 / 0`, persis seperti pada
       * form. Nolnya BUKAN nilai kosong; ia menyatakan silo mencapai posisi
       * kosong pada transfer sebelumnya, dan itu berarti tidak ada carry-over
       * setelahnya. Karena `tulis()` melewatkan nilai kosong, nolnya harus
       * ditulis eksplisit.
       */
      if (trf.penanda === 'KOSONG') {
        tulis(ws2, jam.baris, jam.kolom, 0);
        tulis(ws2, batch.baris, batch.kolom, 0);
        tulis(ws2, volume.baris, volume.kolom, 0);
        return;
      }

      tulis(ws2, jam.baris, jam.kolom, keSerialJam(trf.jam), FORMAT_JAM);
      tulis(ws2, batch.baris, batch.kolom, trf.batch);
      tulis(ws2, volume.baris, volume.kolom, trf.volume);
    });
  });

  // ---- Halaman 2: "Diperiksa Oleh" (nama SPV + QR harian) ----
  await tulisDiperiksaOleh(
    wb, ws2, h2def.diperiksaOleh,
    model.halaman2.diperiksaOleh, tautanApprovalHarian(model.tanggal),
  );

  /**
   * Mengunci QR-nya di tempat - B-30.
   *
   * Tanpa ini, QR cuma "menempel" secara visual: siapa pun yang membuka
   * berkasnya di Excel bisa menariknya (drag) lepas dari selnya sendiri,
   * termasuk tanpa sengaja. Sekali lepas dari baris asalnya, QR itu menunjuk
   * ke record yang salah bagi siapa pun yang memindainya nanti - berbahaya
   * untuk catatan mutu. `objects: false` di sini artinya "JANGAN izinkan
   * objek diedit" (lihat exceljs, namanya berlawanan dari XML `objects="1"`
   * yang dihasilkannya) - sel datanya sendiri tetap bisa dipilih dan
   * disalin, tanpa password (sengaja: ini pagar dari kesalahan tanpa
   * sengaja, bukan proteksi berkata sandi). Berlaku untuk KEDUA sheet -
   * Halaman 1 (QR Paraf) dan Halaman 2 (QR Diperiksa Oleh).
   */
  await ws1.protect('', { objects: false });
  await ws2.protect('', { objects: false });

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Nama berkas - diambil dari No. Dokumen formnya sendiri ("CMD1/FRM/PRD/01")
 * digabung tanggal (HARI/TANGGAL di kepala form, DD-MM-YYYY, bukan ISO),
 * bukan nama generik "Rekap_FM_...".
 *
 * Nomor dokumennya diambil per TANGGAL, bukan konstan: `tataLetakUntuk()`
 * memilih revisi berbeda untuk data yang lebih tua dari 11 Maret 2025, dan
 * nama berkasnya harus ikut menyebut revisi yang benar-benar terbit.
 *
 * Sufiks `_2`, `_3`, ... dipertahankan supaya berkas terbitan sebelumnya tidak
 * pernah tertimpa. Pada catatan mutu, menerbitkan ulang bukan mengganti yang
 * lama; keduanya harus tetap ada.
 */
export function namaBerkas(tanggalIso, iterasi = 1) {
  const { dokumen } = tataLetakUntuk(tanggalIso);
  const nomor = dokumen.nomor.replaceAll('/', '_');
  const [tahun, bulan, hari] = tanggalIso.split('-');
  const tanggal = `${hari}${bulan}${tahun}`;
  return iterasi <= 1 ? `${nomor}_${tanggal}.xlsx` : `${nomor}_${tanggal}_${iterasi}.xlsx`;
}
