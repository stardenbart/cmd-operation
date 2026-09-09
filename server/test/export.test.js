/**
 * Uji integrasi model form GMP - F3-3, FR-12, FR-28
 *
 * Yang diuji di sini bukan tata letaknya (itu di `formLayout.test.js`),
 * melainkan SELEKSI datanya: hari mana yang memuat baris mana. Aturan itu
 * ditegaskan pemilik proses dan tidak dapat disimpulkan dari kode lama, sebab
 * flow lama justru memprefilter prepast tiga hari.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let receiving;
let prepast;
let transfer;
let monitoring;
let formData;
let formExcel;
let formZip;

const SILO = { buffer: 1, satu: 2, dua: 3, enam: 7, duaLimaA: 8 };
const SUPPLIER = 1;

/** Waktu setempat yang tetap; uji tidak boleh bergantung pada saat dijalankan. */
const W = (hari, jam, menit = 0) => new Date(2026, 7, hari, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  transfer = await import('../src/services/transfer.js');
  monitoring = await import('../src/services/monitoring.js');
  formData = await import('../src/services/formData.js');
  formExcel = await import('../src/services/formExcel.js');
  formZip = await import('../src/services/formZip.js');
});

beforeEach(reset);
after(tutup);

async function terima({ hari, jam, menit = 0, qtyKg = 1000 }) {
  return receiving.buat(
    {
      supplierId: SUPPLIER,
      qtyKg,
      beratJenis: 1,
      nilaiTs: 12.4,
      finishTime: W(hari, jam, menit),
    },
    AKTOR.operator,
    IP_UJI,
  );
}

async function prepastKe(receivingId, pecahan, { hari, jamMulai, jamSelesai }) {
  return prepast.buat(
    {
      receivingId,
      pecahan,
      prepastStart: W(hari, jamMulai),
      prepastFinish: W(hari, jamSelesai),
      flowrate: 5.5,
      tempAfterHeater: 86,
      tempOutput: 4,
    },
    AKTOR.operator,
    IP_UJI,
  );
}

describe('Tanggal patokan adalah waktu selesai penerimaan', () => {
  /**
   * Kasus yang ditegaskan pemilik proses: penerimaan selesai 10 Agustus 23.30,
   * prepastnya baru dikerjakan 11 Agustus 01.00. Barisnya milik form
   * 10 Agustus, lengkap dengan jam prepast 01.00.
   */
  test('prepast pada hari berikutnya tetap terbit di hari penerimaannya', async () => {
    const rcv = await terima({ hari: 10, jam: 23, menit: 30 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
      hari: 11, jamMulai: 1, jamSelesai: 2,
    });

    const tanggal10 = await formData.modelForm('2026-08-10');
    assert.equal(tanggal10.halaman1.length, 1, 'terbit di 10 Agustus');
    assert.equal(tanggal10.halaman1[0].kode, rcv.kode);
    assert.equal(tanggal10.halaman1[0].terimaSelesai.jam, 23);
    assert.equal(tanggal10.halaman1[0].terimaSelesai.menit, 30);

    // Jam prepastnya ikut, meski jatuh pada tanggal berikutnya
    assert.equal(tanggal10.halaman1[0].prepastMulai.jam, 1);
    assert.equal(tanggal10.halaman1[0].prepastSelesai.jam, 2);
    assert.equal(tanggal10.halaman1[0].volumeLtr, 1000);

    const tanggal11 = await formData.modelForm('2026-08-11');
    assert.equal(tanggal11.halaman1.length, 0, 'TIDAK terbit lagi di 11 Agustus');
  });

  /**
   * Celah B-29 pada flow lama: prefilter tiga hari membuang prepast yang
   * dikerjakan lebih dari sehari setelah penerimaan, misalnya batch yang
   * menginap di buffer, sehingga baris formnya terbit dengan kolom prepast
   * kosong.
   */
  test('prepast tiga hari setelah penerimaan tetap terbaca - B-29', async () => {
    const rcv = await terima({ hari: 10, jam: 8 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
      hari: 13, jamMulai: 9, jamSelesai: 10,
    });

    const model = await formData.modelForm('2026-08-10');
    assert.equal(model.halaman1.length, 1);
    assert.equal(model.halaman1[0].jumlahPecahan, 1, 'prepastnya tidak boleh luput');
    assert.equal(model.halaman1[0].prepastMulai.jam, 9);
  });

  test('penerimaan tepat tengah malam masuk ke hari itu, bukan hari sebelumnya', async () => {
    await terima({ hari: 10, jam: 0, menit: 0 });

    assert.equal((await formData.modelForm('2026-08-10')).halaman1.length, 1);
    assert.equal((await formData.modelForm('2026-08-09')).halaman1.length, 0);
  });

  test('penerimaan 23.59 masuk ke hari itu, bukan hari berikutnya', async () => {
    await terima({ hari: 10, jam: 23, menit: 59 });

    assert.equal((await formData.modelForm('2026-08-10')).halaman1.length, 1);
    assert.equal((await formData.modelForm('2026-08-11')).halaman1.length, 0);
  });

  test('baris diurutkan menurut waktu selesai penerimaan', async () => {
    await terima({ hari: 10, jam: 15 });
    await terima({ hari: 10, jam: 6 });
    await terima({ hari: 10, jam: 20 });

    const model = await formData.modelForm('2026-08-10');
    const jam = model.halaman1.map((b) => b.terimaSelesai.jam);
    assert.deepEqual(jam, [6, 15, 20]);
    assert.deepEqual(model.halaman1.map((b) => b.nomor), [1, 2, 3]);
  });
});

