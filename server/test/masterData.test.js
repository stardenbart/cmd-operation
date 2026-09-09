/**
 * Uji integrasi manajemen master data - FR-26
 *
 * Master data adalah bagian catatan mutu: menghapus supplier membuat baris
 * form lama kehilangan nama pemasoknya, dan menurunkan kapasitas silo di bawah
 * isinya membuat angka kapasitas berbohong. Karena itu yang diuji di sini
 * terutama PENJAGANYA, bukan sekadar jalur suksesnya.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let md;
let receiving;
let prepast;

const SILO = { buffer: 1, satu: 2, enam: 7 };
const W = (hari, jam) => new Date(2026, 7, hari, jam);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  md = await import('../src/services/masterData.js');
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
});

beforeEach(reset);
after(tutup);

/** Mengisi SILO1 supaya penjaga yang bergantung pada isi silo dapat diuji. */
async function isiSilo(volumeLtr) {
  const rcv = await receiving.buat(
    { supplierId: 1, qtyKg: volumeLtr, beratJenis: 1, nilaiTs: 12.4, finishTime: W(10, 6) },
    AKTOR.operator, IP_UJI,
  );
  await prepast.buat(
    {
      receivingId: rcv.id,
      pecahan: [{ siloId: SILO.satu, volumeLtr }],
      prepastStart: W(10, 7), prepastFinish: W(10, 8),
      flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
    },
    AKTOR.operator, IP_UJI,
  );
}

describe('BR-22 - master data wewenang Admin semata', () => {
  test('SPV dan Operator ditolak menyunting', async () => {
    for (const aktor of [AKTOR.spv, AKTOR.operator]) {
      await assert.rejects(
        () => md.perbarui('suppliers', 1, { supplier_name: 'Coba' }, aktor, IP_UJI),
        (err) => {
          assert.match(err.message, /berwenang/i);
          return true;
        },
      );
    }
  });

  test('membaca daftar tidak menuntut wewenang Admin', async () => {
    const isi = await md.daftar('suppliers', {});
    assert.ok(isi.data.length > 0);
  });
});

describe('FR-26.2.6 - kapasitas silo tidak boleh di bawah isinya', () => {
  test('penurunan di bawah volume tersimpan DITOLAK', async () => {
    await isiSilo(4000);

    await assert.rejects(
      () => md.perbarui('silos', SILO.satu, { kapasitas_maks_ltr: 2000 }, AKTOR.admin, IP_UJI),
      (err) => {
        assert.equal(err.code, 'FR-26.2.6');
        assert.equal(err.details.volumeSaatIniLtr, 4000);
        return true;
      },
    );

    const [baris] = await pool.query('SELECT kapasitas_maks_ltr FROM silo WHERE id = ?', [SILO.satu]);
    assert.equal(Number(baris[0].kapasitas_maks_ltr), 5000, 'nilai lama tidak tersentuh');
  });

  /** Batas kerasnya nominal + toleransi, bukan nominal saja (BR-24). */
  test('penurunan yang masih tertutup toleransi diterima', async () => {
    await isiSilo(3500);

    // 3.000 nominal + 1.000 toleransi = 4.000, dan isinya 3.500
    const hasil = await md.perbarui(
      'silos', SILO.satu, { kapasitas_maks_ltr: 3000 }, AKTOR.admin, IP_UJI,
    );
    assert.equal(Number(hasil.data.kapasitas_maks_ltr), 3000);
  });

  test('menaikkan kapasitas selalu boleh', async () => {
    await isiSilo(4000);
    const hasil = await md.perbarui(
      'silos', SILO.satu, { kapasitas_maks_ltr: 8000 }, AKTOR.admin, IP_UJI,
    );
    assert.equal(Number(hasil.data.kapasitas_maks_ltr), 8000);
  });

  test('silo yang masih berisi tidak dapat dinonaktifkan', async () => {
    await isiSilo(1000);

    await assert.rejects(
      () => md.perbarui('silos', SILO.satu, { is_active: false }, AKTOR.admin, IP_UJI),
      (err) => {
        assert.equal(err.details.volumeSaatIniLtr, 1000);
        return true;
      },
    );
  });
});

