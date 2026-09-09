/**
 * Uji parsing nilai sumber migrasi - Fase 4, T-22
 *
 * Yang diuji terutama PENOLAKANNYA, bukan jalur suksesnya. Parser migrasi yang
 * longgar tidak gagal saat dijalankan; ia berhasil dengan angka yang salah, dan
 * kesalahannya baru terlihat berbulan-bulan kemudian saat sistem lama sudah
 * dipensiunkan dan tidak ada lagi pembanding.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GagalParse, parseWaktu, parseAngka, parseTeks, parseFifo, parseMenurutJenis,
} from './parseNilai.js';

describe('parseWaktu - format mm/dd/yyyy ditetapkan, bukan dideteksi', () => {
  test('membaca tanggal sebagai BULAN-hari, bukan hari-bulan', () => {
    const d = parseWaktu('06/08/2026 14:30', 'trf_time');

    // "06/08/2026" dibaca 8 JUNI, bukan 6 Agustus. Inilah asumsi yang paling
    // mahal bila salah: membalikkannya menggeser tanggal pada 12 dari setiap
    // 31 hari, dan geserannya tidak terlihat sebagai galat, hanya sebagai
    // tanggal yang salah. Asumsinya diambil dari flow export lama yang
    // membandingkan substring waktu dengan string berformat 'MM/dd/yyyy'.
    assert.equal(d.toISOString(), '2026-06-08T07:30:00.000Z');
  });

  test('waktu SharePoint malam tetap tanggal dan jam WIB yang sama', () => {
    const d = parseWaktu('09/03/2026 11:16 PM', 'finish_time');
    assert.equal(d.toISOString(), '2026-09-03T16:16:00.000Z');
  });

  test('menerima format ISO bila sumbernya sudah ISO', () => {
    const d = parseWaktu('2026-08-06 14:30', 'trf_time');
    assert.equal(d.toISOString(), '2026-08-06T07:30:00.000Z');
  });

  test('format ISO dengan zona eksplisit tidak dikonversi ulang', () => {
    assert.equal(
      parseWaktu('2026-08-06T14:30:00Z', 'trf_time').toISOString(),
      '2026-08-06T14:30:00.000Z',
    );
  });

  test('menerima objek Date apa adanya dari sumber xlsx', () => {
    const asli = new Date(2026, 7, 6, 9, 15);
    assert.equal(parseWaktu(asli, 'trf_time').getTime(), asli.getTime());
  });

  test('menangani AM/PM', () => {
    assert.equal(parseWaktu('06/08/2026 12:00 AM', 'x').toISOString(), '2026-06-07T17:00:00.000Z');
    assert.equal(parseWaktu('06/08/2026 12:00 PM', 'x').toISOString(), '2026-06-08T05:00:00.000Z');
    assert.equal(parseWaktu('06/08/2026 01:30 PM', 'x').toISOString(), '2026-06-08T06:30:00.000Z');
  });

  /**
   * String kosong berarti record GANTUNG (BR-23), bukan kesalahan. Ia tetap
   * dimuat dengan waktu NULL supaya draft lama tidak hilang dari riwayat.
   */
  test('string kosong menjadi NULL, bukan pengecualian', () => {
    for (const v of ['', '   ', null, undefined]) {
      assert.equal(parseWaktu(v, 'prepast_start'), null);
    }
  });

  test('bulan di atas 12 DITOLAK, bukan dibalik diam-diam', () => {
    // Membalik urutannya akan membuat sebagian baris berformat lain, dan
    // campuran itu tidak dapat dideteksi kemudian.
    assert.throws(() => parseWaktu('25/08/2026', 'x'), GagalParse);
  });

  test('tanggal yang tidak ada di kalender DITOLAK', () => {
    // JavaScript menggulirkan 31 Februari menjadi 3 Maret tanpa berkata apa-apa
    assert.throws(() => parseWaktu('02/31/2026', 'x'), GagalParse);
  });

  test('format tak dikenal DITOLAK dengan menyebut nilainya', () => {
    try {
      parseWaktu('kemarin sore', 'time_check');
      assert.fail('seharusnya melempar');
    } catch (err) {
      assert.ok(err instanceof GagalParse);
      assert.equal(err.kolom, 'time_check');
      assert.match(err.message, /kemarin sore/);
    }
  });
});

