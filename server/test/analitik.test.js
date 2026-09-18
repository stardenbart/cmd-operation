/**
 * Uji integrasi dashboard analitik - FR-27
 *
 * Yang diuji terutama KEBENARAN AGREGATNYA, sebab angka pada dashboard dibaca
 * sebagai fakta dan tidak ada yang memeriksanya ulang. Grafik yang salah
 * menghitung lebih berbahaya daripada grafik yang tidak ada: yang kedua terlihat
 * hilang, yang pertama terlihat meyakinkan.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let an;
let receiving;
let prepast;
let transfer;
let monitoring;

const SILO = { satu: 2, dua: 3, enam: 7 };
const W = (hari, jam, menit = 0) => new Date(2026, 7, hari, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  an = await import('../src/services/analitik.js');
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  transfer = await import('../src/services/transfer.js');
  monitoring = await import('../src/services/monitoring.js');
});

beforeEach(reset);
after(tutup);

async function terima({ hari, jam, qtyKg = 1000, ts = 12.4, supplierId = 1 }) {
  return receiving.buat(
    { supplierId, qtyKg, beratJenis: 1, nilaiTs: ts, finishTime: W(hari, jam) },
    AKTOR.operator, IP_UJI,
  );
}

async function prepastKe(receivingId, siloId, volumeLtr, { hari, jam, tempAfterHeater = 86 }) {
  return prepast.buat(
    {
      receivingId,
      pecahan: [{ siloId, volumeLtr }],
      prepastStart: W(hari, jam), prepastFinish: W(hari, jam + 1),
      flowrate: 5.5, tempAfterHeater, tempOutput: 4,
      konfirmasiOprp: true,
    },
    AKTOR.operator, IP_UJI,
  );
}

async function pakai(siloId, volumeLtr, { hari, jam, tankId = 1, nomor = 1 }) {
  return transfer.buat(
    {
      siloAsalId: siloId, jenis: 'PEMAKAIAN PRODUKSI', volumeLtr,
      trfTime: W(hari, jam), tankId, batchPrefix: 'HRC', batchNomor: nomor,
    },
    AKTOR.operator, IP_UJI,
  );
}

describe('FR-27.2 - baris ringkasan', () => {
  test('penerimaan dan pemakaian dijumlahkan untuk rentang yang diminta', async () => {
    await terima({ hari: 10, jam: 8, qtyKg: 1000 });
    await terima({ hari: 11, jam: 8, qtyKg: 2000 });
    // Di luar rentang, tidak boleh ikut terhitung
    await terima({ hari: 20, jam: 8, qtyKg: 9000 });

    const r = an.rentang('2026-08-10', '2026-08-11');
    const hasil = await an.ringkasan(r);

    assert.equal(hasil.penerimaan.ltr, 3000);
    assert.equal(hasil.penerimaan.jumlah, 2);
  });

  test('batas rentang memakai hari SETEMPAT, bukan UTC', async () => {
    // 23.30 setempat pada 10 Agustus adalah 16.30 UTC hari yang sama;
    // pengelompokan yang keliru akan melemparnya ke tanggal lain.
    await terima({ hari: 10, jam: 23, qtyKg: 500 });

    const r = an.rentang('2026-08-10', '2026-08-10');
    assert.equal((await an.ringkasan(r)).penerimaan.ltr, 500);

    const rBerikutnya = an.rentang('2026-08-11', '2026-08-11');
    assert.equal((await an.ringkasan(rBerikutnya)).penerimaan.ltr, 0);
  });

  /**
   * Delta dibandingkan dengan periode SEPANJANG YANG SAMA tepat sebelumnya.
   * Membandingkan tujuh hari dengan "bulan lalu" yang panjangnya berbeda akan
   * menghasilkan persentase yang terlihat dramatis tanpa berarti apa-apa.
   */
  test('delta membandingkan periode sepanjang yang sama', async () => {
    // Periode sebelumnya: 8-9 Agustus, 1.000 L
    await terima({ hari: 8, jam: 8, qtyKg: 1000 });
    // Periode ini: 10-11 Agustus, 2.000 L
    await terima({ hari: 10, jam: 8, qtyKg: 2000 });

    const r = an.rentang('2026-08-10', '2026-08-11');
    const hasil = await an.ringkasan(r);

    assert.equal(hasil.penerimaan.ltr, 2000);
    assert.equal(Math.round(hasil.penerimaan.deltaPersen), 100, 'naik 100 persen');
  });

  test('delta null bila periode pembanding kosong, bukan bagi nol', async () => {
    await terima({ hari: 10, jam: 8, qtyKg: 2000 });
    const hasil = await an.ringkasan(an.rentang('2026-08-10', '2026-08-10'));
    assert.equal(hasil.penerimaan.deltaPersen, null);
  });

  test('pemakaian tidak menghitung pindah silo', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 2000, { hari: 10, jam: 7 });

    await pakai(SILO.satu, 400, { hari: 10, jam: 14 });
    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PINDAH SILO', volumeLtr: 500,
        trfTime: W(10, 15), siloTujuanId: SILO.enam,
      },
      AKTOR.operator, IP_UJI,
    );

    const hasil = await an.ringkasan(an.rentang('2026-08-10', '2026-08-10'));
    assert.equal(hasil.pemakaian.ltr, 400, 'pindah silo bukan pemakaian produksi');
  });

  test('saldo dan utilisasi adalah keadaan sekarang, bukan agregat periode', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepastKe(rcv.id, SILO.satu, 2000, { hari: 10, jam: 7 });

    // Rentang jauh di masa lalu; saldonya tetap keadaan sekarang
    const hasil = await an.ringkasan(an.rentang('2026-01-01', '2026-01-02'));
    assert.equal(hasil.saldo.siloLtr, 2000);
    assert.ok(hasil.utilisasi.persen > 0);
  });

  test('rata-rata TS mengabaikan nilai kosong, bukan menghitungnya sebagai nol', async () => {
    await terima({ hari: 10, jam: 8, ts: 12 });
    await terima({ hari: 10, jam: 9, ts: 14 });

    const hasil = await an.ringkasan(an.rentang('2026-08-10', '2026-08-10'));
    assert.equal(Number(hasil.mutu.rataTs), 13);
  });
});

