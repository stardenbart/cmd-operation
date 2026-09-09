/**
 * Uji integrasi pipeline migrasi - Fase 4, T-20 & T-23
 *
 * Dijalankan terhadap FIXTURE berbentuk export SharePoint, bukan terhadap data
 * sungguhan yang belum tersedia. Tujuannya membuktikan MEKANIKANYA sudah benar
 * sebelum data sungguhan masuk: pemetaan kolom, penolakan nilai yang tidak
 * terbaca, pembongkaran supplier_fifo, dan sifat idempoten.
 *
 * Yang tidak dapat diuji di sini adalah kecocokan angkanya dengan Power Apps
 * (V-1). Itu menuntut pembanding dari sistem lama saat pembekuan input, dan
 * pipeline ini melaporkannya sebagai TIDAK DAPAT DIPERIKSA alih-alih lulus.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bangunBasisDataUji, reset, tutup } from './bantuan/dbUji.js';

let pool;
let muat;
let verif;
let periksa;
let dir;

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  muat = await import('../src/migrasi/muat.js');
  verif = await import('../src/migrasi/verifikasi.js');
  periksa = await import('../src/migrasi/periksaSumber.js');
});

beforeEach(async () => {
  await reset();
  dir = await mkdtemp(join(tmpdir(), 'migrasi-'));
});

after(async () => {
  await tutup();
});

/** Menulis satu berkas CSV berbentuk export SharePoint. */
async function tulisList(namaList, kepala, baris) {
  const kutip = (v) => {
    const t = String(v ?? '');
    return /[",\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };
  const isi = [
    kepala.join(','),
    ...baris.map((b) => kepala.map((k) => kutip(b[k])).join(',')),
  ].join('\n');
  await writeFile(join(dir, `${namaList}.csv`), isi, 'utf8');
}

/*
 * Nama kolom mengikuti export SharePoint SUNGGUHAN, bukan nama internal list.
 *
 * Keduanya berbeda, dan bedanya sempat tidak terlihat: kunci baris bernama
 * `Title` di dalam list tetapi terekspor sebagai `id_receiving`, dan kolom
 * waktunya bernama `start_time` di dalam list tetapi terekspor sebagai
 * `finish_time`. Fixture yang memakai nama internal akan lulus terhadap
 * pipeline yang salah dan gagal terhadap yang benar - persis kebalikan dari
 * gunanya.
 */
const KEPALA_RCV = [
  'id_receiving', 'supplier_display_name', 'supplier', 'silo_number', 'silo_display_name',
  'qty_kg', 'berat_jenis', 'nilai_ts', 'qty_remaining_ltr', 'finish_time',
  'nama_op', 'status_approval', 'status_fifo', 'buffer_status', 'cmd_source', 'correction_ref',
];
const KEPALA_PST = [
  'prepast_id', 'id_receiving', 'supplier_code', 'supplier_display_name', 'silo_tujuan',
  'silo_tujuan_display', 'vol_prepast_ltr', 'qty_remaining_ltr', 'prepast_start',
  'prepast_finish', 'flowrate_pst', 'temp_after_heater', 'temp_output_prd',
  'nama_op', 'status_approval', 'status_fifo', 'cmd_source', 'transfer_ref',
  'correction_ref', 'remarks',
];
const KEPALA_MON = [
  'checking_id', 'silo_number', 'silo_display_name', 'ph_check', 'temp_check',
  'time_check', 'supplier_list', 'val_aktual_snapshot_ltr', 'nama_op',
  'status_approval', 'correction_ref',
];
const KEPALA_SO = ['periode', 'silo_number', 'jumlah_awal_ltr'];

const KEPALA_TRF = [
  'trf_id', 'transfer_type', 'silo_number', 'silo_display_name',
  'tank_trf_qr_value', 'tank_trf', 'vol_ltr', 'vol_akt_silo_ltr', 'batch',
  'trf_time', 'standing_time_menit', 'nama_op', 'status_approval',
  'cmd_destination', 'correction_ref', 'supplier_fifo',
];

/** Satu set data kecil yang konsisten: terima 1.000 L, prepast, pakai 400 L. */
async function fixtureDasar({ fifoRusak = false, fifoKurang = false } = {}) {
  await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
    {
      id_receiving: 'RCV-001', supplier_display_name: 'Aneka Karya Boyolali',
      supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
      qty_kg: '1000', berat_jenis: '1', nilai_ts: '12.4',
      qty_remaining_ltr: '0', finish_time: '08/10/2026 06:00',
      nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'CLOSED',
      buffer_status: 'PREPASTED', cmd_source: 'CMD1', correction_ref: '',
    },
  ]);

  await tulisList('FM_Prepast_Record', KEPALA_PST, [
    {
      prepast_id: 'PST-001', id_receiving: 'RCV-001', supplier_code: '2100002591',
      supplier_display_name: 'Aneka Karya Boyolali', silo_tujuan: '1',
      silo_tujuan_display: 'SILO1', vol_prepast_ltr: '1000',
      qty_remaining_ltr: '600', prepast_start: '08/10/2026 07:00',
      prepast_finish: '08/10/2026 08:00', flowrate_pst: '5.5',
      temp_after_heater: '86', temp_output_prd: '4', nama_op: 'Ade Yudistira',
      status_approval: 'Approved', status_fifo: 'ACTIVE', cmd_source: 'CMD1',
      transfer_ref: '', correction_ref: '', remarks: '',
    },
  ]);

  const fifo = fifoRusak
    ? '[{id_prepast:'
    : fifoKurang
      ? '[{"id_prepast":"PST-001","qty_allocated":300,"qty_available":1000,"qty_after":700}]'
      : '[{"id_prepast":"PST-001","qty_allocated":400,"qty_available":1000,"qty_after":600}]';

  await tulisList('FM_Receiving_Transfer', KEPALA_TRF, [
    {
      trf_id: 'TRF-001', transfer_type: 'PEMAKAIAN PRODUKSI', silo_number: '1',
      silo_display_name: 'SILO1', tank_trf_qr_value: '',
      tank_trf: 'MT 1', vol_ltr: '400', vol_akt_silo_ltr: '1000', batch: '1hrc',
      trf_time: '08/10/2026 14:00', standing_time_menit: '360',
      nama_op: 'Ade Yudistira', status_approval: 'Approved',
      cmd_destination: 'CMD1', correction_ref: '',
      supplier_fifo: fifo,
    },
  ]);

  // List yang tidak berisi tetap disediakan berkasnya, hanya barisnya kosong.
  // Berkas yang HILANG adalah keadaan lain: ia berarti satu list tidak ikut
  // dimigrasikan sama sekali, dan V-2 memang harus menggagalkannya.
  await tulisList('FM_Receiving_Monitoring', KEPALA_MON, []);
  await tulisList('FM_Stock_Opname', KEPALA_SO, []);
}

