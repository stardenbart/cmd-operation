/**
 * Uji keputusan anchor standing time pada transfer — BR-09, uji T-8
 *
 * Ini logika paling mudah salah di seluruh BR-09, dan salahnya tidak
 * kelihatan: anchor yang keliru membuat standing time — indikator mutu susu —
 * melenceng tanpa ada pesan error.
 *
 * Diisolasi sebagai fungsi murni supaya keempat kasusnya dapat diuji tanpa
 * basis data: transfer penuh, transfer sebagian, pindah silo penuh (warisan),
 * dan pindah silo sebagian (anchor baru).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { putuskanAnchor } from '../src/services/anchorTransfer.js';

const ANCHOR_ASAL = new Date('2026-08-06T06:13:00Z');
const WAKTU_TRF = new Date('2026-08-06T14:00:00Z');

describe('putuskanAnchor — silo asal', () => {
  test('transfer PENUH mereset anchor silo asal (BR-09)', () => {
    const hasil = putuskanAnchor({
      jenis: 'PEMAKAIAN PRODUKSI',
      volAktualAsal: 12000,
      volTransfer: 12000,
      anchorAsal: ANCHOR_ASAL,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.resetAnchorAsal, true);
  });

  test('transfer SEBAGIAN mempertahankan anchor silo asal', () => {
    // Susu masih berdiri di silo asal, jadi hitungannya tidak boleh dimulai ulang.
    const hasil = putuskanAnchor({
      jenis: 'PEMAKAIAN PRODUKSI',
      volAktualAsal: 12000,
      volTransfer: 5000,
      anchorAsal: ANCHOR_ASAL,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.resetAnchorAsal, false);
  });

  test('transfer penuh dengan pecahan desimal tetap terdeteksi penuh', () => {
    const hasil = putuskanAnchor({
      jenis: 'PEMAKAIAN PRODUKSI',
      volAktualAsal: 0.3,
      volTransfer: 0.3,
      anchorAsal: ANCHOR_ASAL,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.resetAnchorAsal, true);
  });
});

describe('putuskanAnchor — PEMAKAIAN PRODUKSI tidak menyentuh silo lain', () => {
  test('tidak menghasilkan anchor tujuan', () => {
    const hasil = putuskanAnchor({
      jenis: 'PEMAKAIAN PRODUKSI',
      volAktualAsal: 12000,
      volTransfer: 12000,
      anchorAsal: ANCHOR_ASAL,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.anchorTujuanBaru, null);
  });
});

describe('putuskanAnchor — PINDAH SILO', () => {
  test('transfer PENUH mewariskan anchor silo asal ke silo tujuan', () => {
    // Susu yang sama, berpindah wadah — lama berdirinya tidak berubah.
    const hasil = putuskanAnchor({
      jenis: 'PINDAH SILO',
      volAktualAsal: 12000,
      volTransfer: 12000,
      anchorAsal: ANCHOR_ASAL,
      anchorTujuan: null,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.resetAnchorAsal, true);
    assert.deepEqual(hasil.anchorTujuanBaru, ANCHOR_ASAL);
  });

  test('transfer SEBAGIAN memberi silo tujuan anchor baru dari waktu transfer', () => {
    // Silo asal masih berisi susu lama, jadi anchornya tidak boleh diwariskan;
    // yang berpindah adalah sebagian, dan di wadah baru ia mulai berdiri
    // sejak saat dipindahkan.
    const hasil = putuskanAnchor({
      jenis: 'PINDAH SILO',
      volAktualAsal: 12000,
      volTransfer: 5000,
      anchorAsal: ANCHOR_ASAL,
      anchorTujuan: null,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.resetAnchorAsal, false);
    assert.deepEqual(hasil.anchorTujuanBaru, WAKTU_TRF);
  });

  test('silo tujuan yang SUDAH punya anchor tidak ditimpa', () => {
    // Susu lama di silo tujuan sudah berdiri lebih dulu. Menimpa anchornya
    // akan memuda-kan susu yang sudah lama berada di sana.
    const anchorTujuanLama = new Date('2026-08-05T20:00:00Z');
    const hasil = putuskanAnchor({
      jenis: 'PINDAH SILO',
      volAktualAsal: 12000,
      volTransfer: 12000,
      anchorAsal: ANCHOR_ASAL,
      anchorTujuan: anchorTujuanLama,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.anchorTujuanBaru, null);
  });

  test('anchor asal kosong pada transfer penuh tidak mewariskan apa pun', () => {
    const hasil = putuskanAnchor({
      jenis: 'PINDAH SILO',
      volAktualAsal: 12000,
      volTransfer: 12000,
      anchorAsal: null,
      anchorTujuan: null,
      waktuTransfer: WAKTU_TRF,
    });

    assert.equal(hasil.resetAnchorAsal, false);
    assert.equal(hasil.anchorTujuanBaru, null);
  });
});

describe('putuskanAnchor — masukan tidak sah', () => {
  test('menolak jenis transfer tidak dikenal', () => {
    assert.throws(
      () => putuskanAnchor({
        jenis: 'BUANG',
        volAktualAsal: 100, volTransfer: 100, waktuTransfer: WAKTU_TRF,
      }),
      /jenis transfer/i,
    );
  });

  test('menolak volume transfer melebihi volume aktual', () => {
    assert.throws(
      () => putuskanAnchor({
        jenis: 'PEMAKAIAN PRODUKSI',
        volAktualAsal: 100, volTransfer: 200, waktuTransfer: WAKTU_TRF,
      }),
      /melebihi/i,
    );
  });

  test('menolak waktu transfer yang bukan tanggal', () => {
    assert.throws(
      () => putuskanAnchor({
        jenis: 'PEMAKAIAN PRODUKSI',
        volAktualAsal: 100, volTransfer: 100, waktuTransfer: '2026-08-06',
      }),
      /tanggal/i,
    );
  });
});
