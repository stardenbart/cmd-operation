/**
 * Pemeriksa berkas sumber - dijalankan SEBELUM migrasi
 *
 * Export SharePoint kerap terlihat berhasil padahal tidak lengkap, dan tiga
 * penyebabnya tidak menimbulkan galat apa pun:
 *
 *  1. Export hanya memuat kolom yang TAMPIL pada view yang sedang aktif.
 *     View bawaan biasanya menyembunyikan sebagian besar kolom, sehingga
 *     berkasnya terbuka dengan rapi tetapi kehilangan separuh datanya.
 *  2. Export mengikuti batas baris view. View yang dibatasi 100 item
 *     menghasilkan berkas berisi 100 baris, dan tidak ada yang memberi tahu
 *     bahwa sisanya tertinggal.
 *  3. Format tanggal mengikuti pengaturan regional. Berkas yang sama dapat
 *     terbaca sebagai bulan-hari atau hari-bulan tergantung siapa yang
 *     mengekspornya, dan keduanya terlihat sama-sama masuk akal.
 *
 * Pemeriksa ini menjawab ketiganya sebelum satu baris pun dimuat.
 */

import { LIST } from './sumberKolom.js';
import { bacaList } from './bacaSumber.js';
import { BERKAS_OPERATOR } from './muatOperator.js';

/** Contoh nilai tanggal, untuk menguji dugaan format sebelum memuat. */
function contohTanggal(data, namaKolom, jumlah = 5) {
  const contoh = [];
  for (const b of data) {
    const v = b[namaKolom];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    contoh.push(String(v).trim());
    if (contoh.length >= jumlah) break;
  }
  return contoh;
}

/**
 * Menyimpulkan urutan tanggal dari sebarannya.
 *
 * Bila ada satu saja nilai yang angka PERTAMAnya melebihi 12, urutannya pasti
 * hari-bulan. Bila ada yang angka KEDUAnya melebihi 12, pasti bulan-hari. Bila
 * keduanya tidak pernah melebihi 12, urutannya TIDAK DAPAT disimpulkan dari
 * data - dan itu keadaan yang paling berbahaya, sebab tebakan apa pun akan
 * terlihat masuk akal.
 */
export function simpulkanUrutanTanggal(contoh) {
  let pertamaLebih12 = 0;
  let keduaLebih12 = 0;
  let terbaca = 0;

  for (const t of contoh) {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(t);
    if (!m) continue;
    terbaca += 1;
    if (Number(m[1]) > 12) pertamaLebih12 += 1;
    if (Number(m[2]) > 12) keduaLebih12 += 1;
  }

  if (terbaca === 0) return { urutan: 'BUKAN NUMERIK', yakin: false };
  if (pertamaLebih12 > 0 && keduaLebih12 > 0) {
    return { urutan: 'BERTENTANGAN', yakin: false };
  }
  if (pertamaLebih12 > 0) return { urutan: 'dd/mm/yyyy', yakin: true };
  if (keduaLebih12 > 0) return { urutan: 'mm/dd/yyyy', yakin: true };
  return { urutan: 'TIDAK DAPAT DISIMPULKAN', yakin: false };
}

/** Kolom tanggal utama tiap list, yang paling banyak terisi. */
const KOLOM_TANGGAL = {
  receiving: 'start_time',
  prepast: 'prepast_finish',
  transfer: 'trf_time',
  monitoring: 'time_check',
};

/**
 * Memeriksa satu folder sumber.
 *
 * @returns {Promise<{siap: boolean, list: object[], catatan: string[]}>}
 */
