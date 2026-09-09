import test from 'node:test';
import assert from 'node:assert/strict';
import { gabungkanAlokasiFifo, pilihPrepastUntukAlokasi } from './muat.js';

test('alokasi FIFO berbeda dipertahankan sesuai urutan sumber', () => {
  const sumber = [
    { id_prepast: 'PST-1', qty_available: 100, qty_allocated: 40, qty_after: 60 },
    { id_prepast: 'PST-2', qty_available: 80, qty_allocated: 20, qty_after: 60 },
  ];
  const hasil = gabungkanAlokasiFifo(sumber);
  assert.deepEqual(hasil.alokasi.map((a) => a.id_prepast), ['PST-1', 'PST-2']);
  assert.equal(hasil.konflik.length, 0);
});

test('entri identik untuk prepast yang sama dideduplikasi, bukan dihitung dua kali', () => {
  const entri = {
    id_prepast: 'PST-1', qty_available: 100, qty_allocated: 40, qty_after: 60,
  };
  const hasil = gabungkanAlokasiFifo([entri, { ...entri }]);
  assert.equal(hasil.alokasi.length, 1);
  assert.equal(hasil.alokasi[0].qty_allocated, 40);
  assert.deepEqual(hasil.konflik, [{ kode: 'PST-1', identik: true }]);
});

test('potongan berurutan untuk prepast yang sama digabung menjadi satu alokasi', () => {
  const hasil = gabungkanAlokasiFifo([
    { idPrepast: 'PST-1', qtyAvailable: 100, qtyAllocated: 30, qtyAfter: 70 },
    { prepast_id: 'PST-1', qty_available: 70, qty_allocated: 20, qty_after: 50 },
  ]);
  assert.equal(hasil.alokasi.length, 1);
  assert.deepEqual(
    {
      tersedia: hasil.alokasi[0].qty_available,
      dialokasikan: hasil.alokasi[0].qty_allocated,
      sisa: hasil.alokasi[0].qty_after,
    },
    { tersedia: 100, dialokasikan: 50, sisa: 50 },
  );
  assert.deepEqual(hasil.konflik, [{ kode: 'PST-1', identik: false }]);
});

test('kode prepast ganda dipetakan ke suffix berdasarkan supplier FIFO', () => {
  const kandidat = [
    { id: 8905, kode: 'PST-20260829-256', supplier_id: 21 },
    { id: 8906, kode: 'PST-20260829-256-2', supplier_id: 22 },
  ];
  assert.equal(pilihPrepastUntukAlokasi('PST-20260829-256', 21, kandidat).id, 8905);
  assert.equal(pilihPrepastUntukAlokasi('PST-20260829-256', 22, kandidat).id, 8906);
});

test('kode prepast tanpa metadata supplier tetap memakai baris pertama', () => {
  const kandidat = [
    { id: 1, kode: 'PST-1', supplier_id: 10 },
    { id: 2, kode: 'PST-1-2', supplier_id: 20 },
  ];
  assert.equal(pilihPrepastUntukAlokasi('PST-1', null, kandidat).id, 1);
});
