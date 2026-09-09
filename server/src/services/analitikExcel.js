/**
 * Export dashboard analitik ke Excel - FR-27.1.6
 *
 * Yang diekspor adalah ANGKANYA, bukan gambar grafiknya. Grafik menjawab
 * pertanyaan sekilas; berkas yang dibawa ke rapat perlu dapat dihitung ulang,
 * disaring, dan dipivot oleh penerimanya. Gambar tidak dapat.
 *
 * Satu sheet per panel, ditambah satu sheet ringkasan di depan yang memuat
 * rentang, penyaring, dan pertanyaan yang dijawab tiap panel. Tanpa sheet itu,
 * berkas yang dibuka sebulan kemudian tidak memberi tahu ia menggambarkan
 * periode apa.
 */

import ExcelJS from 'exceljs';
import { ringkasan, perhatian, semuaGrafik, GRAFIK } from './analitik.js';

const NAVY = 'FF16265C';
const PUTIH = 'FFFFFFFF';

/** Nama sheet Excel maksimal 31 karakter dan menolak beberapa tanda baca. */
function namaSheet(teks) {
  return teks.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
}

function tulisKepala(ws, kolom) {
  const baris = ws.addRow(kolom.map((k) => k.label));
  baris.eachCell((sel) => {
    sel.font = { bold: true, color: { argb: PUTIH } };
    sel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    sel.alignment = { vertical: 'middle' };
  });
  ws.columns = kolom.map((k) => ({ width: k.lebar ?? 18 }));
  ws.views = [{ state: 'frozen', ySplit: baris.number }];
}

/** Satu panel menjadi satu sheet: judul, pertanyaan, lalu tabelnya. */
function sheetPanel(wb, panel, kolom, baris) {
  const ws = wb.addWorksheet(namaSheet(panel.judul));

  const judul = ws.addRow([panel.judul]);
  judul.font = { bold: true, size: 13, color: { argb: NAVY } };
  const tanya = ws.addRow([panel.pertanyaan]);
  tanya.font = { italic: true, color: { argb: 'FF64748B' } };
  if (panel.siloFilterDiabaikan) {
    const catatan = ws.addRow(['Panel ini tidak dapat disaring per silo, jadi angkanya mencakup seluruh silo.']);
    catatan.font = { color: { argb: 'FFB7791F' } };
  }
  ws.addRow([]);

  tulisKepala(ws, kolom);
  for (const b of baris) ws.addRow(kolom.map((k) => b[k.k] ?? null));
  return ws;
}

const jamTeks = (t) =>
  t ? new Date(t).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '';

/**
 * @param {object} r  keluaran rentang()
 * @param {{siloName?: string}} konteks
 * @returns {Promise<Buffer>}
 */