describe('Penggabungan prepast multi-silo', () => {
  test('volume dijumlahkan dan daftar silo disambung', async () => {
    const rcv = await terima({ hari: 10, jam: 8, qtyKg: 3000 });
    await prepastKe(rcv.id, [
      { siloId: SILO.satu, volumeLtr: 1000 },
      { siloId: SILO.dua, volumeLtr: 500 },
    ], { hari: 10, jamMulai: 9, jamSelesai: 10 });

    const model = await formData.modelForm('2026-08-10');
    const baris = model.halaman1[0];
    assert.equal(baris.volumeLtr, 1500);
    assert.equal(baris.silo, 'SILO1/2');
    assert.equal(baris.jumlahPecahan, 2);
  });

  /** B-24: flow lama menyambung tanpa dedupe, menghasilkan `SILO25A/25A`. */
  test('silo yang sama tidak ditulis dua kali - B-24', async () => {
    const rcv = await terima({ hari: 10, jam: 8, qtyKg: 3000 });
    await prepastKe(rcv.id, [{ siloId: SILO.duaLimaA, volumeLtr: 1000 }], {
      hari: 10, jamMulai: 9, jamSelesai: 10,
    });
    await prepastKe(rcv.id, [{ siloId: SILO.duaLimaA, volumeLtr: 800 }], {
      hari: 10, jamMulai: 11, jamSelesai: 12,
    });

    const model = await formData.modelForm('2026-08-10');
    const baris = model.halaman1[0];
    assert.equal(baris.silo, 'SILO25A', 'bukan SILO25A/25A');
    assert.equal(baris.volumeLtr, 1800, 'volumenya tetap dijumlahkan');
    assert.equal(baris.jumlahPecahan, 2);
  });

  test('nilai pertama yang tidak kosong dipakai untuk waktu dan suhu', () => {
    const gabungan = formData.gabungPrepast([
      { vol_prepast_ltr: 100, prepast_start: null, flowrate_pst: null, silo_kode: '1' },
      { vol_prepast_ltr: 200, prepast_start: new Date(2026, 7, 10, 9), flowrate_pst: 5.5, silo_kode: '2' },
    ]);

    assert.equal(gabungan.volumeLtr, 300);
    assert.equal(gabungan.prepastMulai.jam, 9, 'melewati yang kosong');
    assert.equal(gabungan.flowrate, 5.5);
  });

  test('batch tanpa prepast menghasilkan kolom kosong, bukan nol', () => {
    const gabungan = formData.gabungPrepast([]);
    assert.equal(gabungan.volumeLtr, null);
    assert.equal(gabungan.silo, null);
    assert.equal(gabungan.jumlahPecahan, 0);
  });
});