describe('Pemuatan dasar', () => {
  test('memuat penerimaan, prepast, transfer, dan alokasinya', async () => {
    await fixtureDasar();
    const laporan = await muat.muatSemua(dir);

    assert.equal(laporan.ringkasan.receiving, 1);
    assert.equal(laporan.ringkasan.prepast, 1);
    assert.equal(laporan.ringkasan.transfer, 1);
    assert.equal(laporan.ringkasan.transferAllocation, 1);
  });

  /**
   * `start_time` di SharePoint menyimpan waktu SELESAI penerimaan. Memetakannya
   * ke kolom lain akan memindahkan seluruh jam penerimaan ke kolom yang tidak
   * pernah dibaca siapa pun.
   */
  test('start_time sumber menjadi finish_time, bukan start', async () => {
    await fixtureDasar();
    await muat.muatSemua(dir);

    const [b] = await pool.query('SELECT finish_time FROM receiving WHERE kode = ?', ['RCV-001']);
    const t = new Date(b[0].finish_time);
    assert.equal(t.getHours(), 6);
    assert.equal(t.getDate(), 10);
    assert.equal(t.getMonth(), 7, 'Agustus, indeks 7');
  });

  /** BR-03 - liter dihitung ulang, tidak diambil dari sumber. */
  test('liter dihitung ulang dengan FLOOR, bukan disalin', async () => {
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-BJ', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '3725', berat_jenis: '1.026', nilai_ts: '12.3',
        qty_remaining_ltr: '', finish_time: '08/10/2026 06:00',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', remarks: '',
      },
    ]);
    await muat.muatSemua(dir);

    const [b] = await pool.query('SELECT qty_ltr FROM receiving WHERE kode = ?', ['RCV-BJ']);
    // 3725 / 1,026 = 3630,6 -> 3630, sama dengan yang tercetak di form
    assert.equal(Number(b[0].qty_ltr), 3630);
  });

  test('batch dinormalkan mengikuti BR-21', async () => {
    await fixtureDasar();
    await muat.muatSemua(dir);

    const [b] = await pool.query('SELECT batch FROM transfer WHERE kode = ?', ['TRF-001']);
    assert.equal(b[0].batch, 'HRC1', 'dari "1hrc"');
  });
});

