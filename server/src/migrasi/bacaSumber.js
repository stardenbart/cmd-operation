/**
 * Pembaca berkas sumber migrasi - F4-1
 *
 * Menerima hasil export SharePoint apa adanya: `.xlsx` atau `.csv`, satu
 * berkas per list, dinamai menurut listnya. Kedua format diterima karena yang
 * mengekspor adalah manusia lewat antarmuka SharePoint, dan memaksa satu
 * format berarti menambah satu langkah manual yang dapat salah.
 *
 * Kolom dikenali dari BARIS KEPALA, bukan dari posisi. SharePoint menyusun
 * kolom menurut tampilan yang sedang aktif, dan urutannya berubah tanpa
 * memberi tahu siapa pun.
 */

import { readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import ExcelJS from 'exceljs';

/** Ekstensi yang dikenali, diurutkan menurut keandalan tipenya. */
const EKSTENSI = ['.xlsx', '.csv'];

/**
 * Mencari berkas untuk satu list.
 *
 * Pencocokan longgar dengan sengaja: SharePoint kerap menambahkan tanggal atau
 * kata "export" pada nama berkas, dan menuntut nama persis akan membuat
 * migrasi gagal karena hal yang sama sekali tidak penting.
 */
export async function cariBerkas(dir, namaList) {
  const isi = await readdir(dir);
  const sasaran = namaList.toLowerCase();

  const cocok = isi.filter((f) => {
    const ext = extname(f).toLowerCase();
    if (!EKSTENSI.includes(ext)) return false;
    return basename(f, ext).toLowerCase().includes(sasaran);
  });

  if (cocok.length === 0) return null;

  // Bila ada beberapa, .xlsx dimenangkan: tipenya terbawa, sedangkan CSV
  // menyerahkan seluruh penafsiran tipe kepada pembacanya.
  cocok.sort((a, b) => EKSTENSI.indexOf(extname(a).toLowerCase()) - EKSTENSI.indexOf(extname(b).toLowerCase()));
  return join(dir, cocok[0]);
}

/**
 * Memecah SELURUH isi CSV menjadi baris dan sel, sekaligus.
 *
 * Bukan "pecah per baris lalu pecah per sel". Sel yang dikutip boleh memuat
 * baris baru di dalamnya, dan `supplier_fifo` memang memuatnya: JSON alokasi
 * FIFO ditulis Power Apps dengan pemformatan. Memecah pada baris baru lebih
 * dahulu memotong sel itu di tengah, dan akibatnya tidak terlihat sebagai
 * galat - hanya sebagai jumlah baris yang membengkak. Pada berkas transfer
 * sungguhan, 1.138 baris terbaca sebagai 2.750.
 */
/* Ditulis lewat fromCharCode supaya karakternya tidak dapat rusak lagi
   oleh alat penyunting mana pun. */
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function pecahCsv(teks, pemisah) {
  const baris = [];
  let sel = [];
  let buffer = '';
  let dalamKutip = false;

  for (let i = 0; i < teks.length; i += 1) {
    const c = teks[i];

    if (dalamKutip) {
      if (c === '"') {
        if (teks[i + 1] === '"') { buffer += '"'; i += 1; } else dalamKutip = false;
      } else buffer += c;
      continue;
    }

    if (c === '"') { dalamKutip = true; continue; }
    if (c === pemisah) { sel.push(buffer); buffer = ''; continue; }

    if (c === CR) continue;
    if (c === LF) {
      sel.push(buffer);
      buffer = '';
      if (sel.some((x) => x.trim() !== '')) baris.push(sel);
      sel = [];
      continue;
    }
    buffer += c;
  }

  sel.push(buffer);
  if (sel.some((x) => x.trim() !== '')) baris.push(sel);
  return baris;
}

/**
 * Menebak pemisah CSV dari baris kepalanya.
 *
 * Export SharePoint berbahasa Indonesia memakai titik koma, yang berbahasa
 * Inggris memakai koma. Menebaknya dari baris kepala aman: nama kolom tidak
 * memuat kedua tanda itu.
 */
function tebakPemisah(barisKepala) {
  const koma = (barisKepala.match(/,/g) ?? []).length;
  const titikKoma = (barisKepala.match(/;/g) ?? []).length;
  return titikKoma > koma ? ';' : ',';
}

async function bacaCsv(berkas) {
  const { readFile } = await import('node:fs/promises');
  let teks = await readFile(berkas, 'utf8');
  // BOM dari Excel akan menempel pada nama kolom pertama dan membuatnya
  // tidak pernah cocok.
  if (teks.charCodeAt(0) === 0xfeff) teks = teks.slice(1);

  const barisPertama = teks.split(LF, 1)[0] ?? '';
  const semua = pecahCsv(teks, tebakPemisah(barisPertama));
  if (semua.length === 0) return { kepala: [], data: [] };

  const kepala = semua[0].map((h) => h.trim());
  const data = semua.slice(1).map((sel, i) => {
    const objek = { _barisSumber: i + 2 };
    kepala.forEach((h, j) => { objek[h] = sel[j] ?? ''; });
    return objek;
  });

  return { kepala, data };
}

async function bacaXlsx(berkas) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(berkas);
  const ws = wb.worksheets[0];
  if (!ws) return { kepala: [], data: [] };

  const kepala = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (sel, kolom) => {
    kepala[kolom - 1] = String(sel.value ?? '').trim();
  });

  const data = [];
  ws.eachRow({ includeEmpty: false }, (baris, nomor) => {
    if (nomor === 1) return;
    const objek = { _barisSumber: nomor };
    let adaIsi = false;

    kepala.forEach((h, i) => {
      if (!h) return;
      let v = baris.getCell(i + 1).value;
      // ExcelJS membungkus rumus dan teks kaya; yang dibutuhkan hasilnya
      if (v && typeof v === 'object') {
        if ('result' in v) v = v.result;
        else if ('text' in v) v = v.text;
        else if ('richText' in v) v = v.richText.map((r) => r.text).join('');
      }
      objek[h] = v ?? '';
      if (objek[h] !== '') adaIsi = true;
    });

    if (adaIsi) data.push(objek);
  });

  return { kepala, data };
}

/**
 * Membaca satu list.
 *
 * @returns {Promise<{berkas: string, kepala: string[], data: object[]}|null>}
 */
export async function bacaList(dir, namaList) {
  const berkas = await cariBerkas(dir, namaList);
  if (!berkas) return null;

  const hasil = extname(berkas).toLowerCase() === '.csv'
    ? await bacaCsv(berkas)
    : await bacaXlsx(berkas);

  return { berkas, ...hasil };
}

/**
 * Memeriksa kolom wajib ADA sebelum pemuatan dimulai.
 *
 * Diperiksa lebih dulu, bukan saat baris pertama diproses: menemukan kolom
 * yang hilang setelah separuh data termuat berarti keadaan setengah jadi yang
 * harus dibersihkan manual.
 */
export function periksaKepala(def, kepala) {
  const ada = new Set(kepala.map((h) => h.toLowerCase()));
  const hilang = def.kolom
    .filter((k) => k.wajib)
    .map((k) => k.dari)
    .filter((nama) => !ada.has(nama.toLowerCase()));

  return { lengkap: hilang.length === 0, hilang };
}
