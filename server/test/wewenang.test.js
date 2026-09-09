/**
 * Uji integrasi wewenang & draft - BR-19, BR-22, BR-23, memperbaiki B-21 & B-22
 *
 * B-22 adalah temuan paling serius pada sistem lama: otorisasi ditegakkan
 * HANYA lewat properti `Visible` tombol, sehingga siapa pun yang dapat
 * memanggil operasi tulis dapat menyetujui atau mem-void record. Menyembunyikan
 * tombol bukan otorisasi; ia hanya menyembunyikan tombol.
 *
 * Karena itu uji di berkas ini memanggil SERVICE-nya langsung, melewati UI dan
 * melewati middleware rute. Kalau penegakannya hanya ada di lapis rute, uji di
 * sini akan lolos padahal seharusnya menolak - dan itulah yang perlu dibuktikan
 * tidak terjadi.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let dataList;
let approval;
let voidSvc;
let permintaan;
let izin;

const SILO = { buffer: 1, satu: 2 };
const SUPPLIER_PERTAMA = 1;
const T = (jam, menit = 0) => new Date(2026, 7, 10, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  dataList = await import('../src/services/dataList.js');
  approval = await import('../src/services/approval.js');
  voidSvc = await import('../src/services/void.js');
  permintaan = await import('../src/services/permintaanKoreksi.js');
  izin = await import('../src/auth/permissions.js');
});

beforeEach(reset);
after(tutup);

async function terima(qtyKg = 1000) {
  return receiving.buat(
    { supplierId: SUPPLIER_PERTAMA, qtyKg, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
    AKTOR.operator,
    IP_UJI,
  );
}

/** Record yang sudah disetujui, sebagai titik awal uji koreksi. */
async function terimaDisetujui(qtyKg = 1000) {
  const rcv = await terima(qtyKg);
  await approval.setujui('receiving', rcv.id, AKTOR.spv, IP_UJI);
  return rcv;
}

