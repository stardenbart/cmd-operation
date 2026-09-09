/**
 * Uji tata letak form - F3-2, FR-28.7
 *
 * Koordinat sel diuji terhadap ALAMAT SUNGGUHAN yang terbaca di berkas hasil
 * export di `reference/export-samples/`. Kalau uji ini hanya mengulang rumus
 * yang sama dengan implementasinya, ia tidak membuktikan apa pun; yang
 * dibuktikan di sini adalah rumusnya menghasilkan alamat yang benar-benar
 * dipakai form.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REV02,
  keHuruf,
  keIndeks,
  selMonitoring,
  selTransfer,
  kapasitasTransferPerSilo,
  tataLetakUntuk,
  URUTAN_SILO_FORM,
} from './formLayout.js';

/** Alamat A1 dari koordinat, supaya kegagalan uji terbaca sebagai sel. */
const alamat = ({ baris, kolom }) => `${keHuruf(kolom)}${baris}`;

describe('konversi kolom', () => {
  test('huruf ke indeks dan sebaliknya', () => {
    for (const [huruf, indeks] of [['A', 1], ['B', 2], ['D', 4], ['Y', 25], ['Z', 26], ['AA', 27]]) {
      assert.equal(keIndeks(huruf), indeks, `${huruf} seharusnya ${indeks}`);
      assert.equal(keHuruf(indeks), huruf, `${indeks} seharusnya ${huruf}`);
    }
  });
});

describe('monitoring - halaman 2', () => {
  const m = REV02.halaman2.monitoring;

  /**
   * Pada berkas 6 Agustus, SILO25A mengisi T10/U10/V10 sampai T16/U16/V16.
   * SILO25A adalah silo ketujuh pada form, jadi indeksnya 6.
   */
  test('SILO25A slot pertama jatuh di T10, U10, V10', () => {
    const i = URUTAN_SILO_FORM.indexOf('25A');
    assert.equal(i, 6);
    assert.equal(alamat(selMonitoring(m, i, 0, 'jam')), 'T10');
    assert.equal(alamat(selMonitoring(m, i, 0, 'suhu')), 'U10');
    assert.equal(alamat(selMonitoring(m, i, 0, 'ph')), 'V10');
  });

  test('SILO25B slot pertama jatuh di W10, X10, Y10', () => {
    const i = URUTAN_SILO_FORM.indexOf('25B');
    assert.equal(alamat(selMonitoring(m, i, 0, 'jam')), 'W10');
    assert.equal(alamat(selMonitoring(m, i, 0, 'suhu')), 'X10');
    assert.equal(alamat(selMonitoring(m, i, 0, 'ph')), 'Y10');
  });

  test('SILO1 slot pertama jatuh di B10', () => {
    assert.equal(alamat(selMonitoring(m, 0, 0, 'jam')), 'B10');
  });

  test('slot ketujuh SILO25A jatuh di baris 16', () => {
    const i = URUTAN_SILO_FORM.indexOf('25A');
    assert.equal(alamat(selMonitoring(m, i, 6, 'jam')), 'T16');
  });

  test('kolom terakhir tidak melewati Y', () => {
    const terakhir = selMonitoring(m, URUTAN_SILO_FORM.length - 1, 0, 'ph');
    assert.equal(keHuruf(terakhir.kolom), 'Y');
  });
});

describe('transfer - halaman 2', () => {
  const t = REV02.halaman2.transfer;

  /** Berkas 6 Agustus: Silo 1 baris 21 mengisi D21/E21/F21 lalu G21/H21/I21. */
  test('SILO1 slot pertama dan kedua mengalir MENDATAR di baris 21', () => {
    assert.equal(alamat(selTransfer(t, 0, 0, 'jam')), 'D21');
    assert.equal(alamat(selTransfer(t, 0, 0, 'batch')), 'E21');
    assert.equal(alamat(selTransfer(t, 0, 0, 'volume')), 'F21');
    assert.equal(alamat(selTransfer(t, 0, 1, 'jam')), 'G21');
    assert.equal(alamat(selTransfer(t, 0, 1, 'volume')), 'I21');
  });

  /**
   * Ini yang paling mudah salah. Slot kedelapan BUKAN di baris berikutnya
   * milik silo lain, melainkan baris kedua milik silo yang sama.
   */
  test('slot kedelapan turun ke baris kedua silo yang sama, bukan ke silo lain', () => {
    assert.equal(alamat(selTransfer(t, 0, 7, 'jam')), 'D22');
    assert.equal(alamat(selTransfer(t, 0, 14, 'jam')), 'D23');
  });

  test('SILO25A mulai di baris 39, sesuai label form', () => {
    const i = URUTAN_SILO_FORM.indexOf('25A');
    assert.equal(alamat(selTransfer(t, i, 0, 'jam')), 'D39');
    assert.equal(alamat(selTransfer(t, i, 0, 'batch')), 'E39');
    assert.equal(alamat(selTransfer(t, i, 0, 'volume')), 'F39');
  });

  test('SILO25B mulai di baris 42', () => {
    const i = URUTAN_SILO_FORM.indexOf('25B');
    assert.equal(alamat(selTransfer(t, i, 0, 'jam')), 'D42');
  });

  test('baris terakhir tidak melewati baris 44', () => {
    const i = URUTAN_SILO_FORM.length - 1;
    const terakhir = selTransfer(t, i, kapasitasTransferPerSilo(t) - 1, 'volume');
    assert.equal(terakhir.baris, 44);
    // Blok tanda tangan ada di baris 46; menyentuhnya berarti menimpa form
    assert.ok(terakhir.baris < 46);
  });

  test('kapasitas 21 transfer per silo', () => {
    assert.equal(kapasitasTransferPerSilo(t), 21);
  });

  test('slot terakhir tiap baris berhenti di kolom X', () => {
    assert.equal(keHuruf(selTransfer(t, 0, 6, 'volume').kolom), 'X');
  });
});

describe('pemilihan revisi - FR-12.7', () => {
  test('data sesudah 11 Maret 2025 memakai rev02', () => {
    assert.equal(tataLetakUntuk('2026-08-06').kode, 'rev02');
    assert.equal(tataLetakUntuk('2025-03-11').kode, 'rev02');
  });

  test('data lebih tua tetap mendapat tata letak, bukan undefined', () => {
    // Belum ada definisi rev00; yang penting tidak melempar dan tidak
    // mengembalikan undefined, sebab itu akan gagal jauh di penyaji.
    assert.ok(tataLetakUntuk('2024-01-01'));
  });
});

describe('kolom halaman 1', () => {
  test('kolom "Mulai" penerimaan sengaja tidak dipetakan - WF-1', () => {
    const kunci = REV02.halaman1.kolom.map((k) => k.kunci);
    assert.ok(kunci.includes('terimaSelesai'));
    assert.ok(!kunci.includes('terimaMulai'), 'hanya ada satu waktu penerimaan');
  });

  test('kolom huruf tidak ada yang bertabrakan', () => {
    const huruf = REV02.halaman1.kolom.map((k) => k.huruf);
    assert.equal(new Set(huruf).size, huruf.length);
  });

  test('ambang OPRP diambil dari catatan kaki form', () => {
    assert.equal(REV02.halaman1.oprpTempMin, 81);
    assert.match(REV02.halaman1.catatanKaki.teks, /Min Temp\. : 81oC/);
  });
});
