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
import { keIndeks, selMonitoring, selTransfer } from './formLayout.js';

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

  const barisTerbit = model.halaman1.slice(0, h1def.kapasitasBaris);
  barisTerbit.forEach((b, i) => {
    const baris = h1def.barisPertama + i;
    for (const [kunci, def] of kolomPerKunci) {
      const nilai = b[kunci];
      // Tata letak menyimpan huruf kolom karena itu yang terbaca manusia saat
      // dicocokkan dengan formnya; ExcelJS menuntut indeks.
      const kolom = keIndeks(def.huruf);
      if (def.jenis === 'jam') {
        tulis(ws1, baris, kolom, keSerialJam(nilai), FORMAT_JAM);
      } else {
        tulis(ws1, baris, kolom, nilai);
      }
    }
  });

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

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Nama berkas, mengikuti konvensi flow lama.
 *
 * Sufiks `_2`, `_3`, ... dipertahankan supaya berkas terbitan sebelumnya tidak
 * pernah tertimpa. Pada catatan mutu, menerbitkan ulang bukan mengganti yang
 * lama; keduanya harus tetap ada.
 */
export function namaBerkas(tanggalIso, iterasi = 1) {
  const padat = tanggalIso.replaceAll('-', '');
  return iterasi <= 1 ? `Rekap_FM_${padat}.xlsx` : `Rekap_FM_${padat}_${iterasi}.xlsx`;
}
