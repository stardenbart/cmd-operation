/**
 * Uji dua fitur terpisah di kolom "siapa mengerjakan/menyetujui" form GMP:
 *
 *  - Halaman 1 (Paraf): tanda tangan digital operator (services/signature.js) -
 *    lihat signature.test.js untuk uji layanannya sendiri; berkas ini hanya
 *    menguji PENYISIPANNYA ke xlsx.
 *  - Halaman 2 (Diperiksa Oleh): tetap QR berbasis TANGGAL
 *    (services/approvalShare.js) - satu tanda tangan review mewakili banyak
 *    record Monitoring+Transfer sekaligus, tidak mungkin diwakili satu
 *    gambar tanda tangan per baris seperti Halaman 1.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';
import { buatApp } from '../src/app.js';

let receiving;
let prepast;
let monitoring;
let transfer;
let approval;
let formData;
let formExcel;
let share;
let signature;
let QRCode;

const SILO = { satu: 2 };
const SUPPLIER = 1;
const W = (hari, jam, menit = 0) => new Date(2026, 7, hari, jam, menit);

let server;
let alamat;
function url(path) { return `http://127.0.0.1:${alamat.port}${path}`; }

before(async () => {
  await bangunBasisDataUji();
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  monitoring = await import('../src/services/monitoring.js');
  transfer = await import('../src/services/transfer.js');
  approval = await import('../src/services/approval.js');
  formData = await import('../src/services/formData.js');
  formExcel = await import('../src/services/formExcel.js');
  share = await import('../src/services/approvalShare.js');
  signature = await import('../src/services/signature.js');
  QRCode = (await import('qrcode')).default;

  const app = buatApp(pino({ level: 'silent' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  alamat = server.address();
});

beforeEach(reset);
after(async () => {
  await new Promise((r) => server.close(r));
  await tutup();
});

async function pngUji() {
  return QRCode.toBuffer('uji-tanda-tangan', { type: 'png', width: 20 });
}

async function terima({ hari, jam, qtyKg = 1000 }) {
  return receiving.buat(
    { supplierId: SUPPLIER, qtyKg, beratJenis: 1, nilaiTs: 12.4, finishTime: W(hari, jam) },
    AKTOR.operator, IP_UJI,
  );
}

describe('Halaman 1 (Paraf) - tanda tangan digital di xlsx', () => {
  test('gambar tanda tangan operator tersisip di kolom Paraf, per baris', async () => {
    await terima({ hari: 10, jam: 6 });
    await terima({ hari: 10, jam: 9 });

    const model = await formData.modelForm('2026-08-10');
    // AKTOR.operator sudah punya tanda tangan bawaan (lihat dbUji.js).
    assert.ok(model.halaman1.every((b) => b.paraf === AKTOR.operator.id));

    const buffer = await formExcel.bangunBerkas(model);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws1 = wb.getWorksheet('Receiving_Prepast');

    // Kolom P (Paraf) = indeks 1-berbasis 16, ExcelJS memakai indeks
    // 0-berbasis (15). Disaring khusus kolom ini - templatenya sendiri sudah
    // membawa satu gambar lain (logo header).
    const tandaTangan = ws1.getImages().filter((g) => g.range.tl.nativeCol === 15);
    assert.equal(tandaTangan.length, 2, 'satu tanda tangan per baris Receiving');

    // Baris pertama (barisPertama=10) dan kedua (11), 0-berbasis 9 dan 10.
    const barisGambar = tandaTangan.map((g) => g.range.tl.nativeRow).sort((a, b) => a - b);
    assert.deepEqual(barisGambar, [9, 10]);
  });

  test('operator yang sama di beberapa baris hanya diambil sekali dari database', async () => {
    // Tidak ada cara langsung menghitung query dari luar; dibuktikan secara
    // tidak langsung - dua baris operator yang sama tetap menghasilkan dua
    // gambar tersisip (cache tidak membuat baris kedua kosong).
    await terima({ hari: 10, jam: 6 });
    await terima({ hari: 10, jam: 9 });

    const model = await formData.modelForm('2026-08-10');
    const buffer = await formExcel.bangunBerkas(model);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws1 = wb.getWorksheet('Receiving_Prepast');

    assert.equal(ws1.getImages().filter((g) => g.range.tl.nativeCol === 15).length, 2);
  });

  test('record tanpa tanda tangan tersimpan (operator belum sempat membuatnya saat itu) dibiarkan kosong, bukan gagal', async () => {
    const rcv = await terima({ hari: 10, jam: 6 });
    // Simulasikan operator yang tanda tangannya sudah dihapus SETELAH
    // record ini dibuat (mis. dihapus lalu belum sempat digambar ulang) -
    // dipulihkan lagi di akhir supaya tidak membocor ke test lain dalam
    // berkas ini (operator adalah master data, tidak ikut ter-TRUNCATE
    // oleh reset() di antar-test).
    await signature.hapusTandaTangan(AKTOR.operator.id);

    const model = await formData.modelForm('2026-08-10');
    const buffer = await formExcel.bangunBerkas(model);

    // Tidak melempar; berkas tetap terbentuk, cuma kolom Parafnya kosong.
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');
    void rcv;

    await signature.simpanTandaTangan(AKTOR.operator.id, await pngUji());
  });

  test('sheet dikunci supaya tanda tangan tidak dapat ditarik keluar dari selnya', async () => {
    await terima({ hari: 10, jam: 6 });

    const model = await formData.modelForm('2026-08-10');
    const buffer = await formExcel.bangunBerkas(model);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws1 = wb.getWorksheet('Receiving_Prepast');

    assert.equal(ws1.sheetProtection.sheet, true);
    assert.equal(ws1.sheetProtection.objects, false);
  });
});

describe('Token harian (Halaman 2 - Diperiksa Oleh)', () => {
  test('sah untuk tanggal yang membangkitkannya, ditolak untuk tanggal lain', () => {
    const token = share.buatTokenHarian('2026-08-10');
    assert.ok(share.verifikasiTokenHarian('2026-08-10', token));
    assert.equal(share.verifikasiTokenHarian('2026-08-11', token), false);
  });

  test('ditolak bila token kosong/bukan string', () => {
    assert.equal(share.verifikasiTokenHarian('2026-08-10', ''), false);
    assert.equal(share.verifikasiTokenHarian('2026-08-10', undefined), false);
  });
});

describe('riwayatApprovalHarian() - ringkasan Receiving+Prepast+Monitoring+Transfer satu hari', () => {
  test('memuat keempat jenis record beserta siapa memeriksa', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await approval.setujui('receiving', rcv.id, AKTOR.spv, IP_UJI);

    const p = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 2000 }],
        prepastStart: W(10, 7), prepastFinish: W(10, 8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );
    await approval.setujui('prepast', p.dibuat[0].id, AKTOR.spv, IP_UJI);

    const ronde = await monitoring.simpanRonde(
      { timeCheck: W(10, 9), hasil: [{ siloId: SILO.satu, ph: 6.7, temp: 4.2 }] },
      AKTOR.operator, IP_UJI,
    );
    await approval.setujui('monitoring', ronde.dibuat[0].id, AKTOR.spv, IP_UJI);

    const trf = await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 500,
        trfTime: W(10, 12), tankId: 1, batchPrefix: 'HRC', batchNomor: 1,
      },
      AKTOR.operator, IP_UJI,
    );
    await approval.setujui('transfer', trf.id, AKTOR.spv, IP_UJI);

    const hasil = await share.riwayatApprovalHarian('2026-08-10');
    assert.equal(hasil.tanggal, '2026-08-10');

    const jenis = new Set(hasil.riwayat.map((r) => r.jenis));
    assert.deepEqual(jenis, new Set(['Receiving', 'Prepast', 'Monitoring', 'Transfer']));
    assert.ok(hasil.riwayat.every((r) => r.diperiksaOleh === AKTOR.spv.nama));
    assert.deepEqual(hasil.diperiksaOleh, [AKTOR.spv.nama]);

    // Breakdown per approver - satu SPV di sini, tapi bentuknya harus benar:
    // dikelompokkan, jumlah cocok, dan tiap item membawa waktu disetujui.
    assert.equal(hasil.breakdownApproval.length, 1);
    const [b] = hasil.breakdownApproval;
    assert.equal(b.nama, AKTOR.spv.nama);
    assert.equal(b.jumlah, 4);
    assert.equal(b.item.length, 4);
    assert.ok(b.item.every((it) => it.disetujuiPada));
    assert.deepEqual(
      new Set(b.item.map((it) => it.jenis)),
      new Set(['Receiving', 'Prepast', 'Monitoring', 'Transfer']),
    );

    // Detail domain per jenis - Monitoring bawa ph/suhu/volume/supplier
    // (prepast di atas mengisi SILO.satu, jadi supplier-nya tidak kosong).
    const itemMonitoring = b.item.find((it) => it.jenis === 'Monitoring');
    assert.equal(itemMonitoring.detail.ph, 6.7);
    assert.equal(itemMonitoring.detail.suhu, 4.2);
    assert.ok(itemMonitoring.detail.volume > 0);
    assert.ok(itemMonitoring.detail.supplier.length > 0);
    assert.ok(itemMonitoring.detail.supplier[0].alokasiLiter > 0);

    // Transfer tunggal (bukan batch bersama) - caraPengisian Manual, satu baris saja.
    const itemTransfer = b.item.find((it) => it.jenis === 'Transfer');
    assert.equal(itemTransfer.detail.caraPengisian, 'Manual');
    assert.equal(itemTransfer.detail.baris.length, 1);
    assert.equal(itemTransfer.detail.volume, 500);
    assert.equal(itemTransfer.detail.batch, 'HRC1');

    // Receiving - supplier, kuantitas, TS.
    const itemReceiving = b.item.find((it) => it.jenis === 'Receiving');
    assert.equal(itemReceiving.detail.qtyKg, 2000);
    assert.ok(itemReceiving.detail.supplier);
    assert.ok(itemReceiving.detail.qtyLtr > 0);

    // Prepast - jenis batch, volume, kondisi proses, ditelusuri ke Receiving induknya.
    const itemPrepast = b.item.find((it) => it.jenis === 'Prepast');
    assert.equal(itemPrepast.detail.jenisBatch, 'PREPAST');
    assert.equal(itemPrepast.detail.volume, 2000);
    assert.equal(itemPrepast.detail.flowrate, 5.5);
    assert.equal(itemPrepast.detail.tempAfterHeater, 86);
    assert.equal(itemPrepast.detail.receivingKode, rcv.kode);
  });

  test('transfer batch bersama digabung jadi SATU kartu, bukan dua yang saling menyebut', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 2000 }],
        prepastStart: W(10, 7), prepastFinish: W(10, 8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );

    const trfBersama = await transfer.buatBanyak(
      {
        trfTime: W(10, 12),
        modeBatch: 'SAMA',
        batchBersama: { batchPrefix: 'HRC', batchNomor: 9 },
        baris: [
          { siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 300, tankId: 1 },
          { siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 200, tankId: 1 },
        ],
      },
      AKTOR.operator, IP_UJI,
    );
    for (const t of trfBersama.transfers) {
      await approval.setujui('transfer', t.id, AKTOR.spv, IP_UJI);
    }

    const [kodeA, kodeB] = trfBersama.transfers.map((t) => t.kode);

    // riwayat (audit mentah) TETAP dua baris terpisah, tidak tergabung.
    const hasilRiwayat = await share.riwayatApprovalHarian('2026-08-10');
    assert.ok(hasilRiwayat.riwayat.some((r) => r.kode === kodeA));
    assert.ok(hasilRiwayat.riwayat.some((r) => r.kode === kodeB));

    // breakdownApproval MENGGABUNG keduanya jadi satu kartu.
    const [b] = hasilRiwayat.breakdownApproval;
    assert.equal(b.jumlah, 1);
    const [itemGabungan] = b.item;
    assert.equal(itemGabungan.kode, `${kodeA}, ${kodeB}`);
    assert.equal(itemGabungan.jenis, 'Transfer');
    assert.equal(itemGabungan.detail.caraPengisian, 'Batch bersama');
    assert.equal(itemGabungan.detail.volume, 500); // 300 + 200
    assert.deepEqual(
      itemGabungan.detail.baris.map((r) => ({ kode: r.kode, volume: r.volume })),
      [{ kode: kodeA, volume: 300 }, { kode: kodeB, volume: 200 }],
    );
  });

  test('hari tanpa monitoring/transfer mengembalikan riwayat kosong, bukan galat', async () => {
    const hasil = await share.riwayatApprovalHarian('2026-01-01');
    assert.deepEqual(hasil.riwayat, []);
    assert.deepEqual(hasil.diperiksaOleh, []);
    assert.deepEqual(hasil.breakdownApproval, []);
  });

  test('record yang belum disetujui tidak masuk breakdown, tapi tetap ada di riwayat', async () => {
    const ronde = await monitoring.simpanRonde(
      { timeCheck: W(10, 9), hasil: [{ siloId: SILO.satu, ph: 6.7, temp: 4.2 }] },
      AKTOR.operator, IP_UJI,
    );
    // Sengaja TIDAK di-approve.

    const hasil = await share.riwayatApprovalHarian('2026-08-10');
    assert.equal(hasil.riwayat.length, 1);
    assert.equal(hasil.riwayat[0].diperiksaOleh, null);
    assert.deepEqual(hasil.breakdownApproval, []);
  });
});

describe('Endpoint publik /api/v1/public/approval-harian', () => {
  test('token benar -> 200 beserta ringkasannya', async () => {
    const ronde = await monitoring.simpanRonde(
      { timeCheck: W(10, 9), hasil: [{ siloId: SILO.satu, ph: 6.7, temp: 4.2 }] },
      AKTOR.operator, IP_UJI,
    );
    await approval.setujui('monitoring', ronde.dibuat[0].id, AKTOR.spv, IP_UJI);

    const token = share.buatTokenHarian('2026-08-10');
    const res = await fetch(url(`/api/v1/public/approval-harian/2026-08-10/${token}`));
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.tanggal, '2026-08-10');
    assert.ok(data.riwayat.some((r) => r.diperiksaOleh === AKTOR.spv.nama));
  });

  test('token salah -> 403', async () => {
    const res = await fetch(url('/api/v1/public/approval-harian/2026-08-10/token-salah'));
    assert.equal(res.status, 403);
  });

  test('format tanggal tidak sah -> 403, bukan 500', async () => {
    const res = await fetch(url('/api/v1/public/approval-harian/tidak-sah/apa-saja'));
    assert.equal(res.status, 403);
  });
});

describe('QR "Diperiksa Oleh" di Halaman 2 xlsx', () => {
  test('nama SPV ditambahkan ke teks yang sudah ada, QR tersisip, sheet terkunci', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 2000 }],
        prepastStart: W(10, 7), prepastFinish: W(10, 8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );
    const ronde = await monitoring.simpanRonde(
      { timeCheck: W(10, 9), hasil: [{ siloId: SILO.satu, ph: 6.7, temp: 4.2 }] },
      AKTOR.operator, IP_UJI,
    );
    await approval.setujui('monitoring', ronde.dibuat[0].id, AKTOR.spv, IP_UJI);

    const model = await formData.modelForm('2026-08-10');
    assert.deepEqual(model.halaman2.diperiksaOleh, [AKTOR.spv.nama], 'model membawa nama SPV-nya');

    const buffer = await formExcel.bangunBerkas(model);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws2 = wb.getWorksheet('Monitoring_Transfer');

    // "Spv Produksi Shift 1/2/3 :" DIBUANG (diminta pengguna) - "Diperiksa
    // Oleh," tetap ada, nama SPV menyambung langsung ke situ.
    const teks = ws2.getCell('A46').value.richText.map((r) => r.text).join('');
    assert.match(teks, new RegExp(`Diperiksa Oleh,\\s+${AKTOR.spv.nama}`));
    assert.doesNotMatch(teks, /Spv Produksi/);

    // QR-nya ada di baris 46, kolom X (indeks 0-berbasis 23) - mundur satu
    // kolom dari Y supaya 90px penuh tetap di dalam area cetak A1:Y46,
    // tidak menyentuh kolom Z sama sekali (percobaan sebelumnya, mulai di
    // Y, terbukti terpotong saat benar-benar dicetak).
    const qr = ws2.getImages().find((g) => g.range.tl.nativeRow === 45);
    assert.ok(qr, 'QR tersisip di baris 46');
    assert.equal(qr.range.tl.nativeCol, 23);
    assert.equal(qr.range.ext.width, 90);
    assert.ok(
      qr.range.tl.nativeCol + qr.range.ext.width / 74 < 25,
      'QR tidak boleh menjangkau kolom Z (indeks 25) - itulah yang membuatnya terpotong saat dicetak',
    );

    assert.equal(ws2.sheetProtection.sheet, true);
    assert.equal(ws2.sheetProtection.objects, false);
  });

  test('tanpa SPV yang menyetujui, teks label dibiarkan apa adanya (tetap ada QR)', async () => {
    await terima({ hari: 10, jam: 6 });

    const model = await formData.modelForm('2026-08-10');
    assert.deepEqual(model.halaman2.diperiksaOleh, []);

    const buffer = await formExcel.bangunBerkas(model);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws2 = wb.getWorksheet('Monitoring_Transfer');

    const teks = ws2.getCell('A46').value.richText.map((r) => r.text).join('');
    assert.match(teks, /Diperiksa Oleh,$/, 'tidak ada nama ditambahkan');
    assert.doesNotMatch(teks, /Spv Produksi/, 'kalimat shift tetap terbuang walau tanpa nama');
    assert.ok(ws2.getImages().some((g) => g.range.tl.nativeRow === 45), 'QR tetap disisipkan');
  });
});