describe('BR-22 — matriks peran, bukan hierarki', () => {
  /**
   * B-21: `varIsSpv` dihitung dua rumus berbeda, sehingga Admin punya wewenang
   * setingkat SPV di seluruh app KECUALI di Data List. Di sini matriksnya satu
   * sumber, dan Admin sengaja BUKAN superset SPV (D-5).
   */
  test('Admin tidak mewarisi wewenang approval maupun void', () => {
    assert.equal(izin.can('Admin', izin.AKSI.APPROVAL_PUTUSKAN), false);
    assert.equal(izin.can('Admin', izin.AKSI.APPROVAL_MASSAL), false);
    assert.equal(izin.can('Admin', izin.AKSI.RECORD_VOID), false);

    assert.equal(izin.can('SPV', izin.AKSI.APPROVAL_PUTUSKAN), true);
    assert.equal(izin.can('SPV', izin.AKSI.RECORD_VOID), true);
  });

  test('Operator tidak dapat menyetujui maupun mem-void', () => {
    assert.equal(izin.can('Operator', izin.AKSI.APPROVAL_PUTUSKAN), false);
    assert.equal(izin.can('Operator', izin.AKSI.RECORD_VOID), false);
  });

  test('mengajukan dan meninjau koreksi adalah wewenang yang berbeda', () => {
    // Operator mengusulkan, SPV memutuskan. Tidak ada peran yang keduanya:
    // menyetujui usulan sendiri bukan peninjauan.
    assert.equal(izin.can('Operator', izin.AKSI.KOREKSI_AJUKAN), true);
    assert.equal(izin.can('Operator', izin.AKSI.KOREKSI_TINJAU), false);
    assert.equal(izin.can('SPV', izin.AKSI.KOREKSI_AJUKAN), false);
    assert.equal(izin.can('SPV', izin.AKSI.KOREKSI_TINJAU), true);
  });

  /*
   * Operator boleh membatalkan INPUTNYA SENDIRI yang BELUM disetujui.
   *
   * Tanpa ini, salah input harus menunggu SPV hanya untuk memulangkan
   * volumenya - dan selama menunggu, stok di sistem tidak sama dengan stok di
   * silo. Batasannya ada dua, dan keduanya diuji terpisah di bawah.
   */
  test('Operator dapat membatalkan input SENDIRI yang masih Pending', async () => {
    const rcv = await terima();

    await voidSvc.batalkan('receiving', rcv.id, 'salah ketik volume', AKTOR.operator, IP_UJI);

    const [baris] = await pool.query('SELECT status_approval FROM receiving WHERE id = ?', [rcv.id]);
    assert.equal(baris[0].status_approval, 'VOIDED');
  });

  test('Operator TIDAK dapat membatalkan record yang sudah disetujui', async () => {
    const rcv = await terimaDisetujui();

    await assert.rejects(
      () => voidSvc.batalkan('receiving', rcv.id, 'mau hapus yang sudah approved', AKTOR.operator, IP_UJI),
      (err) => {
        // Membatalkan yang sudah disetujui berarti menghapus keputusan mutu
        // yang diambil orang lain.
        assert.match(err.message, /hanya dapat\s+dibatalkan SPV|dibatalkan SPV/i);
        return true;
      },
    );

    const [baris] = await pool.query('SELECT status_approval FROM receiving WHERE id = ?', [rcv.id]);
    assert.equal(baris[0].status_approval, 'Approved', 'status tidak boleh berubah');
  });

  test('Operator DAPAT membatalkan record NON-Penerimaan Pending milik orang lain', async () => {
    // Kepemilikan tidak lagi membatasi, dan berlaku ke SEMUA modul - bukan hanya
    // Penerimaan. Prepast milik SPV yang masih Pending pun boleh dibatalkan
    // Operator. Yang tersisa hanya batas STATUS (lihat uji "sudah disetujui").
    const rcv = await receiving.buat(
      { supplierId: SUPPLIER_PERTAMA, qtyKg: 1000, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
      AKTOR.spv,
      IP_UJI,
    );
    const pst = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        flowrate: 5.5,
        tempAfterHeater: 86,
        tempOutput: 4,
      },
      AKTOR.spv,
      IP_UJI,
    );

    const hasil = await voidSvc.batalkan(
      'prepast', pst.dibuat[0].id, 'milik orang lain, tetapi salah input', AKTOR.operator, IP_UJI,
    );
    assert.equal(hasil.kode, pst.dibuat[0].kode);

    const [baris] = await pool.query(
      'SELECT status_approval FROM prepast_record WHERE id = ?', [pst.dibuat[0].id],
    );
    assert.equal(baris[0].status_approval, 'VOIDED');
  });

  test('Operator DAPAT membatalkan Penerimaan Pending milik orang lain', async () => {
    // Keputusan governance (dikonfirmasi pengguna): salah input Penerimaan kerap
    // baru ketahuan operator shift lain, jadi Penerimaan yang belum disetujui
    // boleh dibatalkan operator mana pun - bukan hanya penginputnya.
    const rcv = await receiving.buat(
      { supplierId: SUPPLIER_PERTAMA, qtyKg: 1000, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
      AKTOR.spv,
      IP_UJI,
    );

    const hasil = await voidSvc.batalkan('receiving', rcv.id, 'salah input shift lalu', AKTOR.operator, IP_UJI);
    assert.equal(hasil.kode, rcv.kode);

    const [baris] = await pool.query('SELECT status_approval FROM receiving WHERE id = ?', [rcv.id]);
    assert.equal(baris[0].status_approval, 'VOIDED');
  });

  /*
   * Berjenjang TERBUKA untuk operator, tetapi syaratnya berlaku ke SELURUH
   * rantai - bukan hanya ke record yang diklik. Kalau hanya record teratas
   * yang diperiksa, batasan "milik sendiri dan belum disetujui" dapat dilewati
   * hanya dengan memilih induknya.
   */
  test('Operator dapat membatalkan berjenjang rantai miliknya yang masih Pending', async () => {
    const rcv = await terima();
    const pst = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        flowrate: 5.5,
        tempAfterHeater: 86,
        tempOutput: 4,
      },
      AKTOR.operator,
      IP_UJI,
    );
    assert.ok(pst.dibuat?.length, 'prepast turunan terbentuk');

    const hasil = await voidSvc.batalkanBerjenjang(
      'receiving', rcv.id, 'salah volume, input ulang', AKTOR.operator, IP_UJI,
    );
    assert.ok(hasil.jumlah >= 2, 'induk dan turunannya ikut dibatalkan');

    const [baris] = await pool.query('SELECT status_approval FROM receiving WHERE id = ?', [rcv.id]);
    assert.equal(baris[0].status_approval, 'VOIDED');

    // Volumenya pulang, jadi dapat diinput ulang.
    const [sisa] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    assert.ok(sisa.length === 1);
  });

  test('berjenjang DITOLAK bila satu saja di rantainya sudah disetujui', async () => {
    const rcv = await terima();
    const pst = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        flowrate: 5.5,
        tempAfterHeater: 86,
        tempOutput: 4,
      },
      AKTOR.operator,
      IP_UJI,
    );

    // Turunannya disetujui SPV. Induknya masih Pending dan masih milik
    // operator - kalau hanya induknya yang diperiksa, ini akan lolos.
    const idPrepast = pst.dibuat[0].id;
    await approval.setujui('prepast', idPrepast, AKTOR.spv, IP_UJI);

    await assert.rejects(
      () => voidSvc.batalkanBerjenjang('receiving', rcv.id, 'coba lewat induk', AKTOR.operator, IP_UJI),
      (err) => {
        assert.match(err.message, /sudah disetujui|Approved/i);
        return true;
      },
    );

    const [baris] = await pool.query('SELECT status_approval FROM receiving WHERE id = ?', [rcv.id]);
    assert.equal(baris[0].status_approval, 'Pending Approval', 'tidak ada yang berubah');
  });

  test('penjagaannya di lapis SERVICE, bukan hanya di rute', async () => {
    const rcv = await terimaDisetujui();

    // Dipanggil langsung, melewati middleware. Inilah celah B-22: penjaga yang
    // hanya ada di rute melindungi hanya pemanggil yang melewati rute.
    await assert.rejects(
      () => voidSvc.batalkan('receiving', rcv.id, 'melewati middleware', AKTOR.operator, IP_UJI),
      (err) => {
        assert.match(err.message, /dibatalkan SPV/i);
        return true;
      },
    );
  });

  test('Admin pun ditolak mem-void, meski perannya administratif', async () => {
    const rcv = await terima();

    await assert.rejects(
      () => voidSvc.batalkan('receiving', rcv.id, 'admin mencoba void', AKTOR.admin, IP_UJI),
      (err) => {
        assert.match(err.message, /berwenang/i);
        return true;
      },
    );
  });
});