describe('Penjaga akun - sistem harus tetap dapat dikelola', () => {
  test('Admin tidak dapat menonaktifkan akunnya sendiri', async () => {
    await assert.rejects(
      () => md.perbarui('users', AKTOR.admin.id, { is_active: false }, AKTOR.admin, IP_UJI),
      (err) => {
        assert.match(err.message, /akun Anda sendiri/);
        return true;
      },
    );
  });

  test('Admin terakhir tidak dapat menurunkan perannya', async () => {
    await assert.rejects(
      () => md.perbarui('users', AKTOR.admin.id, { role: 'Operator' }, AKTOR.admin, IP_UJI),
      (err) => {
        assert.match(err.message, /satu-satunya Admin/);
        return true;
      },
    );
  });

  test('setelah ada Admin kedua, Admin pertama boleh diturunkan', async () => {
    const { data: kedua } = await md.buat(
      'users',
      { kode: 'ADM2', username: 'adm2', nama_lengkap: 'Admin Kedua', role: 'Admin', is_active: true },
      AKTOR.admin, IP_UJI,
    );
    assert.equal(kedua.role, 'Admin');

    const hasil = await md.perbarui(
      'users', AKTOR.admin.id, { role: 'SPV' }, AKTOR.admin, IP_UJI,
    );
    assert.equal(hasil.data.role, 'SPV');
    assert.match(hasil.catatan, /sesi berikutnya/, 'FR-26.2.7 diberitahukan');
  });
});

describe('FR-26.2.5 - reset password', () => {
  test('password sementara dikembalikan sekali dan wajib diganti', async () => {
    const hasil = await md.resetPassword(AKTOR.operator.id, AKTOR.admin, IP_UJI);

    assert.equal(hasil.kode, AKTOR.operator.kode);
    // Abjadnya sengaja tanpa O, 0, I, l, 1 - password ini dibacakan dari layar.
    assert.match(hasil.passwordSementara, /^[A-HJ-NP-Za-km-z2-9]+-[A-HJ-NP-Za-km-z2-9]+$/);
    assert.ok(hasil.passwordSementara.length >= 8);

    const [baris] = await pool.query(
      'SELECT must_change_password, password_hash FROM operator WHERE id = ?',
      [AKTOR.operator.id],
    );
    assert.equal(Boolean(baris[0].must_change_password), true);
    assert.ok(
      !baris[0].password_hash.includes(hasil.passwordSementara),
      'yang tersimpan hash, bukan passwordnya',
    );
  });

  test('sesi yang sedang berjalan ikut dicabut', async () => {
    /*
     * Reset dilakukan karena pemiliknya tidak dapat masuk, ATAU karena
     * kredensialnya dicurigai bocor. Pada kemungkinan kedua, sesi lama yang
     * tetap hidup membuat reset ini tidak mengusir siapa pun.
     */
    await pool.query(
      `INSERT INTO refresh_token (operator_id, token_hash, expires_at)
       VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))`,
      [AKTOR.operator.id, 'hash-uji-sesi-lama'],
    );

    await md.resetPassword(AKTOR.operator.id, AKTOR.admin, IP_UJI);

    const [sisa] = await pool.query(
      'SELECT COUNT(*) n FROM refresh_token WHERE operator_id = ? AND revoked_at IS NULL',
      [AKTOR.operator.id],
    );
    assert.equal(Number(sisa[0].n), 0);
  });

  /**
   * Password adalah kredensial pemiliknya. Jejak audit yang memuatnya akan
   * membuat kredensial itu dapat dipakai orang lain, dan jejak audit justru
   * tempat yang paling banyak dibaca saat diaudit.
   */
  test('jejak audit TIDAK memuat passwordnya', async () => {
    const hasil = await md.resetPassword(AKTOR.operator.id, AKTOR.admin, IP_UJI);

    const [jejak] = await pool.query(
      "SELECT before_json, after_json FROM audit_log WHERE action = 'PIN_RESET' ORDER BY id DESC LIMIT 1",
    );
    const teks = JSON.stringify(jejak[0]);

    assert.ok(!teks.includes(hasil.passwordSementara), 'password tidak boleh ada di jejak audit');
    assert.ok(!teks.includes('password_hash'), 'hash pun tidak perlu ada di sana');
  });

  test('reset password membuka kunci akun yang sedang terkunci', async () => {
    await pool.query(
      'UPDATE operator SET failed_attempts = 5, locked_until = ? WHERE id = ?',
      [new Date(Date.now() + 3_600_000), AKTOR.operator.id],
    );

    await md.resetPassword(AKTOR.operator.id, AKTOR.admin, IP_UJI);

    const [baris] = await pool.query(
      'SELECT failed_attempts, locked_until FROM operator WHERE id = ?',
      [AKTOR.operator.id],
    );
    assert.equal(Number(baris[0].failed_attempts), 0);
    assert.equal(baris[0].locked_until, null);
  });
});