export async function periksaSumber(dir, tanpa = []) {
  const hasil = [];
  const catatan = [];
  const dilewati = new Set(tanpa);

  const operator = dilewati.has('operator') ? null : await bacaList(dir, BERKAS_OPERATOR);
  if (dilewati.has('operator')) {
    hasil.push({
      list: 'operator', berkas: null, status: 'DILEWATI',
      pesan: 'Operator dikelola di aplikasi; tidak ikut diimport.',
    });
  } else if (!operator) {
    hasil.push({
      list: 'operator', berkas: null, status: 'HILANG',
      pesan: `Tidak ada berkas yang namanya memuat "${BERKAS_OPERATOR}"`,
    });
  } else {
    const kepala = new Set(operator.kepala.map((h) => h.trim().toLowerCase()));
    const wajib = ['user_id', 'nama_lengkap'];
    const hilangWajib = wajib.filter((k) => !kepala.has(k));
    hasil.push({
      list: 'operator', berkas: operator.berkas, jumlahBaris: operator.data.length,
      kolomHilang: ['role', 'is_active'].filter((k) => !kepala.has(k)),
      kolomWajibHilang: hilangWajib,
      status: hilangWajib.length ? 'TIDAK DAPAT DIMUAT' : 'LENGKAP',
    });
  }

  for (const [nama, def] of Object.entries(LIST)) {
    const isi = await bacaList(dir, def.berkas);

    if (!isi) {
      if (dilewati.has(nama)) {
        hasil.push({
          list: nama, berkas: null, status: 'DILEWATI',
          pesan: 'Sengaja tidak diekspor. Datanya TIDAK ikut pindah.',
        });
        continue;
      }
      hasil.push({
        list: nama, berkas: null, status: 'HILANG',
        pesan: `Tidak ada berkas yang namanya memuat "${def.berkas}"`,
      });
      continue;
    }

    const adaKolom = new Set(isi.kepala.map((h) => h.trim().toLowerCase()));
    const diharapkan = def.kolom.map((k) => k.dari);
    const hilang = diharapkan.filter((k) => !adaKolom.has(k.toLowerCase()));
    const hilangWajib = def.kolom
      .filter((k) => k.wajib && !adaKolom.has(k.dari.toLowerCase()))
      .map((k) => k.dari);

    const baris = { list: nama, berkas: isi.berkas, jumlahBaris: isi.data.length };

    baris.kolomHilang = hilang;
    baris.kolomWajibHilang = hilangWajib;

    /**
     * Angka bulat yang mencurigakan.
     *
     * Export yang terpotong batas view hampir selalu berhenti tepat di angka
     * bulat: 100, 500, 1.000, 5.000. Itu bukan bukti, tetapi cukup untuk
     * menuntut pemeriksaan sebelum data dipakai.
     */
    const bulatMencurigakan = [100, 200, 250, 500, 1000, 2000, 5000];
    baris.mungkinTerpotong = bulatMencurigakan.includes(isi.data.length);

    const kolomTanggal = KOLOM_TANGGAL[nama];
    if (kolomTanggal && adaKolom.has(kolomTanggal.toLowerCase())) {
      const contoh = contohTanggal(isi.data, kolomTanggal, 40);
      baris.contohTanggal = contoh.slice(0, 5);
      baris.formatTanggal = simpulkanUrutanTanggal(contoh);
    }

    if (hilangWajib.length > 0) baris.status = 'TIDAK DAPAT DIMUAT';
    else if (hilang.length > 0) baris.status = 'SEBAGIAN';
    else baris.status = 'LENGKAP';

    hasil.push(baris);
  }

  const adaHilang = hasil.some((h) => h.status === 'HILANG');
  const adaDilewati = hasil.filter((h) => h.status === 'DILEWATI');
  if (adaDilewati.length > 0) {
    catatan.push(
      'DILEWATI ATAS PERMINTAAN: ' + adaDilewati.map((h) => h.list).join(', ')
      + '. Datanya tidak ikut pindah, dan tabelnya akan kosong setelah migrasi.',
    );
  }
  const adaTidakDapat = hasil.some((h) => h.status === 'TIDAK DAPAT DIMUAT');
  const adaSebagian = hasil.some((h) => h.status === 'SEBAGIAN');

  if (adaHilang) {
    catatan.push(
      'Ada list yang berkasnya tidak ditemukan. List yang tidak berisi pun harus '
      + 'diekspor, walau hanya baris kepalanya.',
    );
  }
  if (adaSebagian) {
    catatan.push(
      'Ada kolom yang tidak ikut terekspor. Penyebab tersering: export hanya '
      + 'memuat kolom yang TAMPIL pada view yang sedang aktif. Buat view baru '
      + 'yang menampilkan seluruh kolom, lalu ekspor dari view itu.',
    );
  }
  if (hasil.some((h) => h.mungkinTerpotong)) {
    catatan.push(
      'Ada berkas yang jumlah barisnya tepat angka bulat. Periksa apakah view '
      + 'sumbernya membatasi jumlah item; export mengikuti batas itu tanpa '
      + 'memberi tahu bahwa sisanya tertinggal.',
    );
  }

  const tanggalRagu = hasil.filter((h) => h.formatTanggal && !h.formatTanggal.yakin);
  if (tanggalRagu.length > 0) {
    catatan.push(
      'Urutan hari dan bulan tidak dapat disimpulkan dari data pada '
      + `${tanggalRagu.map((h) => h.list).join(', ')}. Pipeline mengasumsikan `
      + 'mm/dd/yyyy. Cocokkan beberapa baris dengan form GMP yang sudah tercetak '
      + 'sebelum memuat, sebab urutan yang terbalik menggeser tanggal tanpa '
      + 'menimbulkan galat apa pun.',
    );
  }
  const tanggalBentrok = hasil.filter((h) => h.formatTanggal?.urutan === 'dd/mm/yyyy');
  if (tanggalBentrok.length > 0) {
    catatan.push(
      `PERINGATAN: ${tanggalBentrok.map((h) => h.list).join(', ')} tampak berformat `
      + 'dd/mm/yyyy, sedangkan pipeline membaca mm/dd/yyyy. Ekspor ulang dengan '
      + 'pengaturan regional yang sama, atau pipeline akan salah membaca tanggal.',
    );
  }

  return { siap: !adaHilang && !adaTidakDapat, list: hasil, catatan };
}