export async function bangunBerkasAnalitik(r, konteks = {}) {
  const [rk, ph, gr] = [await ringkasan(r), await perhatian(r), await semuaGrafik(r)];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'CMD 1 Operation';
  wb.created = new Date();

  /* ---------- Sheet ringkasan ---------- */
  const ws = wb.addWorksheet('Ringkasan');
  ws.columns = [{ width: 30 }, { width: 24 }, { width: 52 }];

  const judul = ws.addRow(['CMD 1 Operation - Dashboard Analitik']);
  judul.font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.addRow(['Periode', `${r.dariIso} sampai ${r.sampaiIso}`]);
  ws.addRow(['Penyaring silo', konteks.siloName ?? 'Seluruh silo']);
  ws.addRow(['Dibuat', jamTeks(new Date())]);
  ws.addRow([]);

  const kepalaAngka = ws.addRow(['Angka utama', 'Nilai', 'Keterangan']);
  kepalaAngka.eachCell((sel) => {
    sel.font = { bold: true, color: { argb: PUTIH } };
    sel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  });

  const persen = (v) => (v === null || v === undefined ? '' : `${v.toFixed(1)}%`);
  for (const baris of [
    [rk.labelMasuk, rk.penerimaan.ltr, `${rk.penerimaan.jumlah} record · delta ${persen(rk.penerimaan.deltaPersen)}`],
    [rk.labelKeluar, rk.pemakaian.ltr, `${rk.pemakaian.jumlah} record · delta ${persen(rk.pemakaian.deltaPersen)}`],
    ['Tersimpan di silo (L)', rk.saldo.siloLtr, `ditambah ${rk.saldo.bufferLtr} L di buffer`],
    ['Utilisasi kapasitas', rk.utilisasi.persen, `${rk.utilisasi.terisiLtr} dari ${rk.utilisasi.kapasitasLtr} L`],
    ['Rata-rata TS', rk.mutu.rataTs, 'mutu susu masuk'],
  ]) ws.addRow(baris);

  ws.addRow([]);
  const kepalaPanel = ws.addRow(['Panel', 'Sheet', 'Pertanyaan yang dijawab']);
  kepalaPanel.eachCell((sel) => {
    sel.font = { bold: true, color: { argb: PUTIH } };
    sel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
  });
  for (const [kunci, def] of Object.entries(GRAFIK)) {
    ws.addRow([def.judul, namaSheet(def.judul), def.pertanyaan]);
  }

  /* ---------- Sheet perhatian ---------- */
  const wsP = wb.addWorksheet('Perlu ditindak');
  const judulP = wsP.addRow(['Perlu ditindak']);
  judulP.font = { bold: true, size: 13, color: { argb: NAVY } };
  wsP.addRow([]);
  tulisKepala(wsP, [
    { k: 'panel', label: 'Panel', lebar: 24 },
    { k: 'entitas', label: 'Entitas', lebar: 22 },
    { k: 'rincian', label: 'Rincian', lebar: 56 },
  ]);

  const tambahP = (panel, daftar, keEntitas, keRincian) => {
    if (daftar.length === 0) {
      wsP.addRow([panel, '-', 'Bersih, tidak ada temuan']);
      return;
    }
    for (const d of daftar) wsP.addRow([panel, keEntitas(d), keRincian(d)]);
  };

  tambahP('Silo lewat jadwal cek', ph.lewatJadwal, (d) => d.siloName,
    (d) => `interval ${d.intervalJam} jam · terakhir dicek ${jamTeks(d.cekTerakhir)}`);
  tambahP('Penyimpangan OPRP', ph.oprp, (d) => d.kode,
    (d) => `${d.siloName} · ${d.tempAfterHeater} C (ambang ${d.ambang}) · ${jamTeks(d.waktu)}`);
  tambahP('pH di luar rentang', ph.ph, (d) => d.siloName,
    (d) => `pH ${d.ph} · ${jamTeks(d.waktu)}`);
  tambahP('Standing time', ph.standingTime, (d) => d.siloName,
    (d) => `${Math.round(d.menit / 60)} jam · ${d.volumeLtr} L`);
  tambahP('Draft belum lengkap', ph.draft, (d) => d.kode,
    (d) => `${d.modul} · dibuat ${jamTeks(d.dibuat)}`);
  tambahP('Menunggu approval', ph.antrean, (d) => d.modul,
    (d) => `${d.jumlah} record · tertua ${d.usiaTertuaJam ?? 0} jam`);

  /* ---------- Sheet per panel ---------- */
  const deretKeBaris = (g) =>
    g.seri.flatMap((sr) =>
      sr.titik.map((t) => ({
        seri: t.siloName ?? sr.label,
        waktu: jamTeks(t.waktu),
        nilai: t.nilai,
        catatan: t.kritis ? 'di bawah ambang' : '',
      })),
    );

  const kolomDeret = (satuan) => [
    { k: 'seri', label: 'Seri', lebar: 16 },
    { k: 'waktu', label: 'Waktu', lebar: 22 },
    { k: 'nilai', label: `Nilai (${satuan || '-'})`, lebar: 14 },
    { k: 'catatan', label: 'Catatan', lebar: 20 },
  ];

  sheetPanel(wb, gr['neraca-harian'], [
    { k: 'label', label: 'Tanggal', lebar: 14 },
    { k: 'masuk', label: `${gr['neraca-harian'].seri[0].label} (L)`, lebar: 20 },
    { k: 'keluar', label: `${gr['neraca-harian'].seri[1].label} (L)`, lebar: 20 },
  ], gr['neraca-harian'].data);

  /*
   * Frekuensi record - jumlah input, bukan volume.
   *
   * Ikut diunduh karena inilah satu-satunya panel yang menjawab beban kerja:
   * dua puluh penerimaan kecil dan dua penerimaan besar dapat berjumlah liter
   * yang sama, tetapi yang pertama berarti dua puluh kali input.
   *
   * Kolom Total ditulis di sini, bukan dihitung di dalam Excel dengan rumus:
   * berkas ini juga dibaca lewat pengurai lain saat diaudit, dan rumus yang
   * belum dihitung terbaca sebagai sel kosong.
   */
  sheetPanel(wb, gr['frekuensi-record'], [
    { k: 'label', label: 'Tanggal', lebar: 14 },
    { k: 'Penerimaan', label: 'Penerimaan (record)', lebar: 20 },
    { k: 'Transfer produksi', label: 'Transfer produksi (record)', lebar: 24 },
    { k: 'Pindah silo', label: 'Pindah silo (record)', lebar: 20 },
    { k: 'Prepast', label: 'Total Prepast (sesi)', lebar: 22 },
    { k: 'volumePrepastLtr', label: 'Volume Prepast (L)', lebar: 22 },
    { k: 'total', label: 'Total (record)', lebar: 16 },
  ], gr['frekuensi-record'].data.map((d) => ({
    ...d,
    total: d.Penerimaan + d['Transfer produksi'] + d['Pindah silo'] + d.Prepast,
  })));

  const wsSesi = wb.addWorksheet('Audit Sesi Prepast');
  tulisKepala(wsSesi, [
    { k: 'sesi', label: 'Sesi', lebar: 24 },
    { k: 'silo', label: 'Silo', lebar: 14 },
    { k: 'record', label: 'Record Prepast', lebar: 22 },
    { k: 'receiving', label: 'Receiving', lebar: 22 },
    { k: 'supplier', label: 'Supplier', lebar: 28 },
    { k: 'mulai', label: 'Mulai', lebar: 22 },
    { k: 'selesai', label: 'Selesai', lebar: 22 },
    { k: 'volume', label: 'Volume (L)', lebar: 16 },
    { k: 'totalSesi', label: 'Total Sesi (L)', lebar: 18 },
  ]);
  for (const sesi of gr['frekuensi-record'].sesiPrepast ?? []) {
    for (const [indeks, record] of sesi.records.entries()) {
      wsSesi.addRow([
        sesi.id, sesi.siloName, record.kode, record.receivingKode,
        record.supplierName, jamTeks(record.start), jamTeks(record.finish),
        record.volumeLtr, indeks === 0 ? sesi.volumeLtr : null,
      ]);
    }
  }

  sheetPanel(wb, gr['pola-jam'], [
    { k: 'hari', label: 'Hari', lebar: 10 },
    { k: 'jam', label: 'Jam', lebar: 8 },
    { k: 'jumlah', label: 'Jumlah penerimaan', lebar: 20 },
    { k: 'ltr', label: 'Volume (L)', lebar: 14 },
  ], gr['pola-jam'].data.map((d) => ({ ...d, hari: gr['pola-jam'].hari[d.hariIndeks] })));

  sheetPanel(wb, gr['aktivitas-silo'], [
    { k: 'label', label: 'Silo', lebar: 14 },
    { k: 'masuk', label: 'Prepast masuk (L)', lebar: 20 },
    { k: 'keluar', label: 'Transfer keluar (L)', lebar: 20 },
  ], gr['aktivitas-silo'].data);

  for (const kunci of ['suhu-silo', 'ph-silo', 'oprp', 'temp-output']) {
    sheetPanel(wb, gr[kunci], kolomDeret(gr[kunci].satuan), deretKeBaris(gr[kunci]));
  }

  sheetPanel(wb, gr['ts-supplier'], [
    { k: 'label', label: 'Supplier', lebar: 30 },
    { k: 'nilai', label: 'Rata-rata TS (%)', lebar: 18 },
    { k: 'jumlah', label: 'Jumlah penerimaan', lebar: 20 },
  ], gr['ts-supplier'].data);

  sheetPanel(wb, gr['volume-supplier'], [
    { k: 'label', label: 'Supplier', lebar: 30 },
    { k: 'nilai', label: 'Volume (L)', lebar: 16 },
    { k: 'jumlah', label: 'Jumlah penerimaan', lebar: 20 },
  ], gr['volume-supplier'].data);

  sheetPanel(wb, gr['standing-time'], [
    { k: 'label', label: 'Silo', lebar: 14 },
    { k: 'nilai', label: 'Standing time (jam)', lebar: 20 },
    { k: 'volumeLtr', label: 'Volume (L)', lebar: 16 },
  ], gr['standing-time'].data);

  sheetPanel(wb, gr['tujuan-transfer'], [
    { k: 'label', label: 'Tanggal', lebar: 14 },
    { k: 'CMD1', label: 'CMD1 (L)', lebar: 14 },
    { k: 'CMD2', label: 'CMD2 (L)', lebar: 14 },
    { k: 'Pindah silo', label: 'Pindah silo (L)', lebar: 18 },
  ], gr['tujuan-transfer'].data);

  sheetPanel(wb, gr['waktu-tunggu-approval'], [
    { k: 'label', label: 'Modul', lebar: 18 },
    { k: 'nilai', label: 'Rata-rata tunggu (jam)', lebar: 22 },
    { k: 'maksJam', label: 'Terlama (jam)', lebar: 16 },
    { k: 'jumlah', label: 'Jumlah record', lebar: 16 },
  ], gr['waktu-tunggu-approval'].data);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Nama berkas yang menyebut periode dan penyaringnya. */
export function namaBerkasAnalitik(r, konteks = {}) {
  const padat = (t) => t.replaceAll('-', '');
  const silo = konteks.siloName ? `_${konteks.siloName.replace(/[^A-Za-z0-9]/g, '')}` : '';
  return r.dariIso === r.sampaiIso
    ? `Analitik_${padat(r.dariIso)}${silo}.xlsx`
    : `Analitik_${padat(r.dariIso)}_sd_${padat(r.sampaiIso)}${silo}.xlsx`;
}
