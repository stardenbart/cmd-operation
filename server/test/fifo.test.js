/**
 * Uji allocateFifo() — PRD T-5.1 .. T-5.9
 *
 * Fungsi ini adalah jalur kritis proyek (E.9). Bug di sini merusak stok
 * secara permanen dan diam-diam: tidak ada pesan error, hanya angka yang
 * perlahan menyimpang dari kenyataan fisik.
 *
 * Karena itu ia ditulis sebagai fungsi MURNI tanpa I/O — supaya dapat
 * diuji habis-habisan tanpa basis data.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { allocateFifo } from '../src/services/fifo.js';

/** Pembantu: batch prepast dengan nilai wajar. */
function batch(id, qtyRemainingLtr, prepastFinish, supplierId = 1) {
  return {
    id,
    kode: `PST-20260806-${String(id).padStart(3, '0')}`,
    supplierId,
    qtyRemainingLtr,
    prepastFinish: new Date(prepastFinish),
  };
}

/**
 * Invarian terkuat sistem ini: liter tidak boleh tercipta maupun lenyap.
 * Diperiksa setelah SETIAP alokasi.
 */
function assertKekekalan(batches, result) {
  const tersediaAwal = batches.reduce((s, b) => s + b.qtyRemainingLtr, 0);
  const sisaAkhir = result.allocations.reduce((s, a) => s + a.qtyAfter, 0);
  const takTeralokasi = batches
    .filter((b) => !result.allocations.some((a) => a.prepastId === b.id))
    .reduce((s, b) => s + b.qtyRemainingLtr, 0);

  assert.equal(
    Number((sisaAkhir + takTeralokasi + result.totalAllocated).toFixed(2)),
    Number(tersediaAwal.toFixed(2)),
    'kekekalan volume dilanggar: liter tercipta atau lenyap',
  );
}