describe('BR-23 - penagihan input yang menggantung', () => {
  /**
   * Input separuh diizinkan supaya proses yang berjalan paralel tidak memaksa
   * operator mencatat angka yang diingat belakangan. Konsekuensinya harus
   * dibayar: yang separuh WAJIB tertagih, bukan didiamkan sampai ditemukan
   * berbulan-bulan kemudian saat form GMP-nya tidak dapat dicetak.
   */
  test('prepast gantung muncul di penagihan beserta usianya', async () => {
    const rcv = await terima();
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        // Sudah mulai, belum selesai: Waktu Selesai menggantung.
        prepastStart: T(6),
      },
      AKTOR.operator,
      IP_UJI,
    );

    const hasil = await dataList.gantung(AKTOR.operator);

    assert.equal(hasil.ringkasan.jumlah, 1);
    assert.equal(hasil.ringkasan.perModul.prepast, 1);
    assert.equal(hasil.data[0].modul, 'prepast');
    assert.equal(hasil.data[0].tempat, 'SILO1');
    assert.ok(hasil.data[0].usiaJam >= 0);
  });

  test('yang sudah dilengkapi hilang dari penagihan', async () => {
    const rcv = await terima();
    const pst = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(6),
      },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal((await dataList.gantung(AKTOR.operator)).ringkasan.jumlah, 1);

    await prepast.lengkapiDraft(
      pst.dibuat[0].id,
      { prepastFinish: T(8), flowrate: 5.2, tempAfterHeater: 86, tempOutput: 7 },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal((await dataList.gantung(AKTOR.operator)).ringkasan.jumlah, 0);
  });

  test('yang dibatalkan tidak ikut ditagih', async () => {
    /*
     * Record yang sudah di-void memang tidak akan pernah dilengkapi. Menagihnya
     * membuat daftar penagihan tidak pernah dapat mencapai nol, dan daftar yang
     * tidak pernah bersih akan berhenti dibaca.
     */
    const rcv = await terima();
    const pst = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(6),
      },
      AKTOR.operator,
      IP_UJI,
    );

    await voidSvc.batalkan('prepast', pst.dibuat[0].id, 'salah silo', AKTOR.operator, IP_UJI);

    assert.equal((await dataList.gantung(AKTOR.operator)).ringkasan.jumlah, 0);
  });

  test('operator hanya boleh melengkapi miliknya, SPV boleh milik siapa pun', async () => {
    const rcv = await terima();
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(6),
      },
      AKTOR.operator,
      IP_UJI,
    );

    const bagiOperator = await dataList.gantung(AKTOR.operator);
    assert.equal(bagiOperator.data[0].bolehSayaLengkapi, true);

    const bagiSpv = await dataList.gantung(AKTOR.spv);
    assert.equal(bagiSpv.data[0].bolehSayaLengkapi, true, 'SPV boleh melengkapi milik orang lain');
  });
});