describe('Tidak menebak - pengecualian masuk laporan', () => {
  test('waktu tak terbaca menolak barisnya dan mencatat sebabnya', async () => {
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-RUSAK', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '1000', berat_jenis: '1', nilai_ts: '12',
        qty_remaining_ltr: '1000', finish_time: 'kemarin sore',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', remarks: '',
      },
    ]);

    const laporan = await muat.muatSemua(dir);

    assert.equal(laporan.ringkasan.receiving, 0, 'baris tidak dimuat');
    const p = laporan.perList('receiving').find((x) => x.sebab === 'nilai tidak terbaca');
    assert.ok(p, 'sebabnya tercatat');
    assert.equal(p.kode, 'RCV-RUSAK');
    assert.match(JSON.stringify(p.rincian), /kemarin sore/);
  });

  test('nilai salah format yang DAPAT dipastikan diperbaiki, bukan ditolak', async () => {
    // Jam hari kerja "29:46" - pabrik meneruskan hitungan jam melewati tengah
    // malam. Ini salah format yang dapat dipastikan: 29:46 = 05:46 keesokan hari.
    // Import harus MEMPERBAIKINYA (seperti migrasi), bukan menolak barisnya.
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-COR', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '1000', berat_jenis: '1', nilai_ts: '12.4',
        qty_remaining_ltr: '1000', finish_time: '07/10/2026 29:46',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', correction_ref: '',
      },
    ]);
    await tulisList('FM_Prepast_Record', KEPALA_PST, []);
    await tulisList('FM_Receiving_Transfer', KEPALA_TRF, []);
    await tulisList('FM_Receiving_Monitoring', KEPALA_MON, []);
    await tulisList('FM_Stock_Opname', KEPALA_SO, []);

    const laporan = await muat.muatSemua(dir);

    // Barisnya TETAP dimuat.
    assert.equal(laporan.ringkasan.receiving, 1, 'baris dimuat, bukan dibuang');

    // Nilainya benar-benar diperbaiki di basis data: 29:46 -> 11 Juli 05:46 WIB.
    // Disimpan sebagai UTC, jadi dibaca kembali ke +07:00 untuk membandingkannya.
    const [b] = await pool.query(
      "SELECT DATE_FORMAT(CONVERT_TZ(finish_time, '+00:00', '+07:00'), '%Y-%m-%d %H:%i') dt, remarks FROM receiving WHERE kode = 'RCV-COR'",
    );
    assert.equal(b[0].dt, '2026-07-11 05:46');

    // Perbaikannya tercatat - sebagai perbaikan, bukan penolakan (ALCOA+).
    const p = laporan.perList('receiving').find((x) => x.sebab === 'diperbaiki otomatis');
    assert.ok(p, 'perbaikan tercatat di laporan pengecualian');
    assert.equal(p.ditolak, false, 'perbaikan bukan penolakan');
    assert.match(JSON.stringify(p.rincian), /finish_time/);
    // ...dan menempel di remarks barisnya, selamanya.
    assert.match(b[0].remarks ?? '', /diperbaiki/i);
  });

  test('supplier yang tidak dikenal menolak barisnya, tidak dibuatkan baru', async () => {
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-ASING', supplier_display_name: 'Supplier Yang Tidak Ada',
        supplier: 'ZZZ999', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '1000', berat_jenis: '1', nilai_ts: '12',
        qty_remaining_ltr: '1000', finish_time: '08/10/2026 06:00',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', remarks: '',
      },
    ]);

    const laporan = await muat.muatSemua(dir);
    assert.equal(laporan.ringkasan.receiving, 0);

    const p = laporan.perList('receiving').find((x) => x.sebab === 'relasi tidak ditemukan');
    assert.ok(p);
    assert.match(JSON.stringify(p.rincian), /supplier/);
  });

  /**
   * JSON alokasi yang rusak TIDAK boleh menjadi larik kosong. Transfer tanpa
   * alokasi terbaca sebagai transfer yang tidak berasal dari batch mana pun.
   */
  test('supplier_fifo rusak mengosongkan alokasinya, transfernya tetap dimuat', async () => {
    await fixtureDasar({ fifoRusak: true });
    const laporan = await muat.muatSemua(dir);

    /*
     * Transfernya tetap dimuat, dan itu keputusan yang disengaja.
     *
     * supplier_fifo bukan kolom wajib. Menolak transfernya berarti susu keluar
     * dari silo tanpa satu pun catatan bahwa ia keluar, dan model volume ikut
     * salah untuk seluruh riwayat sesudahnya. Yang hilang cukup penelusuran
     * suppliernya, dan hilangnya dicatat - bukan didiamkan.
     */
    assert.equal(laporan.ringkasan.transfer, 1);
    assert.equal(laporan.ringkasan.transferAllocation, 0);

    const p = laporan.perList('transfer')
      .find((x) => x.sebab === 'nilai tidak terbaca, kolom dikosongkan');
    assert.ok(p, 'alokasi yang hilang tercatat');
    assert.equal(p.ditolak, false);
    assert.match(JSON.stringify(p.rincian), /supplier_fifo/);
  });

  test('berkas sumber yang hilang dicatat, tidak menghentikan sisanya', async () => {
    // Hanya penerimaan yang disediakan
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-001', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '1000', berat_jenis: '1', nilai_ts: '12',
        qty_remaining_ltr: '1000', finish_time: '08/10/2026 06:00',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', remarks: '',
      },
    ]);

    const laporan = await muat.muatSemua(dir);

    assert.equal(laporan.ringkasan.receiving, 1, 'yang ada tetap dimuat');
    assert.ok(
      laporan.pengecualian.some((p) => p.sebab === 'berkas sumber tidak ditemukan'),
      'yang hilang tercatat',
    );
  });
});