describe('FR-27.3 - panel perhatian', () => {
  test('penyimpangan OPRP terdeteksi di bawah 81 C', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 500, { hari: 10, jam: 7, tempAfterHeater: 78 });
    await prepastKe(rcv.id, SILO.dua, 500, { hari: 10, jam: 9, tempAfterHeater: 86 });

    const p = await an.perhatian();
    assert.equal(p.oprp.length, 1, 'hanya yang di bawah ambang');
    assert.equal(p.oprp[0].tempAfterHeater, 78);
    assert.equal(p.oprp[0].ambang, 81);
  });

  test('tepat pada ambang 81 C bukan penyimpangan', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 1000 });
    await prepastKe(rcv.id, SILO.satu, 500, { hari: 10, jam: 7, tempAfterHeater: 81 });

    const p = await an.perhatian();
    assert.equal(p.oprp.length, 0);
  });

  test('pH di luar 6,0 sampai 7,0 terdeteksi', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepastKe(rcv.id, SILO.satu, 1000, { hari: 10, jam: 7 });

    await monitoring.simpanRonde(
      { timeCheck: W(10, 12), hasil: [{ siloId: SILO.satu, ph: 5.4, temp: 4 }] },
      AKTOR.operator, IP_UJI,
    );
    await monitoring.simpanRonde(
      { timeCheck: W(10, 16), hasil: [{ siloId: SILO.satu, ph: 6.7, temp: 4 }] },
      AKTOR.operator, IP_UJI,
    );

    const p = await an.perhatian();
    assert.equal(p.ph.length, 1);
    assert.equal(p.ph[0].ph, 5.4);
  });

  test('antrean approval dihitung per modul beserta usia tertuanya', async () => {
    await terima({ hari: 10, jam: 8 });
    await terima({ hari: 10, jam: 9 });

    const p = await an.perhatian();
    const rcv = p.antrean.find((a) => a.modul === 'receiving');
    assert.equal(rcv.jumlah, 2);
    assert.ok(rcv.usiaTertuaJam !== null);
  });

  /** FR-27.3.8 - panel kosong tetap ada; ketiadaan peringatan adalah informasi. */
  test('panel yang bersih tetap dikembalikan sebagai array kosong', async () => {
    const p = await an.perhatian();
    for (const kunci of ['lewatJadwal', 'oprp', 'ph', 'draft', 'antrean', 'standingTime']) {
      assert.ok(Array.isArray(p[kunci]), `${kunci} harus tetap ada`);
    }
  });
});

