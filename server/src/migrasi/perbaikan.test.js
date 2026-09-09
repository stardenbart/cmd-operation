/**
 * Uji lapisan perbaikan - Fase 4
 *
 * Yang diuji di sini bukan "apakah ia memperbaiki", melainkan "apakah ia TAHU
 * KAPAN TIDAK BOLEH memperbaiki". Perbaikan yang terlalu bersemangat lebih
 * berbahaya daripada penolakan: baris yang ditolak masih dapat diperbaiki
 * manusia, sedangkan baris yang salah diperbaiki terlihat benar selamanya.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bangunProfil, perbaikiAngka, perbaikiWaktu,
  bangunPrefiksHarian, perbaikiBatch, kunciHari,
} from './perbaikan.js';

/** Sumber tiruan berbentuk hasil bacaList(). */
function sumberDari(kolom, nilai) {
  return {
    contoh: {
      kepala: [kolom],
      data: nilai.map((v, i) => ({ _barisSumber: i + 2, [kolom]: String(v) })),
    },
  };
}

describe('bangunProfil', () => {
  test('batasnya diturunkan dari sebaran kolomnya sendiri', () => {
    const nilai = Array.from({ length: 200 }, (_, i) => (6.6 + (i % 10) / 100).toFixed(2));
    const profil = bangunProfil(sumberDari('ph_check', nilai));

    assert.ok(profil.ph_check, 'kolom yang cukup datanya masuk profil');
    assert.ok(profil.ph_check.bawah < 6.6);
    assert.ok(profil.ph_check.atas > 6.69);
  });

  test('kolom yang datanya sedikit TIDAK diberi profil', () => {
    // Sepuluh nilai tidak cukup untuk menyimpulkan apa yang normal, dan profil
    // yang disusun dari data sedikit akan menolak atau menerima nyaris apa saja.
    const profil = bangunProfil(sumberDari('ph_check', ['6.7', '6.8', '6.6']));
    assert.equal(profil.ph_check, undefined);
  });

  test('nol tidak ikut menarik batas bawah', () => {
    const nilai = [...Array(100).fill('0'), ...Array(100).fill('86.5')];
    const profil = bangunProfil(sumberDari('temp_after_heater', nilai));
    assert.ok(profil.temp_after_heater.bawah > 1, 'batas bawah tidak jatuh ke nol');
  });
});

describe('perbaikiAngka', () => {
  const profil = {
    qty_kg: { bawah: 700, atas: 27000 },
    ph_check: { bawah: 5.3, atas: 8.6 },
    berat_jenis: { bawah: 0.82, atas: 1.28 },
    nilai_ts: { bawah: 9.2, atas: 16.9 },
    temp_after_heater: { bawah: 67, atas: 111 },
  };

  test('titik pemisah ribuan pada kolom bilangan bulat', () => {
    assert.deepEqual(
      perbaikiAngka('20.403', 'qty_kg', profil).nilai, 20403,
    );
  });

  test('titik desimal yang hilang dikembalikan bila hanya satu kandidat', () => {
    assert.equal(perbaikiAngka('670', 'ph_check', profil).nilai, 6.7);
    assert.equal(perbaikiAngka('10.26', 'berat_jenis', profil).nilai, 1.026);
    assert.equal(perbaikiAngka('1279', 'nilai_ts', profil).nilai, 12.79);
    assert.equal(perbaikiAngka('853.00', 'temp_after_heater', profil).nilai, 85.3);
  });

  test('pesannya tidak memuat ekor pembagian biner', () => {
    // 1279/100 menghasilkan 12.790000000000001. Ekor itu membuat perbaikan
    // yang benar terlihat serampangan di mata yang membaca laporannya.
    assert.match(perbaikiAngka('1279', 'nilai_ts', profil).cara, /12\.79\b/);
  });

  test('yang tidak punya kandidat DITOLAK', () => {
    // 5131 tidak menjadi masuk akal dibagi berapa pun.
    assert.equal(perbaikiAngka('5131', 'nilai_ts', profil), null);
  });

  test('yang punya DUA kandidat DITOLAK - syarat tunggal', () => {
    // Dengan batas selebar ini, 853 dapat menjadi 85,3 maupun 8,53.
    const longgar = { temp_after_heater: { bawah: 1, atas: 200 } };
    assert.equal(perbaikiAngka('853.00', 'temp_after_heater', longgar), null);
  });

  test('kolom tanpa profil tidak diperbaiki', () => {
    assert.equal(perbaikiAngka('670', 'kolom_asing', profil), null);
  });
});