describe('BR-23 — draft tidak dapat disetujui', () => {
  test('prepast dengan data proses parsial menjadi draft dan approval-nya ditolak', async () => {
    const rcv = await terima(1000);

    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(8),
      },
      AKTOR.operator,
      IP_UJI,
    );
    const idPrepast = hasil.dibuat[0].id;

    const [sebelum] = await pool.query(
      'SELECT is_gantung FROM prepast_record WHERE id = ?',
      [idPrepast],
    );
    assert.equal(Boolean(sebelum[0].is_gantung), true, 'harus ditandai draft');

    await assert.rejects(
      () => approval.setujui('prepast', idPrepast, AKTOR.spv, IP_UJI),
      (err) => {
        assert.equal(err.code, 'BR-23');
        return true;
      },
    );
  });

  test('draft yang sudah dilengkapi dapat disetujui', async () => {
    const rcv = await terima(1000);
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 500 }],
        prepastStart: T(8),
      },
      AKTOR.operator,
      IP_UJI,
    );
    const idPrepast = hasil.dibuat[0].id;

    await prepast.lengkapiDraft(
      idPrepast,
      {
        prepastFinish: T(9),
        flowrate: 10000,
        tempAfterHeater: 85,
        tempOutput: 4,
      },
      AKTOR.operator,
      IP_UJI,
    );

    await approval.setujui('prepast', idPrepast, AKTOR.spv, IP_UJI);

    const [baris] = await pool.query(
      'SELECT is_gantung, status_approval FROM prepast_record WHERE id = ?',
      [idPrepast],
    );
    assert.equal(Boolean(baris[0].is_gantung), false);
    assert.equal(baris[0].status_approval, 'Approved');
  });
});