describe('Kode ganda di dalam satu berkas sumber', () => {
  /*
   * Bedanya dengan T-23 halus dan penting.
   *
   * ON DUPLICATE KEY UPDATE membuat migrasi boleh diulang - itu yang diuji
   * suite berikutnya. Tetapi klausa yang sama, bila dua baris di dalam SATU
   * berkas memakai kode yang sama, membuat baris kedua menimpa yang pertama
   * tanpa galat apa pun. Pada export sungguhan hal itu terjadi pada 21 baris.
   */
  test('kedua baris dimuat, yang kedua diberi akhiran, dan keduanya dilaporkan', async () => {
    await fixtureDasar();
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-KEMBAR', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '1000', berat_jenis: '1', nilai_ts: '12',
        qty_remaining_ltr: '1000', finish_time: '08/10/2026 06:00',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', correction_ref: '',
      },
      {
        id_receiving: 'RCV-KEMBAR', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '2000', berat_jenis: '1', nilai_ts: '12',
        qty_remaining_ltr: '2000', finish_time: '08/10/2026 09:00',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', correction_ref: '',
      },
    ]);

    const laporan = await muat.muatSemua(dir);

    // Dua-duanya dimuat: pada data sungguhan pasangan berkode sama ternyata
    // dua kejadian berbeda - beda silo, beda volume, beda jam.
    assert.equal(laporan.ringkasan.receiving, 2);

    const p = laporan.perList('receiving').find((x) => x.sebab === 'kode ganda di berkas sumber');
    assert.ok(p, 'kode ganda dilaporkan, tidak ditelan diam-diam');
    assert.equal(p.kode, 'RCV-KEMBAR');
    assert.equal(p.ditolak, false);

    // Yang pertama mempertahankan kodenya; yang kedua diberi akhiran.
    const [asli] = await pool.query('SELECT qty_kg FROM receiving WHERE kode = ?', ['RCV-KEMBAR']);
    assert.equal(Number(asli[0].qty_kg), 1000);

    const [kedua] = await pool.query('SELECT qty_kg FROM receiving WHERE kode = ?', ['RCV-KEMBAR-2']);
    assert.equal(Number(kedua[0].qty_kg), 2000);
  });

  test('V-2 tetap cocok - yang ditolak dihitung, yang hanya diperingatkan tidak', async () => {
    await fixtureDasar();
    // batch "zzz" tidak dikenali BR-21: barisnya TETAP dimuat, hanya bentuk
    // bakunya yang hilang. Menghitungnya sebagai penolakan membuat V-2
    // menuduh ada baris hilang yang sebenarnya ada.
    await tulisList('FM_Receiving_Transfer', KEPALA_TRF, [
      {
        trf_id: 'TRF-BATCH', transfer_type: 'PEMAKAIAN PRODUKSI', silo_number: '1',
        silo_display_name: 'SILO1', tank_trf_qr_value: '', tank_trf: 'MT 1',
        vol_ltr: '400', vol_akt_silo_ltr: '1000', batch: 'zzz',
        trf_time: '08/10/2026 14:00', standing_time_menit: '360',
        nama_op: 'Ade Yudistira', status_approval: 'Approved',
        cmd_destination: 'CMD1', correction_ref: '', supplier_fifo: '[]',
      },
    ]);

    const laporan = await muat.muatSemua(dir);
    const peringatan = laporan.perList('transfer').find((x) => x.sebab === 'batch tidak terpetakan');
    assert.ok(peringatan);
    assert.equal(peringatan.ditolak, false, 'peringatan, bukan penolakan');
    assert.equal(laporan.ditolakPerList('transfer').length, 0);

    const v = await verif.v2(laporan);
    const trf = v.bukti.find((b) => b.list === 'transfer');
    assert.equal(trf.cocok, true);
    assert.equal(trf.peringatan, 1);
  });
});