describe('perbaikiWaktu', () => {
  test('menit yang terpotong dilengkapi ke menit bulat', () => {
    const h = perbaikiWaktu('07/18/2026 16:5', 'prepast_finish');
    assert.equal(h.nilai.getHours(), 16);
    assert.equal(h.nilai.getMinutes(), 50);
  });

  test('jam hari kerja di atas 24 menjadi hari berikutnya', () => {
    const h = perbaikiWaktu('07/10/2026 29:46', 'trf_time');
    assert.equal(h.nilai.getDate(), 11);
    assert.equal(h.nilai.getHours(), 5);
    assert.equal(h.nilai.getMinutes(), 46);
  });

  test('jam yang tidak tercatat mempertahankan tanggalnya', () => {
    const h = perbaikiWaktu('06/23/2026 :', 'prepast_start');
    assert.equal(h.nilai.getMonth(), 5);
    assert.equal(h.nilai.getDate(), 23);
    assert.equal(h.nilai.getHours(), 0);
    assert.equal(h.jamTidakDiketahui, true);
  });

  test('jam yang mustahil dan bukan jam hari kerja DITOLAK', () => {
    assert.equal(perbaikiWaktu('07/10/2026 61:46', 'trf_time'), null);
  });

  test('tanggal yang tidak ada di kalender DITOLAK', () => {
    assert.equal(perbaikiWaktu('02/31/2026 :', 'prepast_start'), null);
  });

  test('teks yang bukan tanggal DITOLAK', () => {
    assert.equal(perbaikiWaktu('kemarin sore', 'trf_time'), null);
  });
});

describe('batch', () => {
  const hari = [
    { trf_time: '06/27/2026 10:00', batch: '1Hrc' },
    { trf_time: '06/27/2026 12:00', batch: '3hrc' },
    { trf_time: '06/27/2026 13:00', batch: 'Cmd2' },
    { trf_time: '06/28/2026 10:00', batch: '2Hrc' },
    { trf_time: '06/28/2026 12:00', batch: '4Fc' },
  ];

  test('nomor polos memakai prefiks satu-satunya hari itu', () => {
    const peta = bangunPrefiksHarian(hari);
    const h = perbaikiBatch('6', '06/27/2026 15:00', peta);
    assert.equal(h.nilai, 'HRC6');
  });

  test('CMD2 tidak dihitung sebagai prefiks bernomor', () => {
    // Kalau CMD ikut dihitung, 27 Juni punya dua prefiks dan tidak ada satu
    // pun batch yang dapat dipulihkan - padahal datanya jelas.
    const peta = bangunPrefiksHarian(hari);
    assert.equal(peta.get('2026-06-27').size, 1);
  });

  test('hari dengan dua prefiks TIDAK diperbaiki', () => {
    const peta = bangunPrefiksHarian(hari);
    assert.equal(perbaikiBatch('6', '06/28/2026 15:00', peta), null);
  });

  test('angka empat digit bukan nomor batch', () => {
    // "5000" adalah volume yang salah kolom, bukan nomor batch tanpa prefiks.
    const peta = bangunPrefiksHarian(hari);
    assert.equal(perbaikiBatch('5000', '06/27/2026 15:00', peta), null);
  });

  test('kunci hari sama untuk teks sumber maupun Date hasil parse', () => {
    assert.equal(kunciHari('06/27/2026 15:00'), '2026-06-27');
    assert.equal(kunciHari(new Date(2026, 5, 27, 15, 0)), '2026-06-27');
  });
});
