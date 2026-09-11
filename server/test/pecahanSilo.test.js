/**
 * Uji validasi pecahan multi-silo — FR-29, BR-06
 *
 * Satu penerimaan kerap diprepast ke lebih dari satu silo dengan variabel
 * proses yang identik (D-11). Power Apps memaksa operator mengisi form yang
 * sama berulang kali — itulah sumber anomali SILO25A/25A (B-18) dan sumber
 * risiko nilai tidak konsisten antar pecahan.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validasiPecahan } from '../src/services/pecahanSilo.js';

/** Menangkap error dan mengembalikan kode aturannya. */
function kodeError(fn) {
  try { fn(); return null; } catch (e) { return e.kode ?? '(tanpa kode)'; }
}

/** Kapasitas tersisa per silo, seperti dibaca dari v_silo_volume. */
const KAPASITAS = new Map([
  [2, 8000],
  [3, 12000],
  [4, 500],
]);

describe('validasiPecahan — kasus sah', () => {
  test('satu silo dengan volume penuh batch', () => {
    const hasil = validasiPecahan([{ siloId: 2, volumeLtr: 5000 }], 5000, KAPASITAS);

    assert.equal(hasil.totalLtr, 5000);
    assert.equal(hasil.sisaTakTeralokasi, 0);
  });

  test('dua silo yang menghabiskan batch', () => {
    const hasil = validasiPecahan(
      [{ siloId: 2, volumeLtr: 6455 }, { siloId: 3, volumeLtr: 5000 }],
      11455,
      KAPASITAS,
    );

    assert.equal(hasil.totalLtr, 11455);
    assert.equal(hasil.sisaTakTeralokasi, 0);
  });

  test('pecahan sebagian menyisakan volume di batch induk', () => {
    const hasil = validasiPecahan([{ siloId: 2, volumeLtr: 3000 }], 11455, KAPASITAS);

    assert.equal(hasil.totalLtr, 3000);
    assert.equal(hasil.sisaTakTeralokasi, 8455);
  });

  test('volume kosong dipertahankan sebagai NULL tanpa mengurangi batch', () => {
    const hasil = validasiPecahan([{ siloId: 2 }], 5000, KAPASITAS);

    assert.equal(hasil.totalLtr, 0);
    assert.equal(hasil.sisaTakTeralokasi, 5000);
    assert.deepEqual(hasil.pecahan, [{ siloId: 2, volumeLtr: null }]);
  });

  test('silo dan volume boleh sama-sama kosong', () => {
    const hasil = validasiPecahan([{}], 5000, KAPASITAS);

    assert.equal(hasil.totalLtr, 0);
    assert.deepEqual(hasil.pecahan, [{ siloId: null, volumeLtr: null }]);
  });

  test('menjaga presisi dua desimal', () => {
    const hasil = validasiPecahan(
      [{ siloId: 2, volumeLtr: 0.1 }, { siloId: 3, volumeLtr: 0.2 }],
      0.3,
      KAPASITAS,
    );

    assert.equal(hasil.totalLtr, 0.3);
    assert.equal(hasil.sisaTakTeralokasi, 0);
  });
});

describe('validasiPecahan — FR-29.5 silo tidak boleh berulang', () => {
  test('menolak silo yang sama dua kali', () => {
    // Inilah yang menghasilkan SILO25A/25A di form GMP (B-18).
    assert.throws(
      () => validasiPecahan(
        [{ siloId: 2, volumeLtr: 1000 }, { siloId: 2, volumeLtr: 2000 }],
        5000,
        KAPASITAS,
      ),
      /berulang|sama/i,
    );
  });

  test('menolak silo yang sama tiga kali', () => {
    assert.throws(
      () => validasiPecahan(
        [
          { siloId: 3, volumeLtr: 100 },
          { siloId: 2, volumeLtr: 100 },
          { siloId: 3, volumeLtr: 100 },
        ],
        5000,
        KAPASITAS,
      ),
      /berulang|sama/i,
    );
  });
});

describe('validasiPecahan — BR-06 tidak boleh melebihi batch induk', () => {
  test('menolak total yang melebihi sisa batch', () => {
    assert.throws(
      () => validasiPecahan([{ siloId: 2, volumeLtr: 6000 }], 5000, KAPASITAS),
      /BR-06|melebihi sisa/i,
    );
  });

  test('menolak total gabungan yang melebihi sisa batch', () => {
    assert.throws(
      () => validasiPecahan(
        [{ siloId: 2, volumeLtr: 3000 }, { siloId: 3, volumeLtr: 3000 }],
        5000,
        KAPASITAS,
      ),
      /BR-06|melebihi sisa/i,
    );
  });

  test('menerima total yang tepat sama dengan sisa batch', () => {
    const hasil = validasiPecahan([{ siloId: 2, volumeLtr: 5000 }], 5000, KAPASITAS);
    assert.equal(hasil.sisaTakTeralokasi, 0);
  });
});