describe('Blok pemakaian hanya memuat pemakaian produksi - B-23', () => {
  /**
   * Flow lama menulis `type eq 'PEMAKAIAN PRODUKSI' and status eq 'Approved'
   * or status eq 'Pending Approval'`. Karena `and` mengikat lebih kuat,
   * PINDAH SILO yang masih pending ikut terbit sebagai pemakaian, sehingga
   * total pemakaian pada form kelebihan sebesar setiap pindah silo.
   */
  test('pindah silo tidak masuk blok pemakaian, tetapi masuk catatan', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 2000 }], {
      hari: 10, jamMulai: 7, jamSelesai: 8,
    });

    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PINDAH SILO', volumeLtr: 500,
        trfTime: W(10, 12), siloTujuanId: SILO.enam,
      },
      AKTOR.operator, IP_UJI,
    );
    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 400,
        trfTime: W(10, 14), tankId: 1, batchPrefix: 'HRC', batchNomor: 1,
      },
      AKTOR.operator, IP_UJI,
    );

    const model = await formData.modelForm('2026-08-10');
    const semuaSlot = model.halaman2.transfer.flatMap((s) => s.slot);

    assert.equal(semuaSlot.length, 1, 'hanya pemakaian produksi yang masuk blok');
    assert.equal(semuaSlot[0].volume, 400);
    assert.equal(model.catatan.pindahSilo.length, 1, 'pindah silo masuk catatan (D-16)');
    assert.equal(model.catatan.pindahSilo[0].volumeLtr, 500);
  });

  test('transfer dikelompokkan menurut silo asal dan diurutkan waktu', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 4000 });
    await prepastKe(rcv.id, [
      { siloId: SILO.satu, volumeLtr: 1500 },
      { siloId: SILO.dua, volumeLtr: 1500 },
    ], { hari: 10, jamMulai: 7, jamSelesai: 8 });

    for (const [silo, jam, nomor] of [[SILO.dua, 16, 3], [SILO.satu, 14, 1], [SILO.satu, 15, 2]]) {
      await transfer.buat(
        {
          siloAsalId: silo, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 300,
          trfTime: W(10, jam), tankId: 1, batchPrefix: 'HRC', batchNomor: nomor,
        },
        AKTOR.operator, IP_UJI,
      );
    }

    const model = await formData.modelForm('2026-08-10');
    const perSilo = new Map(model.halaman2.transfer.map((s) => [s.siloKode, s.slot]));

    assert.deepEqual(perSilo.get('1').map((t) => t.jam.jam), [14, 15]);
    assert.deepEqual(perSilo.get('2').map((t) => t.jam.jam), [16]);
    assert.equal(perSilo.get('3').length, 0, 'silo tanpa transfer tetap ada, kosong');
  });
});

