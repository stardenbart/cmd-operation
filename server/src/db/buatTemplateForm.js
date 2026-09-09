/**
 * Membangun template form GMP dari berkas hasil export sungguhan - F3-2
 *
 * Template asli `CMD1_FRM_PRD_01.xlsx` tidak tersedia: paket Power Automate
 * hanya memuat definisi flow, dan Office Script yang menulis selnya pun tidak
 * ikut (hanya scriptId). Yang ada adalah 20 berkas hasil export di
 * `reference/export-samples/`.
 *
 * Karena itu templatenya DITURUNKAN dari salah satu hasil export: barisnya
 * dibersihkan, sisanya dibiarkan apa adanya. Ini pilihan yang sadar dan lebih
 * aman daripada menggambar ulang formnya:
 *
 *  - Form ini catatan mutu terkendali `CMD1/FRM/PRD/01`. Merge, lebar kolom,
 *    tinggi baris, garis, dan pengaturan cetaknya adalah bagian dari dokumen
 *    yang disahkan, bukan hiasan. Menggambar ulang berarti berharap mirip.
 *  - Kop, nomor dokumen, nomor revisi, tanggal berlaku, dan catatan kaki OPRP
 *    ikut terbawa persis, termasuk spasi yang tampak berlebih pada labelnya.
 *
 * Empat sheet template kosong dibuang (B-28); yang disimpan hanya dua sheet
 * yang benar-benar diisi.
 *
 *   node src/db/buatTemplateForm.js
 */

import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AKAR = join(__dirname, '..', '..', '..');
const DIR_SAMPEL = join(AKAR, 'reference', 'export-samples');
const DIR_TEMPLATE = join(AKAR, 'db', 'templates');

/** Sheet yang dipertahankan. Sisanya template kosong dan dibuang (B-28). */
export const SHEET = {
  halaman1: 'Receiving_Prepast',
  halaman2: 'Monitoring_Transfer',
};

/**
 * Baris yang dibersihkan dari data, per sheet.
 *
 * Rentangnya sengaja ditulis eksplisit, bukan "semua yang bukan header":
 * menebak batas header akan menghapus catatan kaki OPRP di A27 atau blok
 * tanda tangan di A46, dan keduanya bagian dari form.
 */
const AREA_DATA = {
  [SHEET.halaman1]: [
    // Baris penerimaan. Kolom A memuat nomor urut yang bagian dari template,
    // jadi hanya B sampai P yang dikosongkan.
    { dariBaris: 10, sampaiBaris: 26, dariKolom: 2, sampaiKolom: 16 },
  ],
  [SHEET.halaman2]: [
    // Monitoring: 7 slot x 8 silo x 3 kolom
    { dariBaris: 10, sampaiBaris: 16, dariKolom: 2, sampaiKolom: 25 },
    // Nama operator per silo
    { dariBaris: 18, sampaiBaris: 18, dariKolom: 2, sampaiKolom: 25 },
    // Transfer: 8 silo x 3 baris, mulai baris 21. Kolom A memuat label silo
    // yang bagian dari template.
    { dariBaris: 21, sampaiBaris: 44, dariKolom: 2, sampaiKolom: 25 },
  ],
};

/** Sel tanggal, dikosongkan supaya template tidak membawa tanggal contoh. */
const SEL_TANGGAL = 'C6';

export async function buatTemplate({ sumber } = {}) {
  const berkas = sumber
    ?? (await readdir(DIR_SAMPEL)).filter((f) => f.endsWith('.xlsx')).sort().at(-1);
  if (!berkas) throw new Error(`Tidak ada berkas contoh di ${DIR_SAMPEL}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(join(DIR_SAMPEL, berkas));

  const dipertahankan = new Set(Object.values(SHEET));
  for (const ws of [...wb.worksheets]) {
    if (!dipertahankan.has(ws.name)) wb.removeWorksheet(ws.id);
  }

  for (const [namaSheet, area] of Object.entries(AREA_DATA)) {
    const ws = wb.getWorksheet(namaSheet);
    if (!ws) throw new Error(`Sheet "${namaSheet}" tidak ada di ${berkas}`);

    ws.getCell(SEL_TANGGAL).value = null;

    for (const a of area) {
      for (let r = a.dariBaris; r <= a.sampaiBaris; r += 1) {
        for (let c = a.dariKolom; c <= a.sampaiKolom; c += 1) {
          // Nilai dihapus, GAYA dibiarkan. Border dan format angka adalah
          // bagian dari form; menghapusnya akan membuat sel yang diisi nanti
          // tampak berbeda dari sel tetangganya.
          ws.getCell(r, c).value = null;
        }
      }
    }
  }

  await mkdir(DIR_TEMPLATE, { recursive: true });
  const tujuan = join(DIR_TEMPLATE, 'CMD1_FRM_PRD_01_rev02.xlsx');
  await wb.xlsx.writeFile(tujuan);

  return { sumber: berkas, tujuan, sheet: wb.worksheets.map((w) => w.name) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buatTemplate()
    .then((h) => {
      console.log(`✔ Template dibuat dari ${h.sumber}`);
      console.log(`  ${h.tujuan}`);
      console.log(`  sheet: ${h.sheet.join(', ')}`);
    })
    .catch((err) => {
      console.error(`✖ ${err.message}`);
      process.exit(1);
    });
}
