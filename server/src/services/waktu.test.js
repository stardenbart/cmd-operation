/**
 * Uji logika waktu — BR-09, BR-11, uji T-8 & T-9
 *
 * Kedua fungsi murni. Rollover tengah malam dan format standing time adalah
 * aturan yang mudah salah dan mahal bila salah: rollover menentukan tanggal
 * transaksi, standing time menentukan indikator mutu.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  batasTanggal, deteksiRollover, formatStandingTime, normalisasiWaktuFilter,
  selisihMenit,
} from './waktu.js';

const T = (iso) => new Date(iso);

describe('deteksiRollover — BR-11', () => {
  test('tidak menyarankan apa pun bila selesai setelah mulai', () => {
    const hasil = deteksiRollover(T('2026-08-06T04:50:00Z'), T('2026-08-06T06:13:00Z'));

    assert.equal(hasil.perluRollover, false);
    assert.equal(hasil.saranSelesai, null);
  });

  test('menyarankan +1 hari bila jam selesai jatuh sebelum jam mulai', () => {
    // Kasus nyata: prepast mulai 23:30, selesai 01:15 keesokan hari.
    // Operator mengisi tanggal yang sama karena masih dalam shift yang sama.
    const hasil = deteksiRollover(T('2026-08-06T23:30:00Z'), T('2026-08-06T01:15:00Z'));

    assert.equal(hasil.perluRollover, true);
    assert.equal(hasil.saranSelesai.toISOString(), '2026-08-07T01:15:00.000Z');
  });

  test('menyarankan bila selesai sama persis dengan mulai', () => {
    // Durasi nol tidak mungkin untuk proses fisik — hampir pasti maksudnya
    // 24 jam kemudian, atau salah input yang harus ditanyakan.
    const hasil = deteksiRollover(T('2026-08-06T04:00:00Z'), T('2026-08-06T04:00:00Z'));

    assert.equal(hasil.perluRollover, true);
  });

  test('tidak menyarankan bila selesai sudah di hari berikutnya', () => {
    const hasil = deteksiRollover(T('2026-08-06T23:30:00Z'), T('2026-08-07T01:15:00Z'));

    assert.equal(hasil.perluRollover, false);
  });

  test('tidak menyarankan lebih dari satu hari', () => {
    // Selisih 2 hari ke belakang bukan kasus tengah malam — itu salah input,
    // dan menambah satu hari tidak akan memperbaikinya.
    const hasil = deteksiRollover(T('2026-08-06T10:00:00Z'), T('2026-08-04T10:00:00Z'));

    assert.equal(hasil.perluRollover, false);
    assert.equal(hasil.alasan, 'selisih terlalu jauh untuk rollover tengah malam');
  });

  test('tidak memutasi tanggal masukan', () => {
    const mulai = T('2026-08-06T23:30:00Z');
    const selesai = T('2026-08-06T01:15:00Z');
    const salinanSelesai = selesai.toISOString();

    deteksiRollover(mulai, selesai);

    assert.equal(selesai.toISOString(), salinanSelesai);
  });

  test('menolak masukan yang bukan tanggal', () => {
    assert.throws(() => deteksiRollover('2026-08-06', T('2026-08-06T01:00:00Z')), /tanggal/i);
    assert.throws(() => deteksiRollover(T('2026-08-06T01:00:00Z'), null), /tanggal/i);
    assert.throws(() => deteksiRollover(new Date('x'), T('2026-08-06T01:00:00Z')), /tanggal/i);
  });
});

describe('formatStandingTime — BR-09', () => {
  test('kurang dari satu jam ditampilkan dalam menit', () => {
    assert.equal(formatStandingTime(0), '0 menit');
    assert.equal(formatStandingTime(1), '1 menit');
    assert.equal(formatStandingTime(59), '59 menit');
  });

  test('satu jam sampai kurang dari sehari ditampilkan jam & menit', () => {
    assert.equal(formatStandingTime(60), '1j 0m');
    assert.equal(formatStandingTime(90), '1j 30m');
    assert.equal(formatStandingTime(1439), '23j 59m');
  });

  test('sehari atau lebih ditampilkan hari, jam & menit', () => {
    assert.equal(formatStandingTime(1440), '1h 0j 0m');
    assert.equal(formatStandingTime(1500), '1h 1j 0m');
    assert.equal(formatStandingTime(2880), '2h 0j 0m');
    assert.equal(formatStandingTime(4321), '3h 0j 1m');
  });

  test('anchor kosong ditampilkan sebagai tanda hubung', () => {
    assert.equal(formatStandingTime(null), '-');
    assert.equal(formatStandingTime(undefined), '-');
  });

  test('nilai negatif ditampilkan sebagai tanda hubung, bukan angka janggal', () => {
    // Negatif berarti jam server melenceng atau waktu transfer diisi sebelum
    // anchor. Menampilkan "-45 menit" lebih menyesatkan daripada "-".
    assert.equal(formatStandingTime(-45), '-');
  });
});

describe('selisihMenit', () => {
  test('menghitung selisih dalam menit penuh', () => {
    assert.equal(selisihMenit(T('2026-08-06T04:00:00Z'), T('2026-08-06T06:30:00Z')), 150);
  });

  test('membulatkan ke bawah pada detik pecahan', () => {
    assert.equal(selisihMenit(T('2026-08-06T04:00:00Z'), T('2026-08-06T04:01:59Z')), 1);
  });

  test('mengembalikan null bila salah satu tanggal kosong', () => {
    assert.equal(selisihMenit(null, T('2026-08-06T06:30:00Z')), null);
    assert.equal(selisihMenit(T('2026-08-06T04:00:00Z'), null), null);
  });
});

describe('batasTanggal — FR-11.3, memperbaiki B-7', () => {
  test('tanggal saja pada batas bawah menjadi tengah malam SETEMPAT', () => {
    const b = batasTanggal('2026-08-25', 'mulai');

    // Bukan pukul 00.00 UTC. Diuji lewat komponen lokal supaya hasilnya
    // benar di zona waktu mana pun uji ini dijalankan.
    assert.equal(b.getFullYear(), 2026);
    assert.equal(b.getMonth(), 7);
    assert.equal(b.getDate(), 25);
    assert.equal(b.getHours(), 0);
    assert.equal(b.getMinutes(), 0);
    assert.equal(b.getSeconds(), 0);
    assert.equal(b.getMilliseconds(), 0);
  });

  test('tanggal saja pada batas atas menjadi AKHIR hari, bukan awalnya', () => {
    const b = batasTanggal('2026-08-25', 'akhir');

    assert.equal(b.getDate(), 25);
    assert.equal(b.getHours(), 23);
    assert.equal(b.getMinutes(), 59);
    assert.equal(b.getSeconds(), 59);
    assert.equal(b.getMilliseconds(), 999);
  });

  /**
   * Inilah kegagalan yang sebenarnya: rentang satu hari mengembalikan nol
   * baris. Filter yang mengembalikan nol tidak terlihat rusak, ia terlihat
   * seperti tidak ada data.
   */
  test('rentang sehari mencakup seluruh jam pada hari itu', () => {
    const dari = batasTanggal('2026-08-25', 'mulai');
    const sampai = batasTanggal('2026-08-25', 'akhir');

    for (const jam of [0, 3, 15, 20, 23]) {
      const record = new Date(2026, 7, 25, jam, 30);
      assert.ok(
        record >= dari && record <= sampai,
        `record pukul ${jam}.30 seharusnya tercakup`,
      );
    }
  });

  test('menolak record di luar hari itu', () => {
    const dari = batasTanggal('2026-08-25', 'mulai');
    const sampai = batasTanggal('2026-08-25', 'akhir');

    assert.ok(new Date(2026, 7, 24, 23, 59) < dari);
    assert.ok(new Date(2026, 7, 26, 0, 0) > sampai);
  });

  test('nilai yang sudah memuat jam dibiarkan apa adanya', () => {
    const tepat = '2026-08-25T14:30:00Z';

    assert.equal(batasTanggal(tepat, 'akhir').toISOString(), new Date(tepat).toISOString());
    assert.equal(batasTanggal(tepat, 'mulai').toISOString(), new Date(tepat).toISOString());
  });

  test('objek Date diteruskan tanpa diubah', () => {
    const d = new Date(2026, 7, 25, 9, 15);
    assert.equal(batasTanggal(d, 'akhir').getTime(), d.getTime());
  });

  test('menolak sisi batas yang tidak dikenal', () => {
    assert.throws(() => batasTanggal('2026-08-25', 'tengah'), TypeError);
  });

  test('menolak tanggal yang tidak sah', () => {
    assert.throws(() => batasTanggal('bukan tanggal', 'mulai'), TypeError);
  });
});

describe('normalisasiWaktuFilter', () => {
  test('menafsirkan datetime-local sebagai WIB lalu menghasilkan ISO UTC', () => {
    assert.equal(normalisasiWaktuFilter('2026-08-20T08:30'), '2026-08-20T01:30:00.000Z');
  });

  test('menerima ISO yang sudah memiliki offset atau Z', () => {
    assert.equal(normalisasiWaktuFilter('2026-08-20T08:30:00+07:00'), '2026-08-20T01:30:00.000Z');
    assert.equal(normalisasiWaktuFilter('2026-08-20T01:30:00.000Z'), '2026-08-20T01:30:00.000Z');
  });

  test('memulihkan tanda plus offset yang berubah menjadi spasi', () => {
    assert.equal(normalisasiWaktuFilter('2026-08-20T08:30:00 07:00'), '2026-08-20T01:30:00.000Z');
  });

  test('menolak waktu kosong dan format yang tidak sah', () => {
    assert.throws(() => normalisasiWaktuFilter(''), /harus diisi/i);
    assert.throws(() => normalisasiWaktuFilter('20 Agustus besok'), /tanggal/i);
  });
});