describe('FR-27.4 - grafik', () => {
  test('seluruh grafik di katalog tersedia dan menyebut pertanyaannya', async () => {
    const r = an.rentang('2026-08-10', '2026-08-11');
    const semua = await an.semuaGrafik(r);

    /*
     * Dibandingkan dengan KATALOGNYA, bukan dengan angka yang diketik di sini.
     *
     * Angka yang dipatok keras gagal setiap kali satu panel ditambahkan, dan
     * yang terbaca dari kegagalan itu bukan "ada panel yang hilang" melainkan
     * "angkanya belum diperbarui" - sehingga cara membetulkannya selalu dengan
     * menaikkan angkanya, dan uji ini berhenti menjaga apa pun.
     */
    assert.equal(Object.keys(semua).length, Object.keys(an.GRAFIK).length);
    for (const kunci of Object.keys(an.GRAFIK)) {
      assert.ok(semua[kunci], `panel ${kunci} ada di katalog tetapi tidak dihasilkan`);
    }
    for (const [nama, g] of Object.entries(semua)) {
      assert.ok(g.judul, `${nama} harus punya judul`);
      // FR-27.1.1 - panel tanpa pertanyaan tidak dibuat
      assert.ok(g.pertanyaan, `${nama} harus menyebut pertanyaan yang dijawabnya`);
      assert.ok(g.jenis, `${nama} harus menyebut bentuknya`);
    }
  });

  test('neraca harian memisahkan masuk dan keluar pada hari yang benar', async () => {
    const rcv = await terima({ hari: 10, jam: 8, qtyKg: 2000 });
    await prepastKe(rcv.id, SILO.satu, 1500, { hari: 10, jam: 9 });
    await pakai(SILO.satu, 600, { hari: 11, jam: 14 });

    const g = await an.grafik('neraca-harian', an.rentang('2026-08-10', '2026-08-11'));
    const per = new Map(g.data.map((d) => [String(d.label).slice(0, 10), d]));

    assert.equal(per.get('2026-08-10').masuk, 2000);
    assert.equal(per.get('2026-08-10').keluar, 0);
    assert.equal(per.get('2026-08-11').keluar, 600);
  });

  /** FR-27.5.3 - lebih dari delapan kategori dilipat menjadi "Lainnya". */
  test('volume per supplier melipat di luar delapan teratas', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await terima({ hari: 10, jam: 6, qtyKg: i * 100, supplierId: i });
    }

    const g = await an.grafik('volume-supplier', an.rentang('2026-08-10', '2026-08-10'));

    assert.equal(g.data.length, 9, 'delapan teratas ditambah satu lipatan');
    const lipatan = g.data.at(-1);
    assert.equal(lipatan.lipatan, true);
    assert.match(lipatan.label, /Lainnya \(2 supplier\)/);
    // 100 + 200 dari dua supplier terkecil
    assert.equal(lipatan.nilai, 300);
  });

  test('TS per supplier menyertakan penanda rata-rata', async () => {
    await terima({ hari: 10, jam: 6, ts: 12, supplierId: 1 });
    await terima({ hari: 10, jam: 7, ts: 14, supplierId: 2 });

    const g = await an.grafik('ts-supplier', an.rentang('2026-08-10', '2026-08-10'));
    assert.equal(g.data.length, 2);
    assert.equal(Math.round(g.penanda.nilai * 10) / 10, 13);
    // Diurutkan menaik supaya yang mutunya terendah terlihat lebih dulu
    assert.ok(g.data[0].nilai <= g.data[1].nilai);
  });

  test('tujuan transfer memisahkan CMD1, CMD2, dan pindah silo', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 4000 });
    await prepastKe(rcv.id, SILO.satu, 3000, { hari: 10, jam: 7 });

    await pakai(SILO.satu, 400, { hari: 10, jam: 14, tankId: 1, nomor: 1 });
    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PINDAH SILO', volumeLtr: 500,
        trfTime: W(10, 15), siloTujuanId: SILO.enam,
      },
      AKTOR.operator, IP_UJI,
    );

    const g = await an.grafik('tujuan-transfer', an.rentang('2026-08-10', '2026-08-10'));
    const hari = g.data[0];

    assert.equal(hari['Pindah silo'], 500);
    assert.equal(hari.CMD1 + hari.CMD2, 400);
  });

  test('OPRP menandai titik di bawah ambang sebagai kritis', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 500, { hari: 10, jam: 7, tempAfterHeater: 78 });
    await prepastKe(rcv.id, SILO.dua, 500, { hari: 10, jam: 9, tempAfterHeater: 86 });

    const g = await an.grafik('oprp', an.rentang('2026-08-10', '2026-08-10'));
    const titik = g.seri[0].titik;

    assert.equal(g.ambang, 81);
    assert.equal(titik.filter((t) => t.kritis).length, 1);
    assert.equal(titik.find((t) => t.kritis).nilai, 78);
  });

  /** FR-27.5.1 - dua besaran berbeda skala menjadi dua grafik, bukan dua sumbu. */
  test('suhu dan pH adalah grafik terpisah', async () => {
    const suhu = await an.grafik('suhu-silo', an.rentang('2026-08-10', '2026-08-10'));
    const ph = await an.grafik('ph-silo', an.rentang('2026-08-10', '2026-08-10'));

    assert.equal(suhu.satuan, 'C');
    assert.equal(ph.satuan, '');
    assert.notDeepEqual(suhu.pita, ph.pita);
  });

  test('aktivitas silo memuat seluruh silo aktif, termasuk yang tidak dipakai', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 1000 });
    await prepastKe(rcv.id, SILO.satu, 800, { hari: 10, jam: 7 });

    const g = await an.grafik('aktivitas-silo', an.rentang('2026-08-10', '2026-08-10'));
    const peta = new Map(g.data.map((d) => [d.label, d]));

    assert.equal(peta.get('SILO1').masuk, 800);
    // Silo yang tidak dipakai tetap ada dengan nilai nol, supaya sumbunya
    // tidak berubah-ubah saat ada silo yang kebetulan menganggur.
    assert.equal(peta.get('SILO2').masuk, 0);
  });

  test('grafik yang tidak dikenal mengembalikan null, bukan melempar', async () => {
    const hasil = await an.grafik('tidak-ada', an.rentang('2026-08-10', '2026-08-10'));
    assert.equal(hasil, null);
  });
});