describe('Hari tanpa penerimaan - B-27', () => {
  /**
   * Flow lama hanya melihat jumlah penerimaan untuk memutuskan menerbitkan
   * berkas, sehingga hari yang punya monitoring dan transfer tetapi tidak ada
   * penerimaan tidak menghasilkan berkas sama sekali.
   */
  test('hari dengan monitoring saja tetap dianggap berisi', async () => {
    const rcv = await terima({ hari: 9, jam: 8, qtyKg: 2000 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1500 }], {
      hari: 9, jamMulai: 9, jamSelesai: 10,
    });

    await monitoring.simpanRonde(
      {
        timeCheck: W(10, 8),
        hasil: [{ siloId: SILO.satu, ph: 6.7, temp: 4.2 }],
      },
      AKTOR.operator, IP_UJI,
    );

    const model = await formData.modelForm('2026-08-10');
    assert.equal(model.halaman1.length, 0, 'memang tidak ada penerimaan');
    assert.equal(model.kosong, false, 'tetapi harinya tidak kosong');

    const slot = model.halaman2.monitoring.find((s) => s.siloKode === '1').slot;
    assert.equal(slot.length, 1);
    assert.equal(slot[0].suhu, 4.2);
  });

  test('hari yang benar-benar tanpa data ditandai kosong', async () => {
    const model = await formData.modelForm('2026-08-10');
    assert.equal(model.kosong, true);

    const v = await formData.validasiForm(model);
    assert.ok(v.temuan.some((t) => t.kode === 'B-27'));
  });
});

describe('Validasi pra-export - FR-28.3, FR-28.5', () => {
  test('penyimpangan OPRP menjadi peringatan, bukan pemblokir', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 1000 }],
        prepastStart: W(10, 7), prepastFinish: W(10, 8),
        flowrate: 5.5, tempAfterHeater: 78, tempOutput: 4,
        konfirmasiOprp: true,
      },
      AKTOR.operator, IP_UJI,
    );

    const model = await formData.modelForm('2026-08-10');
    const v = await formData.validasiForm(model);
    const oprp = v.temuan.find((t) => t.kode === 'OPRP');

    assert.ok(oprp, 'penyimpangan OPRP harus dilaporkan');
    assert.equal(oprp.jenis, 'peringatan');
    assert.equal(v.adaPemblokir, false, 'tidak menghalangi export');
  });

  test('baris melebihi kapasitas halaman menjadi PEMBLOKIR', async () => {
    // Kapasitas halaman 1 adalah 17 baris
    for (let i = 0; i < 18; i += 1) {
      await terima({ hari: 10, jam: 6, menit: i, qtyKg: 100 });
    }

    const model = await formData.modelForm('2026-08-10');
    const v = await formData.validasiForm(model);

    assert.equal(model.halaman1.length, 18);
    assert.equal(v.adaPemblokir, true);
    assert.ok(v.temuan.some((t) => t.jenis === 'pemblokir' && /17 baris/.test(t.pesan)));
  });

  test('record pending dilaporkan sebagai peringatan, tetap terbit - D-12', async () => {
    await terima({ hari: 10, jam: 6 });

    const model = await formData.modelForm('2026-08-10');
    const v = await formData.validasiForm(model);

    assert.equal(model.halaman1.length, 1, 'pending tetap terbit');
    assert.ok(v.temuan.some((t) => t.kode === 'D-12' && t.jenis === 'peringatan'));
  });
});

describe('Berkas xlsx', () => {
  test('berkas terbentuk dan namanya mengikuti konvensi', async () => {
    const rcv = await terima({ hari: 10, jam: 8 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
      hari: 10, jamMulai: 9, jamSelesai: 10,
    });

    const model = await formData.modelForm('2026-08-10');
    const buffer = await formExcel.bangunBerkas(model);

    // Berkas xlsx adalah arsip zip; dua bita pertamanya 'PK'
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');
    assert.ok(buffer.length > 10_000, 'template terbawa, bukan berkas kosong');

    assert.equal(formExcel.namaBerkas('2026-08-10'), 'Rekap_FM_20260810.xlsx');
    assert.equal(formExcel.namaBerkas('2026-08-10', 2), 'Rekap_FM_20260810_2.xlsx');
  });
});