describe('BR-19 & FR-15 — permintaan koreksi atas record yang sudah disetujui', () => {
  test('record TETAP Approved selama permintaan menunggu — inti WF-3', async () => {
    const rcv = await terimaDisetujui(1000);

    const hasil = await permintaan.ajukan(
      {
        modul: 'receiving',
        entityId: rcv.id,
        usulan: { qtyKg: '1050' },
        alasan: 'timbangan dibaca ulang',
      },
      AKTOR.operator,
      IP_UJI,
    );

    assert.equal(hasil.statusRecord, 'Approved');

    // Inilah yang gagal pada alur lama: status berubah menjadi Edit Requested,
    // yang dikecualikan dari export (D-12), sehingga record yang sah hilang
    // dari laporan selama permintaannya menggantung.
    const [baris] = await pool.query('SELECT status_approval FROM receiving WHERE id = ?', [rcv.id]);
    assert.equal(baris[0].status_approval, 'Approved');
  });

  test('hanya satu permintaan terbuka per record', async () => {
    const rcv = await terimaDisetujui(1000);
    const payload = {
      modul: 'receiving',
      entityId: rcv.id,
      usulan: { qtyKg: '1050' },
      alasan: 'permintaan pertama',
    };

    await permintaan.ajukan(payload, AKTOR.operator, IP_UJI);

    await assert.rejects(
      () => permintaan.ajukan({ ...payload, alasan: 'permintaan kedua' }, AKTOR.operator, IP_UJI),
      (err) => {
        assert.equal(err.code, 'FR-15.1');
        return true;
      },
    );
  });

  test('usulan yang sama dengan nilai sekarang ditolak', async () => {
    const rcv = await terimaDisetujui(1000);

    await assert.rejects(
      () =>
        permintaan.ajukan(
          {
            modul: 'receiving',
            entityId: rcv.id,
            usulan: { qtyKg: '1000.00' },
            alasan: 'tidak ada yang berubah',
          },
          AKTOR.operator,
          IP_UJI,
        ),
      (err) => {
        assert.equal(err.code, 'FR-15.1');
        return true;
      },
    );
  });

  /**
   * Usulan yang tidak sah harus ditolak SAAT DIAJUKAN, di depan pemohon yang
   * masih memegang konteksnya - bukan saat disetujui, di depan SPV yang tidak
   * dapat memperbaikinya.
   */
  test('usulan tidak sah ditolak saat diajukan, bukan saat disetujui', async () => {
    const rcv = await terimaDisetujui(1000);

    await assert.rejects(
      () =>
        permintaan.ajukan(
          {
            modul: 'receiving',
            entityId: rcv.id,
            usulan: { qtyKg: 'seratus' },
            alasan: 'nilai tidak sah',
          },
          AKTOR.operator,
          IP_UJI,
        ),
      (err) => {
        assert.equal(err.code, 'VALIDATION_ERROR');
        return true;
      },
    );

    const [baris] = await pool.query('SELECT COUNT(*) n FROM correction_request');
    assert.equal(Number(baris[0].n), 0, 'permintaan cacat tidak boleh tersimpan');
  });

  test('persetujuan SPV menjalankan koreksinya, tidak mengembalikan ke operator', async () => {
    const rcv = await terimaDisetujui(1000);

    const diajukan = await permintaan.ajukan(
      {
        modul: 'receiving',
        entityId: rcv.id,
        usulan: { qtyKg: '1030' },
        alasan: 'timbangan dibaca ulang',
      },
      AKTOR.operator,
      IP_UJI,
    );

    const hasil = await permintaan.setujui(diajukan.id, 'sesuai tiket', AKTOR.spv, IP_UJI);

    // Record yang sudah disetujui dikoreksi lewat reversal: record BARU dibuat,
    // yang lama ditandai REVISED. Nilai lama tidak dikaburkan (21 CFR 11.10(e)).
    assert.equal(hasil.cara, 'reversal');

    const [lama] = await pool.query('SELECT status_approval FROM receiving WHERE id = ?', [rcv.id]);
    assert.equal(lama[0].status_approval, 'REVISED');

    const [baru] = await pool.query(
      'SELECT qty_kg, qty_ltr, correction_ref_id FROM receiving WHERE kode = ?',
      [hasil.kode],
    );
    assert.equal(Number(baru[0].qty_kg), 1030);
    // 1030 / 1 = 1030, FLOOR tidak mengubah apa pun di sini
    assert.equal(Number(baru[0].qty_ltr), 1030);
    assert.equal(baru[0].correction_ref_id, rcv.id, 'penggantian harus terlacak di data');
  });

  test('penolakan SPV tidak menyentuh record aslinya', async () => {
    const rcv = await terimaDisetujui(1000);

    const diajukan = await permintaan.ajukan(
      {
        modul: 'receiving',
        entityId: rcv.id,
        usulan: { qtyKg: '1030' },
        alasan: 'timbangan dibaca ulang',
      },
      AKTOR.operator,
      IP_UJI,
    );

    await permintaan.tolak(diajukan.id, 'angka asli sudah benar', AKTOR.spv, IP_UJI);

    const [baris] = await pool.query(
      'SELECT qty_kg, status_approval FROM receiving WHERE id = ?',
      [rcv.id],
    );
    assert.equal(Number(baris[0].qty_kg), 1000);
    assert.equal(baris[0].status_approval, 'Approved');
  });

  test('permintaan yang sudah diputuskan tidak dapat diputuskan lagi', async () => {
    const rcv = await terimaDisetujui(1000);
    const diajukan = await permintaan.ajukan(
      {
        modul: 'receiving',
        entityId: rcv.id,
        usulan: { qtyKg: '1030' },
        alasan: 'timbangan dibaca ulang',
      },
      AKTOR.operator,
      IP_UJI,
    );

    await permintaan.tolak(diajukan.id, 'angka asli sudah benar', AKTOR.spv, IP_UJI);

    await assert.rejects(
      () => permintaan.setujui(diajukan.id, 'berubah pikiran', AKTOR.spv, IP_UJI),
      (err) => {
        assert.equal(err.code, 'NOT_FOUND');
        return true;
      },
    );
  });
});