describe('Filter per silo', () => {
  test('beberapa silo terpilih digabung dalam ringkasan dan grafik', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 1200, { hari: 10, jam: 7 });
    await prepastKe(rcv.id, SILO.dua, 800, { hari: 10, jam: 9 });

    const rentang = an.rentang(
      '2026-08-10',
      '2026-08-10',
      [SILO.satu, SILO.dua],
    );
    const ringkasan = await an.ringkasan(rentang);
    const aktivitas = await an.grafik('aktivitas-silo', rentang);

    assert.deepEqual(rentang.siloIds, [SILO.satu, SILO.dua]);
    assert.equal(ringkasan.penerimaan.ltr, 2000);
    assert.deepEqual(aktivitas.data.map((b) => b.label), ['SILO1', 'SILO2']);
  });

  test('angka ringkasan mengikuti silo terpilih', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 1200, { hari: 10, jam: 7 });
    await prepastKe(rcv.id, SILO.dua, 800, { hari: 10, jam: 9 });

    const semua = await an.ringkasan(an.rentang('2026-08-10', '2026-08-10'));
    const silo1 = await an.ringkasan(an.rentang('2026-08-10', '2026-08-10', SILO.satu));

    // Tanpa filter, yang dihitung adalah PENERIMAAN; dengan filter silo,
    // yang dihitung adalah PREPAST yang mengisi silo itu (BR-02).
    assert.equal(semua.penerimaan.ltr, 3000);
    assert.equal(silo1.penerimaan.ltr, 1200);
    assert.equal(silo1.labelMasuk, 'Prepast masuk');
  });

  test('prepast tanpa batch penerimaan induk tetap terhitung', async () => {
    // Prepast anak hasil pindah silo tidak punya receiving_id. INNER JOIN ke
    // receiving pernah membuangnya diam-diam, sehingga silo yang jelas berisi
    // terbaca 0 L.
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 2000, { hari: 10, jam: 7 });

    await transfer.buat(
      {
        siloAsalId: SILO.satu, jenis: 'PINDAH SILO', volumeLtr: 500,
        trfTime: W(10, 12), siloTujuanId: SILO.enam,
      },
      AKTOR.operator, IP_UJI,
    );

    const enam = await an.ringkasan(an.rentang('2026-08-10', '2026-08-10', SILO.enam));
    assert.equal(enam.saldo.siloLtr, 500, 'volumenya tidak boleh hilang');
  });

  test('grafik yang terikat silo ikut tersaring', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 1000, { hari: 10, jam: 7 });
    await prepastKe(rcv.id, SILO.dua, 1000, { hari: 10, jam: 9 });

    const g = await an.grafik('aktivitas-silo', an.rentang('2026-08-10', '2026-08-10', SILO.satu));
    assert.equal(g.data.length, 1);
    assert.equal(g.data[0].label, 'SILO1');
  });

  /**
   * Panel yang tidak dapat disaring harus BERTERUS TERANG, bukan diam-diam
   * menampilkan angka seluruh pabrik seolah-olah angka satu silo.
   */
  test('panel yang tidak terikat silo menyatakan filternya diabaikan', async () => {
    await terima({ hari: 10, jam: 6 });

    const g = await an.grafik('waktu-tunggu-approval', an.rentang('2026-08-10', '2026-08-10', SILO.satu));
    assert.equal(g.siloFilterDiabaikan, true);

    const tanpa = await an.grafik('waktu-tunggu-approval', an.rentang('2026-08-10', '2026-08-10'));
    assert.equal(tanpa.siloFilterDiabaikan, false);
  });

  test('panel perhatian ikut tersaring', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 3000 });
    await prepastKe(rcv.id, SILO.satu, 500, { hari: 10, jam: 7, tempAfterHeater: 78 });
    await prepastKe(rcv.id, SILO.dua, 500, { hari: 10, jam: 9, tempAfterHeater: 79 });

    const semua = await an.perhatian(an.rentang('2026-08-10', '2026-08-10'));
    const satu = await an.perhatian(an.rentang('2026-08-10', '2026-08-10', SILO.satu));

    assert.equal(semua.oprp.length, 2);
    assert.equal(satu.oprp.length, 1);
    assert.equal(satu.oprp[0].tempAfterHeater, 78);
  });
});