describe('validasiPecahan — sisa batch belum diketahui (Receiving tanpa Berat Jenis)', () => {
  test('pecahan tanpa volume diterima, totalnya 0, sisa tak teralokasi null', () => {
    const hasil = validasiPecahan([{ siloId: 2 }], null, KAPASITAS);
    assert.equal(hasil.totalLtr, 0);
    assert.equal(hasil.sisaTakTeralokasi, null);
    assert.equal(hasil.pecahan[0].siloId, 2);
    assert.equal(hasil.pecahan[0].volumeLtr, null);
  });

  test('pecahan tanpa silo maupun volume tetap diterima', () => {
    const hasil = validasiPecahan([{}], null, KAPASITAS);
    assert.equal(hasil.totalLtr, 0);
  });

  test('pecahan dengan volume ditolak — kode BERAT_JENIS_BELUM_DIISI', () => {
    assert.throws(
      () => validasiPecahan([{ siloId: 2, volumeLtr: 1000 }], null, KAPASITAS),
      (err) => err.kode === 'BERAT_JENIS_BELUM_DIISI',
    );
  });

  test('pecahan tanpa silo tapi dengan volume tetap ditolak', () => {
    assert.throws(
      () => validasiPecahan([{ volumeLtr: 1000 }], null, KAPASITAS),
      (err) => err.kode === 'BERAT_JENIS_BELUM_DIISI',
    );
  });

  test('tidak dianggap "batch habis" — BR-06 lama tidak ikut terlempar', () => {
    // sisaBatchLtr = null tidak boleh disalahartikan sebagai 0/habis.
    const hasil = validasiPecahan([{ siloId: 2 }, { siloId: 3 }], null, KAPASITAS);
    assert.equal(hasil.totalLtr, 0);
  });
});

describe('validasiPecahan — FR-29.7 kapasitas per silo', () => {
  test('menolak volume yang melebihi kapasitas tersisa silo tujuan', () => {
    // Silo 4 hanya menyisakan 500 L
    assert.throws(
      () => validasiPecahan([{ siloId: 4, volumeLtr: 1000 }], 5000, KAPASITAS),
      /kapasitas/i,
    );
  });

  test('menerima volume yang tepat sama dengan kapasitas tersisa', () => {
    const hasil = validasiPecahan([{ siloId: 4, volumeLtr: 500 }], 5000, KAPASITAS);
    assert.equal(hasil.totalLtr, 500);
  });

  test('menolak silo yang tidak ada dalam daftar kapasitas', () => {
    assert.throws(
      () => validasiPecahan([{ siloId: 99, volumeLtr: 100 }], 5000, KAPASITAS),
      /tidak ditemukan|tidak tersedia/i,
    );
  });
});

describe('validasiPecahan — masukan tidak sah', () => {
  test('menolak daftar kosong', () => {
    assert.throws(() => validasiPecahan([], 5000, KAPASITAS), /minimal satu baris/i);
  });

  test('menolak volume nol atau negatif', () => {
    assert.throws(
      () => validasiPecahan([{ siloId: 2, volumeLtr: 0 }], 5000, KAPASITAS),
      /volume/i,
    );
    assert.throws(
      () => validasiPecahan([{ siloId: 2, volumeLtr: -100 }], 5000, KAPASITAS),
      /volume/i,
    );
  });

  test('menolak sisa batch nol — batch sudah habis', () => {
    assert.throws(
      () => validasiPecahan([{ siloId: 2, volumeLtr: 100 }], 0, KAPASITAS),
      /habis|sisa/i,
    );
  });

  test('tidak memutasi masukan', () => {
    const pecahan = [{ siloId: 2, volumeLtr: 1000 }];
    const salinan = JSON.parse(JSON.stringify(pecahan));

    validasiPecahan(pecahan, 5000, KAPASITAS);

    assert.deepEqual(pecahan, salinan);
  });
});