describe('Penanda silo kosong - 0/0/0 bukan slot kosong', () => {
  /**
   * Ditegaskan pemilik proses: satu slot berisi `0 / 0 / 0` MENANDAI bahwa
   * silo mencapai posisi kosong pada transfer sebelumnya. Ia bukan slot yang
   * belum terpakai.
   */
  test('transfer yang mengosongkan silo diikuti penanda', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 1000 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
      hari: 10, jamMulai: 7, jamSelesai: 8,
    });

    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 600,
        trfTime: W(10, 14), tankId: 1, batchPrefix: 'HRC', batchNomor: 1,
      },
      AKTOR.operator, IP_UJI,
    );
    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 400,
        trfTime: W(10, 16), tankId: 1, batchPrefix: 'HRC', batchNomor: 2,
      },
      AKTOR.operator, IP_UJI,
    );

    const model = await formData.modelForm('2026-08-10');
    const slot = model.halaman2.transfer.find((s) => s.siloKode === '1').slot;

    assert.equal(slot.length, 3, 'dua transfer ditambah satu penanda');
    assert.equal(slot[0].penanda, null);
    assert.equal(slot[1].penanda, null);
    assert.equal(slot[2].penanda, 'KOSONG', 'penanda menyusul transfer yang mengosongkan');
    assert.equal(slot[2].volume, null, 'penanda bukan transfer bervolume nol');
  });

  test('silo yang tidak pernah kosong tidak mendapat penanda', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 1000 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
      hari: 10, jamMulai: 7, jamSelesai: 8,
    });

    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 600,
        trfTime: W(10, 14), tankId: 1, batchPrefix: 'HRC', batchNomor: 1,
      },
      AKTOR.operator, IP_UJI,
    );

    const model = await formData.modelForm('2026-08-10');
    const slot = model.halaman2.transfer.find((s) => s.siloKode === '1').slot;

    assert.equal(slot.length, 1);
    assert.equal(slot[0].penanda, null);
  });

  /**
   * Kasus yang paling meyakinkan, terbaca di berkas 6 Agustus pada Silo 25B:
   * silo dikosongkan, lalu diisi lagi dan dipakai lagi pada hari yang sama.
   * Penandanya duduk di TENGAH urutan, jadi ia tidak mungkin sekadar sisa
   * slot yang belum terpakai.
   */
  test('penanda duduk di tengah urutan bila silo diisi dan dipakai lagi', async () => {
    const pertama = await terima({ hari: 10, jam: 5, qtyKg: 500 });
    await prepastKe(pertama.id, [{ siloId: SILO.satu, volumeLtr: 500 }], {
      hari: 10, jamMulai: 6, jamSelesai: 7,
    });
    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 500,
        trfTime: W(10, 8), tankId: 1, batchPrefix: 'HRC', batchNomor: 1,
      },
      AKTOR.operator, IP_UJI,
    );

    // Silo diisi ulang, lalu dipakai lagi
    const kedua = await terima({ hari: 10, jam: 12, qtyKg: 800 });
    await prepastKe(kedua.id, [{ siloId: SILO.satu, volumeLtr: 800 }], {
      hari: 10, jamMulai: 13, jamSelesai: 14,
    });
    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 300,
        trfTime: W(10, 16), tankId: 1, batchPrefix: 'HRC', batchNomor: 2,
      },
      AKTOR.operator, IP_UJI,
    );

    const model = await formData.modelForm('2026-08-10');
    const slot = model.halaman2.transfer.find((s) => s.siloKode === '1').slot;

    assert.equal(slot.length, 3);
    assert.equal(slot[0].jam.jam, 8);
    assert.equal(slot[1].penanda, 'KOSONG', 'penanda di tengah, bukan di ujung');
    assert.equal(slot[2].jam.jam, 16, 'pemakaian sesudah pengisian ulang menyusul penanda');
  });

  test('penanda ditulis 0/0/0 di berkas xlsx, bukan dilewati', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 500 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 500 }], {
      hari: 10, jamMulai: 7, jamSelesai: 8,
    });
    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: 500,
        trfTime: W(10, 14), tankId: 1, batchPrefix: 'HRC', batchNomor: 1,
      },
      AKTOR.operator, IP_UJI,
    );

    const model = await formData.modelForm('2026-08-10');
    const buffer = await formExcel.bangunBerkas(model);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Monitoring_Transfer');

    // SILO1 slot pertama D21/E21/F21, penandanya di slot kedua G21/H21/I21
    assert.equal(ws.getCell('E21').value, 'HRC1');
    assert.equal(ws.getCell('G21').value, 0, 'jam penanda ditulis 0');
    assert.equal(ws.getCell('H21').value, 0, 'batch penanda ditulis 0');
    assert.equal(ws.getCell('I21').value, 0, 'volume penanda ditulis 0');
    // Slot ketiga tetap benar-benar kosong
    assert.equal(ws.getCell('J21').value, null);
  });

  test('penanda ikut memakan kapasitas 21 slot per silo', async () => {
    const model = await formData.modelForm('2026-08-10');
    const kapasitas =
      model.tataLetak.halaman2.transfer.barisPerSilo *
      model.tataLetak.halaman2.transfer.slotPerBaris;
    assert.equal(kapasitas, 21);
  });
});