describe('allocateFifo — alokasi dasar', () => {
  test('T-5.1 volume tepat sama dengan satu batch menutup batch itu', () => {
    const batches = [batch(1, 5000, '2026-08-06T04:20:00Z')];

    const result = allocateFifo(batches, 5000);

    assert.equal(result.allocations.length, 1);
    assert.equal(result.allocations[0].prepastId, 1);
    assert.equal(result.allocations[0].qtyAllocated, 5000);
    assert.equal(result.allocations[0].qtyAfter, 0);
    assert.equal(result.allocations[0].willClose, true);
    assert.equal(result.unallocated, 0);
    assertKekekalan(batches, result);
  });

  test('T-5.2 volume melintasi beberapa batch, batch terakhir tersisa sebagian', () => {
    const batches = [
      batch(1, 3000, '2026-08-06T04:20:00Z'),
      batch(2, 4000, '2026-08-06T06:13:00Z'),
      batch(3, 5000, '2026-08-06T10:58:00Z'),
    ];

    const result = allocateFifo(batches, 9000);

    assert.equal(result.allocations.length, 3);
    // Dua batch pertama habis, batch ketiga tersisa 3000
    assert.deepEqual(
      result.allocations.map((a) => [a.prepastId, a.qtyAllocated, a.qtyAfter, a.willClose]),
      [
        [1, 3000, 0, true],
        [2, 4000, 0, true],
        [3, 2000, 3000, false],
      ],
    );
    assert.equal(result.totalAllocated, 9000);
    assert.equal(result.unallocated, 0);
    assertKekekalan(batches, result);
  });

  test('urutan alokasi FIFO diberi nomor urut mulai dari 1', () => {
    const batches = [
      batch(1, 1000, '2026-08-06T04:20:00Z'),
      batch(2, 1000, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 2000);

    assert.deepEqual(result.allocations.map((a) => a.urutanFifo), [1, 2]);
  });

  test('batch yang tidak tersentuh tidak muncul di hasil alokasi', () => {
    const batches = [
      batch(1, 1000, '2026-08-06T04:20:00Z'),
      batch(2, 9999, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 1000);

    assert.equal(result.allocations.length, 1);
    assert.equal(result.allocations[0].prepastId, 1);
    assertKekekalan(batches, result);
  });
});

describe('allocateFifo — urutan FIFO (BR-04)', () => {
  test('mengalokasikan batch terlama lebih dulu meski urutan masukan acak', () => {
    const batches = [
      batch(3, 1000, '2026-08-06T10:58:00Z'),
      batch(1, 1000, '2026-08-06T04:20:00Z'),
      batch(2, 1000, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 2000);

    assert.deepEqual(result.allocations.map((a) => a.prepastId), [1, 2]);
  });

  test('T-5.7 dua batch berwaktu selesai identik diurutkan deterministik menurut id', () => {
    // Power Apps tidak menetapkan pemecah seri — urutannya bergantung pada
    // urutan pengembalian SharePoint, yang tidak dijamin.
    const batches = [
      batch(9, 1000, '2026-08-06T04:20:00Z'),
      batch(4, 1000, '2026-08-06T04:20:00Z'),
      batch(7, 1000, '2026-08-06T04:20:00Z'),
    ];

    const result = allocateFifo(batches, 2000);

    assert.deepEqual(result.allocations.map((a) => a.prepastId), [4, 7]);
  });

  test('masukan tidak dimutasi', () => {
    const batches = [
      batch(2, 1000, '2026-08-06T06:13:00Z'),
      batch(1, 1000, '2026-08-06T04:20:00Z'),
    ];
    const salinan = JSON.parse(JSON.stringify(batches));

    allocateFifo(batches, 1500);

    assert.deepEqual(JSON.parse(JSON.stringify(batches)), salinan);
  });
});

describe('allocateFifo — penolakan (BR-05)', () => {
  test('T-5.3 volume melebihi total tersedia menyisakan bagian tak teralokasi', () => {
    const batches = [
      batch(1, 3000, '2026-08-06T04:20:00Z'),
      batch(2, 2000, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 8000);

    assert.equal(result.totalAllocated, 5000);
    assert.equal(result.unallocated, 3000);
    assert.equal(result.isFullyAllocated, false);
    assertKekekalan(batches, result);
  });

  test('T-5.5 silo kosong menghasilkan alokasi kosong dan seluruh volume tak teralokasi', () => {
    const result = allocateFifo([], 5000);

    assert.deepEqual(result.allocations, []);
    assert.equal(result.totalAllocated, 0);
    assert.equal(result.unallocated, 5000);
    assert.equal(result.isFullyAllocated, false);
  });

  test('T-5.4 volume nol ditolak', () => {
    assert.throws(
      () => allocateFifo([batch(1, 1000, '2026-08-06T04:20:00Z')], 0),
      /volume/i,
    );
  });

  test('T-5.4 volume negatif ditolak', () => {
    assert.throws(
      () => allocateFifo([batch(1, 1000, '2026-08-06T04:20:00Z')], -100),
      /volume/i,
    );
  });

  test('volume bukan angka ditolak', () => {
    assert.throws(
      () => allocateFifo([batch(1, 1000, '2026-08-06T04:20:00Z')], Number.NaN),
      /volume/i,
    );
  });
});

describe('allocateFifo — batch bersisa nol (T-5.6)', () => {
  test('melewati batch bersisa nol tanpa menghasilkan alokasi nol', () => {
    const batches = [
      batch(1, 0, '2026-08-06T04:20:00Z'),
      batch(2, 5000, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 3000);

    assert.equal(result.allocations.length, 1);
    assert.equal(result.allocations[0].prepastId, 2);
    assert.ok(
      result.allocations.every((a) => a.qtyAllocated > 0),
      'tidak boleh ada alokasi bernilai nol',
    );
  });

  test('melewati batch bersisa negatif (data rusak) tanpa menambah volume', () => {
    const batches = [
      batch(1, -500, '2026-08-06T04:20:00Z'),
      batch(2, 1000, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 1000);

    assert.equal(result.totalAllocated, 1000);
    assert.deepEqual(result.allocations.map((a) => a.prepastId), [2]);
  });
});

describe('allocateFifo — presisi desimal (T-5.8)', () => {
  test('tidak ada liter yang hilang akibat pembulatan pecahan', () => {
    const batches = [
      batch(1, 0.1, '2026-08-06T04:20:00Z'),
      batch(2, 0.2, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 0.3);

    assert.equal(result.totalAllocated, 0.3);
    assert.equal(result.unallocated, 0);
    assert.equal(result.isFullyAllocated, true);
    assertKekekalan(batches, result);
  });

  test('menjaga presisi dua desimal pada alokasi sebagian', () => {
    const batches = [
      batch(1, 1000.55, '2026-08-06T04:20:00Z'),
      batch(2, 2000.45, '2026-08-06T06:13:00Z'),
    ];

    const result = allocateFifo(batches, 1500.75);

    assert.equal(result.allocations[0].qtyAllocated, 1000.55);
    assert.equal(result.allocations[1].qtyAllocated, 500.2);
    assert.equal(result.allocations[1].qtyAfter, 1500.25);
    assert.equal(result.unallocated, 0);
    assertKekekalan(batches, result);
  });

  test('jumlah seluruh alokasi persis sama dengan volume diminta', () => {
    const batches = [
      batch(1, 333.33, '2026-08-06T01:00:00Z'),
      batch(2, 333.33, '2026-08-06T02:00:00Z'),
      batch(3, 333.34, '2026-08-06T03:00:00Z'),
    ];

    const result = allocateFifo(batches, 1000);

    const jumlah = result.allocations.reduce((s, a) => s + a.qtyAllocated, 0);
    assert.equal(Number(jumlah.toFixed(2)), 1000);
    assert.equal(result.unallocated, 0);
  });
});

describe('allocateFifo — bentuk hasil', () => {
  test('setiap alokasi membawa data yang dibutuhkan transfer_allocation', () => {
    const batches = [batch(1, 5000, '2026-08-06T04:20:00Z', 42)];

    const result = allocateFifo(batches, 2000);
    const a = result.allocations[0];

    assert.deepEqual(Object.keys(a).sort(), [
      'prepastId',
      'prepastKode',
      'qtyAfter',
      'qtyAllocated',
      'qtyAvailable',
      'supplierId',
      'urutanFifo',
      'willClose',
    ]);
    assert.equal(a.supplierId, 42);
    assert.equal(a.prepastKode, 'PST-20260806-001');
    assert.equal(a.qtyAvailable, 5000);
  });

  test('isFullyAllocated bernilai benar ketika seluruh volume terpenuhi', () => {
    const batches = [batch(1, 5000, '2026-08-06T04:20:00Z')];

    assert.equal(allocateFifo(batches, 5000).isFullyAllocated, true);
    assert.equal(allocateFifo(batches, 4999).isFullyAllocated, true);
    assert.equal(allocateFifo(batches, 5001).isFullyAllocated, false);
  });
});