describe('T-23 - migrasi idempoten', () => {
  test('dijalankan dua kali menghasilkan keadaan yang sama', async () => {
    await fixtureDasar();

    await muat.muatSemua(dir);
    const hitung = async () => {
      const [r] = await pool.query('SELECT COUNT(*) n FROM receiving');
      const [p] = await pool.query('SELECT COUNT(*) n FROM prepast_record');
      const [t] = await pool.query('SELECT COUNT(*) n FROM transfer');
      const [a] = await pool.query('SELECT COUNT(*) n FROM transfer_allocation');
      return [r[0].n, p[0].n, t[0].n, a[0].n].map(Number);
    };
    const pertama = await hitung();

    await muat.muatSemua(dir);
    const kedua = await hitung();

    assert.deepEqual(kedua, pertama, 'jumlah baris tidak berubah');
    assert.deepEqual(pertama, [1, 1, 1, 1]);
  });

  test('nilai yang berubah di sumber ikut diperbarui, bukan digandakan', async () => {
    await fixtureDasar();
    await muat.muatSemua(dir);

    // Sumber diperbaiki: TS-nya dikoreksi
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-001', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '1000', berat_jenis: '1', nilai_ts: '13.1',
        qty_remaining_ltr: '0', finish_time: '08/10/2026 06:00',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'CLOSED',
        buffer_status: 'PREPASTED', cmd_source: 'CMD1', correction_ref: '',
      },
    ]);
    await muat.muatSemua(dir);

    const [b] = await pool.query('SELECT COUNT(*) n, MAX(nilai_ts) ts FROM receiving');
    assert.equal(Number(b[0].n), 1);
    assert.equal(Number(b[0].ts), 13.1);
  });

  test('yang sudah ada DITIMPA (+koreksi), yang baru DISISIPKAN', async () => {
    // Persis perilaku yang diminta: import ulang mencocokkan lewat KODE (id
    // SharePoint). Kode yang sudah ada tidak digandakan - ditimpa, tetap dengan
    // perbaikan bila nilainya salah format. Kode yang baru langsung disisipkan.
    const baris = (id, ts, waktu) => ({
      id_receiving: id, supplier_display_name: 'Aneka Karya Boyolali',
      supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
      qty_kg: '1000', berat_jenis: '1', nilai_ts: ts,
      qty_remaining_ltr: '1000', finish_time: waktu,
      nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
      buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', correction_ref: '',
    });
    const listKosong = async () => {
      await tulisList('FM_Prepast_Record', KEPALA_PST, []);
      await tulisList('FM_Receiving_Transfer', KEPALA_TRF, []);
      await tulisList('FM_Receiving_Monitoring', KEPALA_MON, []);
      await tulisList('FM_Stock_Opname', KEPALA_SO, []);
    };

    // Muat pertama: satu record.
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [baris('RCV-A', '12.4', '08/10/2026 06:00')]);
    await listKosong();
    await muat.muatSemua(dir);
    const [c1] = await pool.query('SELECT COUNT(*) n FROM receiving');
    assert.equal(Number(c1[0].n), 1);

    // Muat ulang: RCV-A nilainya berubah + waktunya salah format (perlu
    // koreksi), plus RCV-B yang benar-benar baru.
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      baris('RCV-A', '13.9', '07/10/2026 29:46'),
      baris('RCV-B', '12.0', '08/11/2026 05:00'),
    ]);
    await listKosong();
    await muat.muatSemua(dir);

    // RCV-A ditimpa (bukan digandakan), RCV-B disisipkan -> total 2.
    const [c2] = await pool.query('SELECT COUNT(*) n FROM receiving');
    assert.equal(Number(c2[0].n), 2, 'yang lama ditimpa, yang baru disisipkan');

    // RCV-A: nilai_ts ter-update DAN waktunya ter-koreksi (29:46 -> 11 Juli 05:46 WIB).
    const [a] = await pool.query(
      "SELECT nilai_ts, DATE_FORMAT(CONVERT_TZ(finish_time,'+00:00','+07:00'),'%Y-%m-%d %H:%i') dt, remarks"
      + " FROM receiving WHERE kode = 'RCV-A'",
    );
    assert.equal(Number(a[0].nilai_ts), 13.9, 'nilai ditimpa');
    assert.equal(a[0].dt, '2026-07-11 05:46', 'waktu salah format ikut diperbaiki saat ditimpa');
    assert.match(a[0].remarks ?? '', /diperbaiki/i);
  });
});