describe('parseAngka', () => {
  test('titik desimal diterima; koma pada kolom yang sama DITOLAK, bukan ditebak', () => {
    assert.equal(parseAngka('1.025', 'berat_jenis'), 1.025);
    // "1,025" terbaca 1025 menurut aturan bentuk (koma pemisah ribuan). Itu
    // bacaan yang sah, dan justru karena itu tidak boleh diam-diam dibalik
    // menjadi 1,025 - yang menolaknya adalah batas fisik berat jenis susu.
    assert.throws(() => parseAngka('1,025', 'berat_jenis'), /di luar batas masuk akal/);
  });

  test('kolom bilangan bulat menolak nilai berkoma - pemisah ribuan salah baca', () => {
    // Enam baris qty_kg dan empat baris vol_ltr pada export sungguhan berbentuk
    // begini. Terbaca sempurna, salah seribu kali lipat, tanpa galat apa pun.
    assert.throws(() => parseAngka('12.007', 'vol_ltr'), /selalu bilangan bulat/);
    // qty_kg ditangkap batas bawahnya, bukan tuntutan bulat - timbangan boleh
    // melaporkan pecahan, tetapi tidak pernah melaporkan 20 kg.
    assert.throws(() => parseAngka('20.403', 'qty_kg'), /di luar batas masuk akal/);
    assert.equal(parseAngka('20,403', 'qty_kg'), 20403);
    assert.equal(parseAngka('20,296.50', 'qty_kg'), 20296.5);
  });

  test('nilai di luar batas fisik ditolak, tidak dikoreksi', () => {
    assert.throws(() => parseAngka('670', 'ph_check'), /di luar batas masuk akal/);
    assert.throws(() => parseAngka('853.00', 'temp_after_heater'), /di luar batas masuk akal/);
    assert.throws(() => parseAngka('10.26', 'berat_jenis'), /di luar batas masuk akal/);
    assert.throws(() => parseAngka('1279', 'nilai_ts'), /di luar batas masuk akal/);

    assert.equal(parseAngka('6.70', 'ph_check'), 6.7);
    assert.equal(parseAngka('85.30', 'temp_after_heater'), 85.3);
  });

  test('kolom tanpa batas dibiarkan apa adanya', () => {
    assert.equal(parseAngka('123456', 'kolom_yang_tidak_terdaftar'), 123456);
  });

  test('koma sebagai pemisah ribuan dikenali bila titiknya juga ada', () => {
    assert.equal(parseAngka('20,296.50', 'qty_kg'), 20296.5);
  });

  test('kosong menjadi NULL', () => {
    assert.equal(parseAngka('', 'nilai_ts'), null);
    assert.equal(parseAngka(null, 'nilai_ts'), null);
  });

  test('bukan angka DITOLAK, tidak menjadi nol', () => {
    // Menjadikannya nol akan membuat volume hilang tanpa jejak
    assert.throws(() => parseAngka('n/a', 'qty_kg'), GagalParse);
    assert.throws(() => parseAngka('-', 'qty_kg'), GagalParse);
  });
});

describe('parseFifo - F4-4, transformasi paling kritis', () => {
  test('menguraikan JSON menjadi larik alokasi', () => {
    const isi = parseFifo(
      '[{"id_prepast":"PST-001","qty_allocated":500},{"id_prepast":"PST-002","qty_allocated":300}]',
      'supplier_fifo',
    );
    assert.equal(isi.length, 2);
    assert.equal(isi[0].id_prepast, 'PST-001');
    assert.equal(isi[1].qty_allocated, 300);
  });

  test('kosong menjadi larik kosong, bukan pengecualian', () => {
    assert.deepEqual(parseFifo('', 'supplier_fifo'), []);
    assert.deepEqual(parseFifo(null, 'supplier_fifo'), []);
  });

  /**
   * JSON rusak TIDAK boleh menjadi larik kosong. Transfer tanpa alokasi
   * terbaca sebagai transfer yang tidak berasal dari batch mana pun, dan
   * penelusurannya hilang tanpa ada yang menyadarinya.
   */
  test('JSON rusak DITOLAK, tidak menjadi larik kosong', () => {
    assert.throws(() => parseFifo('[{id_prepast:', 'supplier_fifo'), GagalParse);
    assert.throws(() => parseFifo('bukan json', 'supplier_fifo'), GagalParse);
  });

  test('JSON yang bukan larik DITOLAK', () => {
    assert.throws(() => parseFifo('{"id_prepast":"PST-001"}', 'supplier_fifo'), GagalParse);
  });
});

describe('parseTeks', () => {
  test('memangkas spasi dan mengosongkan yang kosong', () => {
    assert.equal(parseTeks('  SILO25A  '), 'SILO25A');
    assert.equal(parseTeks('   '), null);
  });
});

describe('parseMenurutJenis', () => {
  test('mengarahkan ke parser yang sesuai', () => {
    assert.equal(parseMenurutJenis('angka', '12.5', 'nilai_ts'), 12.5);
    // "12,5" ambigu: koma desimal atau ribuan yang tidak lengkap. Ditolak.
    assert.throws(() => parseMenurutJenis('angka', '12,5', 'nilai_ts'), /ambigu/);
    assert.equal(parseMenurutJenis('teks', ' A ', 'x'), 'A');
    assert.equal(parseMenurutJenis('waktu', '', 'x'), null);
    assert.deepEqual(parseMenurutJenis('json', '[]', 'x'), []);
  });
});
