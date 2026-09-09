/**
 * CLI migrasi - Fase 4
 *
 *   node src/migrasi/jalankan.js --sumber <folder> [opsi]
 *
 *     --sumber <folder>   folder berisi hasil export SharePoint (.xlsx / .csv)
 *     --acuan <berkas>    JSON volume per silo dari Power Apps, untuk V-1
 *     --laporan <folder>  tempat menulis laporan pengecualian (bawaan: db/backup)
 *     --verifikasi-saja   hanya menjalankan V-1..V-6, tanpa memuat apa pun
 *     --periksa           hanya memeriksa berkas sumber, tanpa menyentuh DB
 *     --tanpa <list>      lanjutkan walau list itu tidak diekspor (boleh diulang)
 *
 * Migrasi ini IDEMPOTEN (T-23): menjalankannya dua kali menghasilkan keadaan
 * yang sama. Itu bukan kemewahan - dry run wajib diulang tiga kali sebelum
 * cutover (T-21), dan migrasi yang hanya boleh dijalankan sekali tidak dapat
 * memenuhi syarat itu.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { muatSemua } from './muat.js';
import { periksaSumber } from './periksaSumber.js';
import { verifikasiSemua } from './verifikasi.js';
import { pool } from '../db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AKAR = join(__dirname, '..', '..', '..');

function bacaArgumen(argv) {
  const opsi = {
    verifikasiSaja: false,
    periksaSaja: false,
    /**
     * List yang SENGAJA tidak diekspor.
     *
     * Harus disebut satu per satu, bukan disediakan sebagai mode longgar.
     * Melanjutkan tanpa satu list berarti menerima bahwa datanya tidak ikut
     * pindah, dan keputusan sebesar itu tidak boleh menjadi nilai bawaan.
     * Pilihannya tercatat di laporan supaya yang menyetujui cutover
     * melihatnya (T-22).
     */
    tanpa: [],
    laporan: join(AKAR, 'db', 'backup'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sumber') opsi.sumber = argv[++i];
    else if (a === '--acuan') opsi.acuan = argv[++i];
    else if (a === '--laporan') opsi.laporan = argv[++i];
    else if (a === '--verifikasi-saja') opsi.verifikasiSaja = true;
    else if (a === '--periksa') opsi.periksaSaja = true;
    else if (a === '--tanpa') opsi.tanpa.push(argv[++i]);
  }
  return opsi;
}