describe('Arsip rentang - F3-8, FR-12.12', () => {
  test('satu berkas per hari dipertahankan di dalam arsip', async () => {
    for (const hari of [10, 11]) {
      const rcv = await terima({ hari, jam: 8 });
      await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
        hari, jamMulai: 9, jamSelesai: 10,
      });
    }

    const arsip = await formZip.bangunArsip(['2026-08-10', '2026-08-11', '2026-08-12']);

    assert.equal(arsip.ringkasan.jumlahBerkas, 2);
    assert.equal(arsip.ringkasan.jumlahDilewati, 1, '12 Agustus tidak ada datanya');
    // Nama arsip mengikuti rentang yang DIMINTA, bukan rentang hari yang
    // berhasil terbit. Penerimanya perlu tahu periode apa yang ia pesan;
    // hari mana saja yang ada di dalamnya dijelaskan oleh indeksnya.
    assert.equal(arsip.nama, 'Rekap_FM_20260810_sd_20260812.zip');

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(arsip.buffer);
    const isi = Object.keys(zip.files).sort();

    assert.deepEqual(isi, [
      '_indeks.csv',
      'Rekap_FM_20260810.xlsx',
      'Rekap_FM_20260811.xlsx',
    ].sort());
  });

  /**
   * Hari yang dilewati HARUS tercatat. Arsip yang hanya memuat hari berisi
   * membuat penerimanya harus menebak apakah suatu tanggal memang tidak ada
   * datanya atau exportnya gagal.
   */
  test('indeks mencatat hari yang dilewati beserta alasannya', async () => {
    const arsip = await formZip.bangunArsip(['2026-08-10']);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(arsip.buffer);
    const csv = await zip.file('_indeks.csv').async('string');

    assert.match(csv, /tanggal;berkas;jumlah_baris;pemblokir;peringatan;keterangan/);
    assert.match(csv, /2026-08-10;;0;0;\d+;tidak ada data/);
  });

  test('hari berpemblokir dilewati, sisanya tetap terbit', async () => {
    // 10 Agustus: 18 baris, melampaui kapasitas 17, jadi pemblokir
    for (let i = 0; i < 18; i += 1) {
      await terima({ hari: 10, jam: 6, menit: i, qtyKg: 100 });
    }
    // 11 Agustus: satu baris yang sehat
    const rcv = await terima({ hari: 11, jam: 8 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
      hari: 11, jamMulai: 9, jamSelesai: 10,
    });

    const arsip = await formZip.bangunArsip(['2026-08-10', '2026-08-11']);

    assert.equal(arsip.ringkasan.jumlahBerkas, 1, 'hanya 11 Agustus yang terbit');
    const dilewati = arsip.rincian.find((r) => r.tanggal === '2026-08-10');
    assert.equal(dilewati.berkas, null);
    assert.match(dilewati.keterangan, /pemblokir/);
  });

  test('rentang satu hari dinamai tanpa akhiran rentang', async () => {
    const rcv = await terima({ hari: 10, jam: 8 });
    await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 1000 }], {
      hari: 10, jamMulai: 9, jamSelesai: 10,
    });

    const arsip = await formZip.bangunArsip(['2026-08-10']);
    assert.equal(arsip.nama, 'Rekap_FM_20260810.zip');
  });
});