describe('Export Excel dashboard - FR-27.1.6', () => {
  test('berkas terbentuk dengan satu sheet per panel', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepastKe(rcv.id, SILO.satu, 1000, { hari: 10, jam: 7 });

    const { bangunBerkasAnalitik, namaBerkasAnalitik } =
      await import('../src/services/analitikExcel.js');
    const r = an.rentang('2026-08-10', '2026-08-11');
    const buffer = await bangunBerkasAnalitik(r, {});

    assert.equal(buffer.subarray(0, 2).toString(), 'PK', 'xlsx adalah arsip zip');

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.worksheets.map((w) => w.name);

    // Ringkasan + Perlu ditindak + Audit Sesi Prepast + satu sheet per panel
    // di katalog. Diturunkan dari katalog, bukan diketik: lihat catatan pada
    // uji jumlah grafik di atas.
    assert.equal(sheet.length, Object.keys(an.GRAFIK).length + 3);
    assert.ok(sheet.includes('Ringkasan'));
    assert.ok(sheet.includes('Perlu ditindak'));
    assert.ok(sheet.includes('Audit Sesi Prepast'));

    // Nama sheet Excel dibatasi 31 karakter
    for (const n of sheet) assert.ok(n.length <= 31, `${n} terlalu panjang`);

    assert.equal(namaBerkasAnalitik(r, {}), 'Analitik_20260810_sd_20260811.xlsx');
  });

  test('nama berkas menyebut silo bila disaring', async () => {
    const { namaBerkasAnalitik } = await import('../src/services/analitikExcel.js');
    const r = an.rentang('2026-08-10', '2026-08-10', SILO.satu);
    assert.equal(namaBerkasAnalitik(r, { siloName: 'SILO1' }), 'Analitik_20260810_SILO1.xlsx');
  });

  test('sheet ringkasan menyebut periode dan penyaringnya', async () => {
    const { bangunBerkasAnalitik } = await import('../src/services/analitikExcel.js');
    const r = an.rentang('2026-08-10', '2026-08-10', SILO.satu);
    const buffer = await bangunBerkasAnalitik(r, { siloName: 'SILO1' });

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Ringkasan');

    // Berkas yang dibuka sebulan kemudian harus memberi tahu ia periode apa
    assert.match(String(ws.getCell('B2').value), /2026-08-10/);
    assert.equal(ws.getCell('B3').value, 'SILO1');
  });
});