describe('Keunikan dan kolom terkunci', () => {
  test('kode ganda ditolak dengan pesan yang terbaca', async () => {
    const [ada] = await pool.query('SELECT kode FROM supplier LIMIT 1');

    await assert.rejects(
      () => md.buat('suppliers', { kode: ada[0].kode, supplier_name: 'Kembar' }, AKTOR.admin, IP_UJI),
      (err) => {
        assert.match(err.message, /sudah dipakai entri lain/);
        return true;
      },
    );
  });

  /**
   * BR-02 menggantungkan seluruh alur penerimaan pada `is_buffer`. Mengubahnya
   * lewat layar master akan memindahkan tujuan penerimaan tanpa ada yang
   * menyadarinya, jadi kolomnya tidak pernah diterima.
   */
  test('is_buffer tidak dapat diubah lewat master data', async () => {
    await assert.rejects(
      () => md.perbarui('silos', SILO.buffer, { is_buffer: false }, AKTOR.admin, IP_UJI),
      (err) => {
        assert.match(err.message, /Tidak ada nilai yang diubah/);
        return true;
      },
    );

    const [baris] = await pool.query('SELECT is_buffer FROM silo WHERE id = ?', [SILO.buffer]);
    assert.equal(Boolean(baris[0].is_buffer), true);
  });

  test('kode prefiks batch dinaikkan menjadi huruf besar', async () => {
    const { data } = await md.buat(
      'batch-prefixes',
      { kode: 'xyz', label: 'Uji', is_standar: false, urutan: 99, is_active: true },
      AKTOR.admin, IP_UJI,
    );
    assert.equal(data.kode, 'XYZ');
  });
});

describe('FR-26.2.1 - dinonaktifkan, tidak dihapus', () => {
  test('layanan ini tidak menyediakan penghapusan sama sekali', () => {
    assert.equal(typeof md.hapus, 'undefined');
    assert.equal(typeof md.buat, 'function');
    assert.equal(typeof md.perbarui, 'function');
  });

  test('jumlah pemakaian ditampilkan supaya dampaknya terlihat lebih dulu', async () => {
    await isiSilo(1000);

    const isi = await md.daftar('silos', {});
    const silo1 = isi.data.find((d) => d.id === SILO.satu);
    assert.ok(silo1.jumlahPemakaian > 0, 'silo yang dipakai transaksi terlihat pemakaiannya');
  });

  test('entri nonaktif tetap ada dan dapat disaring', async () => {
    await md.perbarui('suppliers', 1, { is_active: false }, AKTOR.admin, IP_UJI);

    const nonaktif = await md.daftar('suppliers', { status: 'nonaktif' });
    const aktif = await md.daftar('suppliers', { status: 'aktif' });
    const semua = await md.daftar('suppliers', { status: 'semua' });

    assert.equal(nonaktif.data.length, 1);
    assert.equal(semua.data.length, aktif.data.length + nonaktif.data.length);
  });
});

describe('FR-26.2.2 & FR-26.2.3 - jejak dan riwayat', () => {
  test('perubahan mencatat nilai sebelum dan sesudah', async () => {
    await md.perbarui('silos', SILO.enam, { monitoring_interval_jam: 2 }, AKTOR.admin, IP_UJI);

    const riwayat = await md.riwayat('silos', SILO.enam);
    assert.equal(riwayat.length, 1);
    assert.equal(riwayat[0].aksi, 'UPDATE');
    assert.equal(riwayat[0].aktor, AKTOR.admin.nama);

    // Hanya kolom yang BERUBAH yang dicatat, supaya perubahan satu kolom tidak
    // tenggelam di antara belasan kolom yang sama persis.
    assert.deepEqual(Object.keys(riwayat[0].sesudah.perubahan), ['monitoring_interval_jam']);
    assert.equal(riwayat[0].sesudah.perubahan.monitoring_interval_jam.dari, 4);
    assert.equal(riwayat[0].sesudah.perubahan.monitoring_interval_jam.menjadi, 2);
  });

  test('pembuatan entri tercatat', async () => {
    const { data } = await md.buat(
      'suppliers', { kode: 'UJI01', supplier_name: 'Supplier Uji' }, AKTOR.admin, IP_UJI,
    );

    const riwayat = await md.riwayat('suppliers', data.id);
    assert.equal(riwayat[0].aksi, 'CREATE');
    assert.equal(riwayat[0].sesudah.supplier_name, 'Supplier Uji');
  });
});