describe('Export raw hanya data aktual - bukan VOIDED/REVISED/Rejected', () => {
  /*
   * Export data tabel adalah cerminan keadaan operasional. Penerimaan yang
   * dibatalkan, digantikan koreksi, atau ditolak bukan lagi keadaan yang
   * berlaku; menyertakannya membuat export tampak memuat data yang sebenarnya
   * sudah tidak ada. Yang diuji di sini adalah SELEKSINYA, jadi status diubah
   * langsung tanpa menempuh seluruh alur void/koreksi.
   */
  test('baris VOIDED, REVISED, dan Rejected dikeluarkan; yang lain tetap', async () => {
    const { ambilDataTabel } = await import('../src/services/dataTableExcel.js');
    const { pool } = await import('../src/db/pool.js');

    const aktual = await terima({ hari: 12, jam: 8, qtyKg: 1000 });
    const dibatalkan = await terima({ hari: 12, jam: 9, qtyKg: 2000 });
    const direvisi = await terima({ hari: 12, jam: 10, qtyKg: 3000 });
    const ditolak = await terima({ hari: 12, jam: 11, qtyKg: 4000 });

    await pool.query(
      `UPDATE receiving SET status_approval = CASE id
         WHEN ? THEN 'VOIDED' WHEN ? THEN 'REVISED' WHEN ? THEN 'Rejected'
         ELSE status_approval END
        WHERE id IN (?, ?, ?)`,
      [dibatalkan.id, direvisi.id, ditolak.id, dibatalkan.id, direvisi.id, ditolak.id],
    );

    const data = await ambilDataTabel('2026-08-12', '2026-08-12');
    const kode = data.receivingPrepast.map((b) => b.receiving_kode);

    assert.ok(kode.includes(aktual.kode), 'penerimaan aktual tetap muncul');
    assert.ok(!kode.includes(dibatalkan.kode), 'VOIDED dikeluarkan');
    assert.ok(!kode.includes(direvisi.kode), 'REVISED dikeluarkan');
    assert.ok(!kode.includes(ditolak.kode), 'Rejected dikeluarkan');
  });

  test('prepast VOIDED tidak menempel pada penerimaan aktualnya', async () => {
    const { ambilDataTabel } = await import('../src/services/dataTableExcel.js');
    const { pool } = await import('../src/db/pool.js');

    const rcv = await terima({ hari: 13, jam: 8, qtyKg: 1000 });
    const { dibuat } = await prepastKe(rcv.id, [{ siloId: SILO.satu, volumeLtr: 500 }], {
      hari: 13, jamMulai: 9, jamSelesai: 10,
    });
    await pool.query(
      "UPDATE prepast_record SET status_approval = 'VOIDED' WHERE id = ?",
      [dibuat[0].id],
    );

    const data = await ambilDataTabel('2026-08-13', '2026-08-13');
    const baris = data.receivingPrepast.filter((b) => b.receiving_kode === rcv.kode);

    // Penerimaannya tetap ada, tetapi tanpa data prepast yang sudah dibatalkan.
    assert.equal(baris.length, 1, 'penerimaan tetap satu baris');
    assert.equal(baris[0].prepast_kode, null, 'prepast VOIDED tidak menempel');
  });
});