describe('FR-33 - sesi prepast (mode Sesi)', () => {
  test('T-42/T-44: sesi terstruktur per silo, tabel IN & OUT terpisah', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepastKe(rcv.id, SILO.satu, 1000, { hari: 10, jam: 7 });
    await pakai(SILO.satu, 400, { hari: 10, jam: 10 });

    const hasil = await an.sesiDetail(an.rentang('2026-08-10', '2026-08-10'));
    const s = hasil.sesi.find((x) => x.siloName === 'SILO1');
    assert.ok(s, 'ada sesi SILO1');
    assert.ok(Array.isArray(s.masuk) && s.masuk.length >= 1, 'tabel IN ada');
    assert.ok(s.masuk[0].supplier, 'IN membawa supplier');
    assert.equal(s.masuk[0].volumeLtr, 1000, 'IN membawa volume prepast-nya sendiri');
    assert.ok(s.masuk[0].jam, 'IN membawa waktu masuk (prepast_start)');
    assert.ok(s.masuk[0].selesai, 'IN membawa waktu selesai (prepast_finish)');
    assert.ok(new Date(s.masuk[0].selesai) >= new Date(s.masuk[0].jam), 'selesai tidak boleh mendahului masuk');
    assert.ok(Array.isArray(s.keluar) && s.keluar.length >= 1, 'tabel OUT ada');
    assert.equal(s.keluar[0].volume, 400);
    assert.ok('standingMenit' in s.keluar[0]);
    assert.ok('kemana' in s.keluar[0]);
  });

  test('T-43: sesi di luar rentang waktu tidak muncul', async () => {
    const rcv = await terima({ hari: 10, jam: 6 });
    await prepastKe(rcv.id, SILO.satu, 500, { hari: 10, jam: 7 });
    const kosong = await an.sesiDetail(an.rentang('2026-01-01', '2026-01-02'));
    assert.equal(kosong.sesi.length, 0);
  });

  test('T-43: filter silo diterapkan pada mode sesi', async () => {
    const rcv = await terima({ hari: 10, jam: 6, qtyKg: 2000 });
    await prepastKe(rcv.id, SILO.satu, 1000, { hari: 10, jam: 7 });
    const rSatu = an.rentang('2026-08-10', '2026-08-10', [SILO.satu]);
    const rEnam = an.rentang('2026-08-10', '2026-08-10', [SILO.enam]);
    assert.ok((await an.sesiDetail(rSatu)).sesi.some((s) => s.siloName === 'SILO1'));
    assert.ok(!(await an.sesiDetail(rEnam)).sesi.some((s) => s.siloName === 'SILO1'));
  });
});