describe('BR-10 - interval monitoring adalah kolom, bukan nama silo', () => {
  /**
   * B-19: ambangnya dicocokkan dari string `"SILO 25A"` yang tidak pernah cocok
   * karena nama sesungguhnya `SILO25A` tanpa spasi, sehingga ambang 2 jam tidak
   * pernah berlaku. Di sini ambangnya kolom yang dapat disunting (FR-26.2.4).
   */
  test('ambang dapat disunting per silo', async () => {
    const hasil = await md.perbarui(
      'silos', SILO.enam, { monitoring_interval_jam: 3 }, AKTOR.admin, IP_UJI,
    );
    assert.equal(hasil.data.monitoring_interval_jam, 3);
  });

  test('seed memberi SILO25A dan 25B ambang 2 jam, sisanya 4 jam', async () => {
    const isi = await md.daftar('silos', {});
    const peta = new Map(isi.data.map((d) => [d.kode, d.monitoring_interval_jam]));

    assert.equal(peta.get('25A'), 2);
    assert.equal(peta.get('25B'), 2);
    assert.equal(peta.get('1'), 4);
  });
});

describe('FR-26.2.8 - export CSV', () => {
  test('CSV memuat kepala berlabel dan jumlah pemakaian', async () => {
    const csv = await md.keCsv('suppliers');
    const baris = csv.split('\n');

    assert.match(baris[0], /Nama supplier/);
    assert.match(baris[0], /jumlah_pemakaian/);
    assert.ok(baris.length > 2);
  });
});

describe('FR-34 - hak akses custom', () => {
  test('T-50: Admin memberi hak akses custom; aksi redundan dibuang', async () => {
    // transaksi:buat sudah dimiliki Operator -> dibuang; export:jalankan disimpan.
    const hasil = await md.aturHakAkses(
      AKTOR.operator.id, ['transaksi:buat', 'export:jalankan'], AKTOR.admin, IP_UJI,
    );
    assert.deepEqual(hasil.customPermissions, ['export:jalankan']);

    const konteks = await md.hakAksesUser(AKTOR.operator.id);
    assert.deepEqual(konteks.customPermissions, ['export:jalankan']);
    assert.ok(konteks.tersedia.some((t) => t.aksi === 'export:jalankan'));
    assert.ok(!konteks.tersedia.some((t) => t.aksi === 'transaksi:buat'));
  });

  test('menghapus hak akses custom (array kosong -> NULL)', async () => {
    await md.aturHakAkses(AKTOR.operator.id, ['export:jalankan'], AKTOR.admin, IP_UJI);
    const hasil = await md.aturHakAkses(AKTOR.operator.id, [], AKTOR.admin, IP_UJI);
    assert.deepEqual(hasil.customPermissions, []);
    const [b] = await pool.query(
      'SELECT custom_permissions FROM operator WHERE id = ?', [AKTOR.operator.id],
    );
    assert.equal(b[0].custom_permissions, null);
  });

  test('perubahan hak akses tercatat di audit_log (sebelum & sesudah)', async () => {
    await md.aturHakAkses(AKTOR.operator.id, ['export:jalankan'], AKTOR.admin, IP_UJI);
    const [a] = await pool.query(
      "SELECT action, after_json FROM audit_log WHERE entity='operator' AND action='HAK_AKSES' ORDER BY id DESC LIMIT 1",
    );
    assert.ok(a[0], 'jejak HAK_AKSES ada');
    assert.match(JSON.stringify(a[0].after_json), /export:jalankan/);
  });

  test('T-51: mengubah peran membersihkan hak akses custom yang kini redundan', async () => {
    await md.aturHakAkses(AKTOR.operator.id, ['export:jalankan'], AKTOR.admin, IP_UJI);
    await md.perbarui('users', AKTOR.operator.id, { role: 'SPV' }, AKTOR.admin, IP_UJI);
    const [b] = await pool.query(
      'SELECT role, custom_permissions FROM operator WHERE id = ?', [AKTOR.operator.id],
    );
    assert.equal(b[0].role, 'SPV');
    assert.equal(b[0].custom_permissions, null, 'export:jalankan sudah dimiliki SPV -> dibersihkan');
  });

  test('non-Admin ditolak mengatur hak akses', async () => {
    await assert.rejects(
      () => md.aturHakAkses(AKTOR.operator.id, ['export:jalankan'], AKTOR.operator, IP_UJI),
      (err) => { assert.match(err.message, /tidak berwenang/i); return true; },
    );
  });
});