const kutip = (v) => {
  const t = String(v ?? '');
  return /[",\n;]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
};

/**
 * Laporan pengecualian sebagai CSV.
 *
 * CSV, bukan JSON: yang membacanya adalah orang yang akan memperbaiki datanya
 * di SharePoint, dan ia bekerja dengan menyaring dan mengurutkan kolom.
 */
function laporanCsv(laporan) {
  const kepala = ['list', 'baris_sumber', 'kode', 'sebab', 'rincian'];
  const baris = laporan.pengecualian.map((p) =>
    [
      p.list,
      p.barisSumber ?? '',
      p.kode ?? '',
      p.sebab,
      Array.isArray(p.rincian)
        ? p.rincian.map((r) => (typeof r === 'string' ? r : `${r.kolom}: ${r.pesan}`)).join(' | ')
        : (p.rincian ?? ''),
    ].map(kutip).join(';'),
  );
  return `﻿${kepala.join(';')}\n${baris.join('\n')}\n`;
}

function cetakVerifikasi(v) {
  console.log('\nVerifikasi V-1..V-6');
  console.log('-'.repeat(72));

  for (const h of v.hasil) {
    const tanda = { LULUS: 'OK  ', GAGAL: 'GAGAL', 'PERLU REVIEW': 'TINJAU', 'TIDAK DAPAT DIPERIKSA': '?   ' }[h.status];
    console.log(`  ${tanda.padEnd(7)} ${h.kode}  ${h.judul}`);
    console.log(`          ${h.pesan}`);

    if (h.status !== 'LULUS' && h.bukti?.length) {
      for (const b of h.bukti.slice(0, 5)) {
        console.log(`            ${JSON.stringify(b)}`);
      }
      if (h.bukti.length > 5) console.log(`            ... dan ${h.bukti.length - 5} lainnya`);
    }
  }

  console.log('-'.repeat(72));
  console.log(
    v.bolehCutover
      ? '  Tidak ada kriteria yang GAGAL. Yang berstatus TINJAU perlu disetujui manusia (T-22).'
      : `  ${v.jumlahGagal} kriteria GAGAL. Cutover tidak boleh dijalankan.`,
  );
}

function cetakPemeriksaan(p) {
  console.log('\nPemeriksaan berkas sumber');
  console.log('-'.repeat(72));

  for (const l of p.list) {
    const tanda = {
      LENGKAP: 'OK   ', SEBAGIAN: 'SEBAGIAN', HILANG: 'HILANG',
      'TIDAK DAPAT DIMUAT': 'GAGAL', DILEWATI: 'LEWAT',
    }[l.status];
    console.log(`  ${tanda.padEnd(9)} ${l.list}`);

    if (l.berkas) {
      console.log(`            ${l.berkas}`);
      console.log(`            ${l.jumlahBaris} baris${l.mungkinTerpotong ? '  <- angka bulat, periksa batas view' : ''}`);
    } else {
      console.log(`            ${l.pesan}`);
      continue;
    }

    if (l.kolomWajibHilang?.length) {
      console.log(`            kolom WAJIB tidak ada: ${l.kolomWajibHilang.join(', ')}`);
    }
    if (l.kolomHilang?.length) {
      console.log(`            kolom tidak terekspor: ${l.kolomHilang.join(', ')}`);
    }
    if (l.formatTanggal) {
      console.log(`            tanggal: ${l.formatTanggal.urutan}  contoh: ${l.contohTanggal.join('  ')}`);
    }
  }

  console.log('-'.repeat(72));
  for (const c of p.catatan) console.log(`  * ${c}`);
  console.log(p.siap ? '\n  Sumber siap dimuat.' : '\n  Sumber BELUM siap dimuat.');
}

async function jalankan() {
  const opsi = bacaArgumen(process.argv.slice(2));

  if (opsi.periksaSaja) {
    if (!opsi.sumber) throw new Error('Folder sumber wajib diisi: --sumber <folder>');
    const p = await periksaSumber(resolve(opsi.sumber), opsi.tanpa);
    cetakPemeriksaan(p);
    return p.siap ? 0 : 1;
  }

  let volumeAcuan = null;
  if (opsi.acuan) {
    volumeAcuan = JSON.parse(await readFile(resolve(opsi.acuan), 'utf8'));
    console.log(`Volume acuan dibaca dari ${opsi.acuan} (${Object.keys(volumeAcuan).length} silo)`);
  }

  let laporan = null;

  if (!opsi.verifikasiSaja) {
    if (!opsi.sumber) {
      throw new Error('Folder sumber wajib diisi: --sumber <folder>');
    }

    // Diperiksa lebih dahulu, SELALU. Menemukan kolom yang hilang setelah
    // separuh data termuat berarti keadaan setengah jadi yang harus
    // dibersihkan manual sebelum dapat dicoba lagi.
    const periksa = await periksaSumber(resolve(opsi.sumber), opsi.tanpa);
    cetakPemeriksaan(periksa);
    if (!periksa.siap) {
      console.log('\n  Pemuatan dihentikan. Perbaiki export lebih dahulu.');
      return 1;
    }

    console.log(`\nMemuat dari ${resolve(opsi.sumber)}\n`);
    laporan = await muatSemua(resolve(opsi.sumber), opsi.tanpa);

    console.log('Termuat');
    console.log('-'.repeat(72));
    for (const [k, v] of Object.entries(laporan.ringkasan)) {
      if (k === 'barisSumber') continue;
      const sumber = laporan.ringkasan.barisSumber?.[k];
      console.log(`  ${k.padEnd(20)} ${String(v).padStart(6)}${sumber !== undefined ? ` dari ${sumber} baris sumber` : ''}`);
    }

    if (laporan.jumlah > 0) {
      await mkdir(opsi.laporan, { recursive: true });
      const berkas = join(opsi.laporan, 'laporan_pengecualian.csv');
      await writeFile(berkas, laporanCsv(laporan), 'utf8');

      console.log(`\n  ${laporan.jumlah} pengecualian. Rinciannya di:`);
      console.log(`  ${berkas}`);

      const perSebab = new Map();
      for (const p of laporan.pengecualian) {
        perSebab.set(p.sebab, (perSebab.get(p.sebab) ?? 0) + 1);
      }
      for (const [sebab, n] of [...perSebab].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(5)}  ${sebab}`);
      }
    } else {
      console.log('\n  Tidak ada pengecualian.');
    }
  }

  const v = await verifikasiSemua({ laporan, volumeAcuan });
  cetakVerifikasi(v);

  // Laporan verifikasi disimpan juga: yang menyetujui cutover (T-22) perlu
  // sesuatu yang dapat dilampirkan, bukan tangkapan layar terminal.
  await mkdir(opsi.laporan, { recursive: true });
  await writeFile(
    join(opsi.laporan, 'laporan_verifikasi.json'),
    JSON.stringify({ dijalankan: new Date().toISOString(), ...v }, null, 2),
    'utf8',
  );

  return v.bolehCutover ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  jalankan()
    .then(async (kode) => { await pool.end(); process.exit(kode); })
    .catch(async (err) => {
      console.error(`\nGagal: ${err.message}`);
      await pool.end();
      process.exit(2);
    });
}

export { jalankan, laporanCsv };