describe('Menu import: operator & stockOpname boleh absen', () => {
  test('empat list transaksi termuat walau berkas operator & stockOpname tidak ada', async () => {
    // Hanya empat list transaksi yang diekspor. Berkas operator dan stockOpname
    // sengaja TIDAK ada - dan itu tidak boleh menggagalkan import (operator
    // dikelola di aplikasi; stockOpname belum dipakai).
    await tulisList('FM_Receiving_Penerimaan', KEPALA_RCV, [
      {
        id_receiving: 'RCV-TX', supplier_display_name: 'Aneka Karya Boyolali',
        supplier: '2100002591', silo_number: '000', silo_display_name: 'BUFFER',
        qty_kg: '1000', berat_jenis: '1', nilai_ts: '12.4',
        qty_remaining_ltr: '1000', finish_time: '08/10/2026 06:00',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        buffer_status: 'IN_BUFFER', cmd_source: 'CMD1', correction_ref: '',
      },
    ]);
    await tulisList('FM_Prepast_Record', KEPALA_PST, []);
    await tulisList('FM_Receiving_Transfer', KEPALA_TRF, []);
    await tulisList('FM_Receiving_Monitoring', KEPALA_MON, []);
    // FM_Stock_Opname dan berkas operator sengaja tidak ditulis.

    const DILEWATI = ['operator', 'stockOpname'];

    const cek = await periksa.periksaSumber(dir, DILEWATI);
    assert.equal(cek.siap, true, 'tidak terblokir walau operator & stockOpname absen');
    assert.equal(cek.list.find((l) => l.list === 'operator').status, 'DILEWATI');
    assert.equal(cek.list.find((l) => l.list === 'stockOpname').status, 'DILEWATI');

    const laporan = await muat.muatSemua(dir, DILEWATI);
    assert.equal(laporan.ringkasan.receiving, 1, 'penerimaan tetap termuat');
    assert.equal(laporan.ringkasan.operator, 0, 'operator TIDAK diimport/ditimpa');

    // Operatornya tetap tertaut lewat data yang sudah ada (bukan dari export).
    const [r] = await pool.query(
      "SELECT o.nama_lengkap FROM receiving r JOIN operator o ON o.id=r.operator_id WHERE r.kode='RCV-TX'",
    );
    assert.equal(r[0].nama_lengkap, 'Ade Yudistira');
  });
});

