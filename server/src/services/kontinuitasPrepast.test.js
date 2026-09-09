import test from 'node:test';
import assert from 'node:assert/strict';
import { kontinu, kontinuDalamSilo, kelompokkan, menit } from './kontinuitasPrepast.js';

const r = (id, start, finish, siloId = 1, volumeLtr = 100, supplierName = 'A') => ({
  id, kode: `PST-${id}`, start: new Date(start), finish: new Date(finish),
  siloId, siloName: `SILO${siloId}`, volumeLtr, supplierName,
});

test('kontinuitas memakai presisi menit tanpa bergantung pada silo tujuan', () => {
  const a = r(1, '2026-09-01T01:00:00Z', '2026-09-01T01:30:40Z');
  assert.equal(kontinu(a, r(2, '2026-09-01T01:30:05Z', '2026-09-01T02:00:00Z')), true);
  assert.equal(kontinu(a, r(2, '2026-09-01T01:31:00Z', '2026-09-01T02:00:00Z')), false);
  assert.equal(kontinu(a, r(2, '2026-09-01T01:30:00Z', '2026-09-01T02:00:00Z', 2)), true);
  assert.equal(menit(null), null);
  assert.equal(kontinuDalamSilo(a, r(2, '2026-09-01T01:30:00Z', '2026-09-01T02:00:00Z', 2)), false);
});

test('kelompokkan memulai frekuensi baru saat silo berubah', () => {
  const hasil = kelompokkan([
    r(1, '2026-09-01T01:00:00Z', '2026-09-01T01:30:00Z', 1, 100),
    r(2, '2026-09-01T01:30:00Z', '2026-09-01T02:00:00Z', 2, 200),
    r(3, '2026-09-01T01:30:00Z', '2026-09-01T02:00:00Z', 3, 300),
  ]);
  assert.equal(hasil.length, 3);
  assert.deepEqual(hasil.map((s) => s.volumeLtr), [100, 200, 300]);
});

test('kelompokkan menggabungkan rantai, menjumlahkan volume, dan mengabaikan supplier', () => {
  const hasil = kelompokkan([
    r(1, '2026-09-01T01:00:00Z', '2026-09-01T01:30:00Z', 1, 100, 'X'),
    r(2, '2026-09-01T01:30:00Z', '2026-09-01T02:00:00Z', 1, 250, 'Y'),
    r(3, '2026-09-01T02:15:00Z', '2026-09-01T02:30:00Z', 1, 75, 'X'),
  ]);
  assert.equal(hasil.length, 2);
  assert.equal(hasil[0].jumlahRecord, 2);
  assert.equal(hasil[0].volumeLtr, 350);
  assert.deepEqual(hasil[0].records.map((x) => x.id), [1, 2]);
  assert.equal(hasil[1].volumeLtr, 75);
});

test('tarikan berulang supplier, waktu, dan silo yang sama tetap satu sesi', () => {
  const hasil = kelompokkan([
    r(1, '2026-09-01T01:00:00Z', '2026-09-01T01:30:00Z', 1, 100, 'Supplier A'),
    r(2, '2026-09-01T01:00:10Z', '2026-09-01T01:30:40Z', 1, 250, 'Supplier A'),
  ]);
  assert.equal(hasil.length, 1);
  assert.equal(hasil[0].jumlahRecord, 2);
  assert.equal(hasil[0].volumeLtr, 350);
});
