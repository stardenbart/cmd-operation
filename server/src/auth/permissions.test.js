/**
 * Uji matriks wewenang — PRD 2.10.1, BR-22, uji T-16
 *
 * Matriks ini adalah satu-satunya sumber kebenaran otorisasi. Di Power Apps
 * wewenang tersebar sebagai variabel global yang dihitung ulang di beberapa
 * tempat, sehingga sempat tidak sinkron (B-21): `varIsSpv` bernilai berbeda
 * di layar login dan di Data List.
 *
 * Ditulis sebagai fungsi murni supaya seluruh 36 kombinasi peran × tindakan
 * dapat diperiksa tanpa basis data.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  can, AKSI, PERAN, aksiUntukPeran, aksiUntukUser, customPermissionsBersih,
} from './permissions.js';

describe('matriks wewenang — Operator', () => {
  test('boleh menginput seluruh modul transaksi', () => {
    assert.equal(can('Operator', AKSI.TRANSAKSI_BUAT), true);
  });

  test('boleh menyunting record pending/rejected miliknya', () => {
    assert.equal(can('Operator', AKSI.TRANSAKSI_SUNTING_PENDING), true);
  });

  test('boleh mengajukan permintaan koreksi atas record Approved', () => {
    assert.equal(can('Operator', AKSI.KOREKSI_AJUKAN), true);
  });

  test('TIDAK boleh menyunting record Approved secara langsung', () => {
    assert.equal(can('Operator', AKSI.TRANSAKSI_SUNTING_APPROVED), false);
  });

  test('TIDAK boleh menyetujui maupun menolak', () => {
    assert.equal(can('Operator', AKSI.APPROVAL_PUTUSKAN), false);
    assert.equal(can('Operator', AKSI.APPROVAL_MASSAL), false);
  });

  test('TIDAK boleh mem-void', () => {
    assert.equal(can('Operator', AKSI.RECORD_VOID), false);
  });

  test('TIDAK boleh mengakses stock opname, export, maupun master data', () => {
    assert.equal(can('Operator', AKSI.STOCK_OPNAME_KELOLA), false);
    assert.equal(can('Operator', AKSI.EXPORT_JALANKAN), false);
    assert.equal(can('Operator', AKSI.MASTER_KELOLA), false);
  });

  test('boleh melihat dashboard', () => {
    assert.equal(can('Operator', AKSI.DASHBOARD_LIHAT), true);
  });
});

describe('matriks wewenang — SPV', () => {
  test('boleh menginput transaksi seperti Operator', () => {
    assert.equal(can('SPV', AKSI.TRANSAKSI_BUAT), true);
  });

  test('boleh menyunting record Approved secara langsung', () => {
    assert.equal(can('SPV', AKSI.TRANSAKSI_SUNTING_APPROVED), true);
  });

  test('boleh menyetujui, menolak, dan menyetujui secara massal', () => {
    assert.equal(can('SPV', AKSI.APPROVAL_PUTUSKAN), true);
    assert.equal(can('SPV', AKSI.APPROVAL_MASSAL), true);
  });

  test('boleh meninjau permintaan koreksi', () => {
    assert.equal(can('SPV', AKSI.KOREKSI_TINJAU), true);
  });

  test('boleh mem-void termasuk cascade', () => {
    assert.equal(can('SPV', AKSI.RECORD_VOID), true);
  });

  test('boleh menjalankan export', () => {
    assert.equal(can('SPV', AKSI.EXPORT_JALANKAN), true);
  });

  test('TIDAK boleh mengelola stock opname — itu wewenang Admin', () => {
    assert.equal(can('SPV', AKSI.STOCK_OPNAME_KELOLA), false);
  });

  test('TIDAK boleh mengelola master data — itu wewenang Admin', () => {
    assert.equal(can('SPV', AKSI.MASTER_KELOLA), false);
  });

  test('TIDAK boleh mengajukan permintaan koreksi — ia yang memutuskan', () => {
    assert.equal(can('SPV', AKSI.KOREKSI_AJUKAN), false);
  });
});

describe('matriks wewenang — Admin', () => {
  test('boleh mengelola stock opname', () => {
    assert.equal(can('Admin', AKSI.STOCK_OPNAME_KELOLA), true);
  });

  test('boleh menjalankan export — tugas hariannya', () => {
    assert.equal(can('Admin', AKSI.EXPORT_JALANKAN), true);
  });

  test('boleh mengelola master data', () => {
    assert.equal(can('Admin', AKSI.MASTER_KELOLA), true);
  });

  test('TIDAK menginput transaksi harian (D-14)', () => {
    assert.equal(can('Admin', AKSI.TRANSAKSI_BUAT), false);
    assert.equal(can('Admin', AKSI.TRANSAKSI_SUNTING_PENDING), false);
  });

  test('TIDAK mewarisi wewenang approval dari SPV (BR-22)', () => {
    assert.equal(can('Admin', AKSI.APPROVAL_PUTUSKAN), false);
    assert.equal(can('Admin', AKSI.APPROVAL_MASSAL), false);
    assert.equal(can('Admin', AKSI.KOREKSI_TINJAU), false);
  });

  test('TIDAK mewarisi wewenang void dari SPV (BR-22)', () => {
    assert.equal(can('Admin', AKSI.RECORD_VOID), false);
  });

  test('boleh melihat dashboard', () => {
    assert.equal(can('Admin', AKSI.DASHBOARD_LIHAT), true);
  });
});

describe('matriks wewenang — sifat menyeluruh', () => {
  test('Admin bukan superset SPV — masing-masing punya wewenang eksklusif', () => {
    const spv = new Set(aksiUntukPeran('SPV'));
    const admin = new Set(aksiUntukPeran('Admin'));

    const hanyaSpv = [...spv].filter((a) => !admin.has(a));
    const hanyaAdmin = [...admin].filter((a) => !spv.has(a));

    assert.ok(hanyaSpv.length > 0, 'SPV harus punya wewenang yang tidak dimiliki Admin');
    assert.ok(hanyaAdmin.length > 0, 'Admin harus punya wewenang yang tidak dimiliki SPV');
  });

  test('setiap peran punya entri eksplisit untuk setiap tindakan', () => {
    // Mencegah kelas bug "tindakan baru ditambahkan lalu diam-diam bernilai
    // undefined" — yang berarti terlarang, tetapi tanpa keputusan sadar.
    for (const peran of Object.values(PERAN)) {
      for (const aksi of Object.values(AKSI)) {
        assert.equal(
          typeof can(peran, aksi),
          'boolean',
          `wewenang ${peran} × ${aksi} tidak ditetapkan secara eksplisit`,
        );
      }
    }
  });

  test('peran tidak dikenal ditolak untuk seluruh tindakan', () => {
    for (const aksi of Object.values(AKSI)) {
      assert.equal(can('Superuser', aksi), false);
      assert.equal(can(undefined, aksi), false);
      assert.equal(can(null, aksi), false);
    }
  });

  test('tindakan tidak dikenal ditolak untuk seluruh peran', () => {
    for (const peran of Object.values(PERAN)) {
      assert.equal(can(peran, 'hapus:semuanya'), false);
      assert.equal(can(peran, undefined), false);
    }
  });

  test('aksiUntukPeran mengembalikan senarai kosong untuk peran tak dikenal', () => {
    assert.deepEqual(aksiUntukPeran('Hantu'), []);
  });
});

describe('matriks wewenang — Viewer (FR-34.1)', () => {
  test('T-46: hanya berwenang dashboard:lihat; seluruh aksi lain ditolak', () => {
    for (const aksi of Object.values(AKSI)) {
      const diharapkan = aksi === AKSI.DASHBOARD_LIHAT;
      assert.equal(can('Viewer', aksi), diharapkan, `Viewer × ${aksi}`);
    }
  });

  test('Viewer punya entri eksplisit untuk setiap tindakan', () => {
    for (const aksi of Object.values(AKSI)) {
      assert.equal(typeof can('Viewer', aksi), 'boolean', `Viewer × ${aksi} tak eksplisit`);
    }
  });
});

describe('hak akses custom (FR-34.2, BR-27)', () => {
  test('T-47: can() true bila aksi ada di customPermissions walau matriks menolak', () => {
    assert.equal(can('Viewer', AKSI.EXPORT_JALANKAN), false);
    assert.equal(can('Viewer', AKSI.EXPORT_JALANKAN, [AKSI.EXPORT_JALANKAN]), true);
  });

  test('aditif — matriks yang mengizinkan tetap izin, custom tak dapat mencabut', () => {
    assert.equal(can('Viewer', AKSI.DASHBOARD_LIHAT, []), true);
    assert.equal(can('Operator', AKSI.TRANSAKSI_BUAT, []), true);
  });

  test('customPermissions non-array diabaikan', () => {
    assert.equal(can('Viewer', AKSI.EXPORT_JALANKAN, null), false);
    assert.equal(can('Viewer', AKSI.EXPORT_JALANKAN, 'export:jalankan'), false);
  });

  test('aksiUntukUser = gabungan aksi peran + custom, tanpa duplikat (FR-34.2.5)', () => {
    const aksi = aksiUntukUser('Viewer', [AKSI.EXPORT_JALANKAN, AKSI.DASHBOARD_LIHAT]);
    assert.ok(aksi.includes(AKSI.DASHBOARD_LIHAT));
    assert.ok(aksi.includes(AKSI.EXPORT_JALANKAN));
    assert.equal(new Set(aksi).size, aksi.length);
  });

  test('aksiUntukUser mengabaikan custom yang bukan AKSI valid', () => {
    const aksi = aksiUntukUser('Viewer', ['hapus:dunia', AKSI.EXPORT_JALANKAN]);
    assert.ok(!aksi.includes('hapus:dunia'));
    assert.ok(aksi.includes(AKSI.EXPORT_JALANKAN));
  });

  test('T-51: customPermissionsBersih membuang aksi yang sudah dimiliki peran baru', () => {
    const bersih = customPermissionsBersih('Operator', [AKSI.TRANSAKSI_BUAT, AKSI.EXPORT_JALANKAN]);
    assert.deepEqual(bersih, [AKSI.EXPORT_JALANKAN]);
  });

  test('customPermissionsBersih membuang aksi tak dikenal & duplikat', () => {
    const bersih = customPermissionsBersih('Viewer', ['hapus:dunia', AKSI.EXPORT_JALANKAN, AKSI.EXPORT_JALANKAN]);
    assert.deepEqual(bersih, [AKSI.EXPORT_JALANKAN]);
  });
});