describe('Jejak audit — syarat A-6, 21 CFR Part 11 sec.11.10(e)', () => {
  test('setiap keputusan meninggalkan jejak beserta pelakunya dan alasannya', async () => {
    const rcv = await terimaDisetujui(1000);
    const diajukan = await permintaan.ajukan(
      {
        modul: 'receiving',
        entityId: rcv.id,
        usulan: { qtyKg: '1030' },
        alasan: 'timbangan dibaca ulang',
      },
      AKTOR.operator,
      IP_UJI,
    );
    await permintaan.setujui(diajukan.id, 'sesuai tiket', AKTOR.spv, IP_UJI);

    const [jejak] = await pool.query(
      `SELECT action, actor_id, reason FROM audit_log
        WHERE entity = 'receiving' ORDER BY id`,
    );
    const aksi = jejak.map((j) => j.action);

    assert.ok(aksi.includes('CREATE'), 'pembuatan tercatat');
    assert.ok(aksi.includes('APPROVE'), 'persetujuan tercatat');
    assert.ok(aksi.includes('REQUEST_EDIT'), 'pengajuan koreksi tercatat');
    assert.ok(aksi.includes('GRANT_EDIT'), 'keputusan SPV tercatat');

    // Alasan wajib ada pada tiap perubahan, bukan opsional: jejak tanpa
    // alasan tidak menjelaskan apa pun saat diaudit.
    const pengajuan = jejak.find((j) => j.action === 'REQUEST_EDIT');
    assert.equal(pengajuan.actor_id, AKTOR.operator.id);
    assert.match(pengajuan.reason, /timbangan/);

    const keputusan = jejak.find((j) => j.action === 'GRANT_EDIT');
    assert.equal(keputusan.actor_id, AKTOR.spv.id, 'keputusan tercatat atas nama SPV');
  });
});
