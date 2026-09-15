/**
 * Uji shiftPada() — batas tiap shift, WIB.
 *
 *   Shift 1   07:00–14:59
 *   Shift 2   15:00–22:59
 *   Shift 3   23:00–06:59 (melewati tengah malam)
 *
 * Waktu diuji lewat string ISO dengan offset +07:00 eksplisit, supaya hasilnya
 * tidak bergantung pada TZ mesin yang menjalankan test — persis alasan
 * shiftPada() sendiri memakai Intl.DateTimeFormat, bukan Date#getHours().
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shiftPada, jamWib } from './shift.js';

const wib = (tanggal, jam, menit = 0) =>
  new Date(`${tanggal}T${String(jam).padStart(2, '0')}:${String(menit).padStart(2, '0')}:00+07:00`);

describe('jamWib', () => {
  test('membaca jam dinding WIB lepas dari TZ proses', () => {
    assert.equal(jamWib(wib('2026-09-15', 14)), 14);
    assert.equal(jamWib(wib('2026-09-15', 0)), 0);
  });
});

describe('shiftPada — batas tiap jendela', () => {
  test('06:59 masih shift 3 (sebelum shift 1 mulai)', () => {
    assert.equal(shiftPada(wib('2026-09-15', 6, 59)), 3);
  });

  test('07:00 tepat mulai shift 1', () => {
    assert.equal(shiftPada(wib('2026-09-15', 7, 0)), 1);
  });

  test('14:59 masih shift 1 (sesaat sebelum shift 2)', () => {
    assert.equal(shiftPada(wib('2026-09-15', 14, 59)), 1);
  });

  test('15:00 tepat mulai shift 2', () => {
    assert.equal(shiftPada(wib('2026-09-15', 15, 0)), 2);
  });

  test('22:59 masih shift 2 (sesaat sebelum shift 3)', () => {
    assert.equal(shiftPada(wib('2026-09-15', 22, 59)), 2);
  });

  test('23:00 tepat mulai shift 3', () => {
    assert.equal(shiftPada(wib('2026-09-15', 23, 0)), 3);
  });

  test('00:00 (tengah malam) tetap shift 3 — melewati pergantian hari', () => {
    assert.equal(shiftPada(wib('2026-09-16', 0, 0)), 3);
  });

  test('tanpa argumen memakai waktu sekarang', () => {
    // Sekadar memastikan tidak melempar dan hasilnya salah satu dari 1/2/3 —
    // nilai sesungguhnya bergantung jam sungguhan saat test dijalankan.
    assert.ok([1, 2, 3].includes(shiftPada()));
  });
});