describe('Verifikasi V-1..V-6', () => {
  test('V-1 melaporkan TIDAK DAPAT DIPERIKSA tanpa volume acuan', async () => {
    await fixtureDasar();
    const laporan = await muat.muatSemua(dir);
    const v = await verif.verifikasiSemua({ laporan });

    const v1 = v.hasil.find((h) => h.kode === 'V-1');
    // Melaporkannya lulus tanpa pembanding adalah kebohongan yang paling
    // mudah dilakukan di seluruh pipeline ini.
    assert.equal(v1.status, 'TIDAK DAPAT DIPERIKSA');
    assert.ok(
      !v.hasil.some((h) => h.kode === 'V-1' && h.status === 'GAGAL'),
      'V-1 tanpa pembanding tidak boleh dihitung sebagai kegagalan',
    );
    // Status kriteria lain dicetak bila ada yang gagal, supaya kegagalannya
    // dapat ditindaklanjuti alih-alih hanya terlihat sebagai false !== true
    const gagal = v.hasil.filter((h) => h.status === 'GAGAL');
    assert.deepEqual(
      gagal.map((h) => `${h.kode}: ${h.pesan}`),
      [],
      'tidak boleh ada kriteria yang gagal pada fixture yang sehat',
    );
  });

  test('V-1 membandingkan dengan volume Power Apps bila diberikan', async () => {
    await fixtureDasar();
    const laporan = await muat.muatSemua(dir);

    const benar = await verif.verifikasiSemua({ laporan, volumeAcuan: { SILO1: 600 } });
    assert.equal(benar.hasil.find((h) => h.kode === 'V-1').status, 'LULUS');

    const salah = await verif.verifikasiSemua({ laporan, volumeAcuan: { SILO1: 550 } });
    const v1 = salah.hasil.find((h) => h.kode === 'V-1');
    assert.equal(v1.status, 'GAGAL');
    assert.equal(v1.bukti[0].selisih, 50);
  });

  test('V-2 mencocokkan jumlah baris dikurangi pengecualian', async () => {
    await fixtureDasar();
    const laporan = await muat.muatSemua(dir);
    const v = await verif.verifikasiSemua({ laporan });

    const v2 = v.hasil.find((h) => h.kode === 'V-2');
    const rcv = v2.bukti.find((b) => b.list === 'receiving');
    assert.equal(rcv.diSumber, 1);
    assert.equal(rcv.diMysql, 1);
    assert.equal(rcv.cocok, true);
  });

  test('V-3 memberi pengecualian pada anak pindah silo', async () => {
    await fixtureDasar();
    // Prepast anak: tanpa id_receiving, tetapi punya transfer_ref
    await tulisList('FM_Prepast_Record', KEPALA_PST, [
      {
        prepast_id: 'PST-001', id_receiving: 'RCV-001', supplier_code: '2100002591',
        supplier_display_name: 'Aneka Karya Boyolali', silo_tujuan: '1',
        silo_tujuan_display: 'SILO1', vol_prepast_ltr: '1000',
        qty_remaining_ltr: '600', prepast_start: '08/10/2026 07:00',
        prepast_finish: '08/10/2026 08:00', flowrate_pst: '5.5',
        temp_after_heater: '86', temp_output_prd: '4', nama_op: 'Ade Yudistira',
        status_approval: 'Approved', status_fifo: 'ACTIVE', cmd_source: 'CMD1',
        transfer_ref: '', correction_ref: '', remarks: '',
      },
      {
        // Anak pindah silo tetap membawa supplier batch asalnya; kekangan
        // ck_pst_supplier_wajib menuntutnya, dan penelusuran memang menuntutnya
        prepast_id: 'PST-ANAK', id_receiving: '', supplier_code: '2100002591',
        supplier_display_name: 'Aneka Karya Boyolali',
        silo_tujuan: '6', silo_tujuan_display: 'SILO6',
        vol_prepast_ltr: '200', qty_remaining_ltr: '200',
        prepast_start: '08/10/2026 15:00', prepast_finish: '08/10/2026 15:30',
        flowrate_pst: '', temp_after_heater: '', temp_output_prd: '',
        nama_op: 'Ade Yudistira', status_approval: 'Approved', status_fifo: 'ACTIVE',
        cmd_source: 'CMD1', transfer_ref: '1-TO-6', correction_ref: '', remarks: '',
      },
    ]);

    const laporan = await muat.muatSemua(dir);
    assert.equal(laporan.ringkasan.prepast, 2, 'anak pindah silo tetap dimuat');
    assert.equal(laporan.ringkasan.anakPindahSilo, 1);
  });

  test('V-4 menemukan alokasi yang tidak menutup volume transfer', async () => {
    await fixtureDasar({ fifoKurang: true });
    const laporan = await muat.muatSemua(dir);

    // Selisihnya juga tercatat di laporan, lengkap dengan angkanya
    const p = laporan.perList('transfer_allocation')
      .find((x) => x.sebab.includes('tidak sama dengan volume'));
    assert.ok(p, 'selisih tercatat di laporan pengecualian');

    const v = await verif.verifikasiSemua({ laporan });
    const v4 = v.hasil.find((h) => h.kode === 'V-4');
    assert.equal(v4.status, 'GAGAL');
    assert.equal(v4.bukti[0].selisihLtr, -100);
    assert.equal(v.bolehCutover, false);
  });

  test('V-4 lulus bila alokasinya tepat', async () => {
    await fixtureDasar();
    const laporan = await muat.muatSemua(dir);
    const v = await verif.verifikasiSemua({ laporan });

    assert.equal(v.hasil.find((h) => h.kode === 'V-4').status, 'LULUS');
  });

  /**
   * Sisa yang melebihi volume asalnya sudah DICEGAH kekangan basis data
   * (`ck_pst_remaining`), jadi keadaan itu tidak dapat dibuat lewat jalur
   * mana pun - termasuk lewat migrasi. V-5 karena itu adalah lapis kedua:
   * ia menjaga bila kekangannya kelak dilonggarkan atau data dimuat lewat
   * jalur yang melewatinya.
   */
  test('V-5 lulus, dan kekangan basis data menolak keadaan yang dicarinya', async () => {
    await fixtureDasar();
    await muat.muatSemua(dir);

    assert.equal((await verif.v5()).status, 'LULUS');

    await assert.rejects(
      () => pool.query("UPDATE prepast_record SET qty_remaining_ltr = 5000 WHERE kode = 'PST-001'"),
      (err) => {
        assert.match(err.message, /ck_pst_remaining/);
        return true;
      },
    );
  });

  /**
   * Jangkar standing time DITURUNKAN, bukan dibiarkan kosong.
   *
   * Sebelumnya migrasi tidak menetapkannya sama sekali, sehingga V-6 selalu
   * PERLU REVIEW dan standing time - indikator mutu yang paling banyak dilihat
   * - terbaca "tidak diketahui" untuk seluruh stok yang dipindahkan.
   *
   * Yang diturunkan bukan prepast aktif tertua, melainkan pengisian pertama
   * SESUDAH silo terakhir kosong: menurut BR-09, jangkar berlanjut walaupun
   * susu pertama sudah keluar, sebab isinya sudah tercampur.
   */
  test('V-6 lulus karena migrasi menurunkan jangkar dari riwayatnya', async () => {
    await fixtureDasar();
    const laporan = await muat.muatSemua(dir);

    assert.ok(laporan.ringkasan.anchorSiloDitetapkan >= 1, 'ada jangkar yang ditetapkan');

    const [silo] = await pool.query(
      "SELECT standing_time_anchor FROM silo WHERE silo_name = 'SILO1'",
    );
    assert.ok(silo[0].standing_time_anchor, 'SILO1 punya jangkar');

    const v6 = await verif.v6();
    assert.equal(v6.status, 'LULUS');
  });

  test('jangkar yang lebih baru dikoreksi ke yang lebih awal', async () => {
    /*
     * Arah kesalahannya yang menentukan. Jangkar yang terlalu BARU membuat susu
     * terlihat lebih segar daripada kenyataannya - arah yang berbahaya untuk
     * indikator mutu. Yang terlalu tua hanya membuat orang memeriksa lebih cepat.
     */
    await fixtureDasar();
    await muat.muatSemua(dir);

    const [awal] = await pool.query(
      "SELECT standing_time_anchor AS a FROM silo WHERE silo_name = 'SILO1'",
    );

    // Ditimpa dengan jangkar yang jauh lebih baru, seperti yang terjadi bila
    // aplikasi menetapkannya pada pengisian pertama sesudah cutover.
    await pool.query(
      "UPDATE silo SET standing_time_anchor = UTC_TIMESTAMP() WHERE silo_name = 'SILO1'",
    );

    await muat.muatSemua(dir);

    const [sesudah] = await pool.query(
      "SELECT standing_time_anchor AS a FROM silo WHERE silo_name = 'SILO1'",
    );
    assert.equal(
      new Date(sesudah[0].a).getTime(),
      new Date(awal[0].a).getTime(),
      'jangkar kembali ke yang lebih awal',
    );
  });
});