describe('validasiPecahan — kode aturan pada error', () => {
  test('silo berulang memakai kode FR-29.5, bukan BR-06', () => {
    assert.equal(
      kodeError(() => validasiPecahan(
        [{ siloId: 2, volumeLtr: 100 }, { siloId: 2, volumeLtr: 100 }], 5000, KAPASITAS)),
      'FR-29.5',
    );
  });

  test('total melebihi batch induk memakai kode BR-06', () => {
    // Tiap baris masih di dalam kapasitas silonya (3000 <= 8000 dan <= 12000),
    // sehingga yang dilanggar HANYA batas batch induk. Kasus yang melanggar
    // dua aturan sekaligus tidak dipakai di sini karena pemeriksaan kapasitas
    // per silo berjalan lebih dulu — dan memang seharusnya, karena errornya
    // lebih spesifik.
    assert.equal(
      kodeError(() => validasiPecahan(
        [{ siloId: 2, volumeLtr: 3000 }, { siloId: 3, volumeLtr: 3000 }],
        5000,
        KAPASITAS,
      )),
      'BR-06',
    );
  });

  test('melebihi kapasitas silo memakai kode FR-29.7', () => {
    assert.equal(
      kodeError(() => validasiPecahan([{ siloId: 4, volumeLtr: 1000 }], 5000, KAPASITAS)),
      'FR-29.7',
    );
  });

  test('silo tidak dikenal memakai kode SILO_NOT_FOUND, bukan pelanggaran aturan bisnis', () => {
    assert.equal(
      kodeError(() => validasiPecahan([{ siloId: 99, volumeLtr: 100 }], 5000, KAPASITAS)),
      'SILO_NOT_FOUND',
    );
  });
});

describe('validasiPecahan — BR-24 toleransi kapasitas', () => {
  // Parameter ke-4 adalah sisa sampai BATAS KERAS (kapasitas + toleransi),
  // dibaca langsung dari v_silo_volume.vol_tersedia_toleransi_ltr.
  //
  // Semula parameter ini berisi besar toleransi, dan pemanggil menjumlahkannya
  // sendiri dengan sisa nominal. Itu keliru: sisa nominal di-clamp ke 0 oleh
  // GREATEST(), sehingga silo yang SUDAH melampaui nominal tampak masih punya
  // toleransi penuh — toleransi terhitung dua kali. Bug ini lolos dari uji
  // buatan tangan dan baru terlihat saat diuji ke basis data sungguhan.
  const SISA_NOMINAL = new Map([[2, 8000], [3, 12000], [4, 500]]);
  const SISA_BATAS_KERAS = new Map([[2, 9000], [3, 13000], [4, 1500]]);

  test('menerima volume di dalam toleransi dan menandainya', () => {
    const hasil = validasiPecahan(
      [{ siloId: 4, volumeLtr: 1200 }], 5000, SISA_NOMINAL, SISA_BATAS_KERAS,
    );

    assert.equal(hasil.totalLtr, 1200);
    assert.deepEqual(
      hasil.melampauiNominal,
      [{ siloId: 4, volumeLtr: 1200, sisaNominalLtr: 500, kelebihanLtr: 700 }],
    );
  });

  test('menolak volume yang melampaui batas keras', () => {
    assert.equal(
      kodeError(() => validasiPecahan(
        [{ siloId: 4, volumeLtr: 1600 }], 5000, SISA_NOMINAL, SISA_BATAS_KERAS)),
      'FR-29.7',
    );
  });

  test('menerima volume tepat pada batas keras', () => {
    const hasil = validasiPecahan(
      [{ siloId: 4, volumeLtr: 1500 }], 5000, SISA_NOMINAL, SISA_BATAS_KERAS,
    );
    assert.equal(hasil.totalLtr, 1500);
  });

  test('silo yang SUDAH melampaui nominal hanya menyisakan toleransi tersisa', () => {
    // Silo penuh 6000/6000 lalu sudah kemasukan 700 L: sisa nominal 0,
    // sisa batas keras 300. Volume 500 HARUS ditolak — bukan diterima
    // karena toleransi dianggap masih utuh 1000.
    const nominalHabis = new Map([[3, 0]]);
    const batasKerasSisa = new Map([[3, 300]]);

    assert.equal(
      kodeError(() => validasiPecahan(
        [{ siloId: 3, volumeLtr: 500 }], 5000, nominalHabis, batasKerasSisa)),
      'FR-29.7',
    );

    // 300 L tepat pada batas masih diterima
    const hasil = validasiPecahan(
      [{ siloId: 3, volumeLtr: 300 }], 5000, nominalHabis, batasKerasSisa,
    );
    assert.equal(hasil.totalLtr, 300);
    assert.equal(hasil.melampauiNominal[0].kelebihanLtr, 300);
  });

  test('volume di bawah nominal tidak ditandai melampaui', () => {
    const hasil = validasiPecahan(
      [{ siloId: 2, volumeLtr: 3000 }], 5000, SISA_NOMINAL, SISA_BATAS_KERAS,
    );
    assert.deepEqual(hasil.melampauiNominal, []);
  });

  test('tanpa peta batas keras, batasnya tetap kapasitas nominal', () => {
    assert.equal(
      kodeError(() => validasiPecahan([{ siloId: 4, volumeLtr: 600 }], 5000, SISA_NOMINAL)),
      'FR-29.7',
    );
  });
});
