import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { batasiBatchPadaSiklus, rekonstruksiAnchorSilo } from './standingSilo.js';

const T = (nilai) => new Date(nilai);

describe('rekonstruksiAnchorSilo', () => {
  test('anchor bertahan selama transfer belum mengosongkan silo', () => {
    const hasil = rekonstruksiAnchorSilo([
      { jenis: 'ISI', siloId: 1, waktu: T('2026-09-02T01:00:00Z') },
      { jenis: 'TRANSFER', siloAsalId: 1, tipeTransfer: 'PEMAKAIAN PRODUKSI',
        volumeLtr: 400, volumeAktualLtr: 1000, waktu: T('2026-09-02T02:00:00Z') },
      { jenis: 'ISI', siloId: 1, waktu: T('2026-09-02T03:00:00Z') },
    ]);
    assert.deepEqual(hasil.get(1), T('2026-09-02T01:00:00Z'));
  });

  test('transfer penuh menutup siklus dan Prepast berikutnya menjadi anchor baru', () => {
    const hasil = rekonstruksiAnchorSilo([
      { jenis: 'ISI', siloId: 1, waktu: T('2026-09-02T01:00:00Z') },
      { jenis: 'TRANSFER', siloAsalId: 1, tipeTransfer: 'PEMAKAIAN PRODUKSI',
        volumeLtr: 1000, volumeAktualLtr: 1000, waktu: T('2026-09-02T02:00:00Z') },
      { jenis: 'ISI', siloId: 1, waktu: T('2026-09-02T03:00:00Z') },
    ]);
    assert.deepEqual(hasil.get(1), T('2026-09-02T03:00:00Z'));
  });

  test('pindah silo penuh mewariskan anchor sumber', () => {
    const hasil = rekonstruksiAnchorSilo([
      { jenis: 'ISI', siloId: 1, waktu: T('2026-09-02T01:00:00Z') },
      { jenis: 'TRANSFER', siloAsalId: 1, siloTujuanId: 2, tipeTransfer: 'PINDAH SILO',
        volumeLtr: 1000, volumeAktualLtr: 1000, waktu: T('2026-09-02T02:00:00Z') },
    ]);
    assert.equal(hasil.has(1), false);
    assert.deepEqual(hasil.get(2), T('2026-09-02T01:00:00Z'));
  });

  test('pindah sebagian ke silo kosong memulai anchor pada waktu transfer', () => {
    const hasil = rekonstruksiAnchorSilo([
      { jenis: 'ISI', siloId: 1, waktu: T('2026-09-02T01:00:00Z') },
      { jenis: 'TRANSFER', siloAsalId: 1, siloTujuanId: 2, tipeTransfer: 'PINDAH SILO',
        volumeLtr: 400, volumeAktualLtr: 1000, waktu: T('2026-09-02T02:00:00Z') },
    ]);
    assert.deepEqual(hasil.get(1), T('2026-09-02T01:00:00Z'));
    assert.deepEqual(hasil.get(2), T('2026-09-02T02:00:00Z'));
  });

  test('pengembalian ke silo kosong mempertahankan usia susu sebelum kembali', () => {
    const hasil = rekonstruksiAnchorSilo([
      { jenis: 'ISI', siloId: 2, waktu: T('2026-09-02T08:00:00Z'),
        anchor: T('2026-09-01T22:00:00Z') },
    ]);
    assert.deepEqual(hasil.get(2), T('2026-09-01T22:00:00Z'));
  });

  test('transfer dan Prepast pada detik sama memulai siklus baru dari Prepast', () => {
    const hasil = rekonstruksiAnchorSilo([
      { jenis: 'ISI', id: 1, siloId: 1, waktu: T('2026-09-02T01:00:00Z') },
      { jenis: 'ISI', id: 2, siloId: 1, waktu: T('2026-09-02T02:00:00Z') },
      { jenis: 'TRANSFER', id: 3, siloAsalId: 1, tipeTransfer: 'PEMAKAIAN PRODUKSI',
        volumeLtr: 1000, volumeAktualLtr: 1000, waktu: T('2026-09-02T02:00:00Z') },
    ]);
    assert.deepEqual(hasil.get(1), T('2026-09-02T02:00:00Z'));
  });
});

describe('batasiBatchPadaSiklus', () => {
  test('batch sebelum silo kosong tidak dihidupkan kembali oleh residu alokasi', () => {
    const hasil = batasiBatchPadaSiklus([
      { id: 1, siloId: 25, waktuMasukSilo: T('2026-08-26T02:40:00Z') },
      { id: 2, siloId: 25, waktuMasukSilo: T('2026-08-26T14:00:00Z') },
    ], [
      { siloId: 25, saatKosong: T('2026-08-26T13:30:00Z') },
    ]);
    assert.deepEqual(hasil.map((b) => b.id), [2]);
  });

  test('Prepast pada detik yang sama dianggap masuk sesudah transfer penuh', () => {
    const waktu = T('2026-08-26T13:30:00Z');
    const hasil = batasiBatchPadaSiklus([
      { id: 1, siloId: 25, waktuMasukSilo: waktu },
    ], [{ siloId: 25, saatKosong: waktu }]);
    assert.equal(hasil.length, 1);
  });
});
