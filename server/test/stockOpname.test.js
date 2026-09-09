/**
 * Uji integrasi Stock Opname - FR-8, FR-24, BR-20, memperbaiki B-2 & B-3
 *
 * Dua bug lama yang diuji di sini bukan salah ketik, melainkan kelemahan
 * struktur, jadi ujinya menyasar strukturnya:
 *
 *  B-2  upsert tidak pernah bekerja. Diuji dengan menyimpan silo yang sama dua
 *       kali dan menuntut hasilnya SATU baris yang diperbarui.
 *  B-3  validasi tidak menghentikan penyimpanan. Diuji dengan memfinalisasi
 *       periode yang belum lengkap dan menuntutnya DITOLAK.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let so;

const SILO = { satu: 2, dua: 3, enam: 7 };

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  so = await import('../src/services/stockOpname.js');
});

beforeEach(reset);
after(tutup);

const PERIODE = '2026-08';

/** Mengisi seluruh silo wajib, supaya periodenya siap difinalisasi. */
async function isiSemua(nilai = 100) {
  const isi = await so.daftar(PERIODE);
  for (const b of isi.baris) {
    await so.simpanBaris(
      { periode: PERIODE, siloId: b.siloId, jumlahAwalLtr: nilai },
      AKTOR.admin,
      IP_UJI,
    );
  }
  return isi.baris.length;
}

describe('BR-22 - stock opname wewenang Admin semata', () => {
  test('SPV ditolak menyimpan, meski perannya lebih tinggi di area lain', async () => {
    await assert.rejects(
      () =>
        so.simpanBaris(
          { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 100 },
          AKTOR.spv,
          IP_UJI,
        ),
      (err) => {
        assert.match(err.message, /berwenang/i);
        return true;
      },
    );
  });

  test('Operator ditolak memfinalisasi', async () => {
    await assert.rejects(
      () => so.finalisasi(PERIODE, AKTOR.operator, IP_UJI),
      (err) => {
        assert.match(err.message, /berwenang/i);
        return true;
      },
    );
  });
});

describe('B-2 - upsert per (periode, silo)', () => {
  test('menyimpan silo yang sama dua kali menghasilkan SATU baris', async () => {
    await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 1200 },
      AKTOR.admin, IP_UJI,
    );
    const kedua = await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 1500 },
      AKTOR.admin, IP_UJI,
    );

    assert.equal(kedua.cara, 'diperbarui');

    const [baris] = await pool.query(
      'SELECT jumlah_awal_ltr FROM stock_opname WHERE periode = ? AND silo_id = ?',
      [PERIODE, SILO.satu],
    );
    assert.equal(baris.length, 1, 'tidak boleh menjadi dua baris');
    assert.equal(Number(baris[0].jumlah_awal_ltr), 1500, 'nilainya yang terbaru');
  });

  test('periode berbeda untuk silo yang sama adalah baris berbeda', async () => {
    await so.simpanBaris(
      { periode: '2026-08', siloId: SILO.satu, jumlahAwalLtr: 100 },
      AKTOR.admin, IP_UJI,
    );
    await so.simpanBaris(
      { periode: '2026-09', siloId: SILO.satu, jumlahAwalLtr: 200 },
      AKTOR.admin, IP_UJI,
    );

    const [baris] = await pool.query(
      'SELECT periode, jumlah_awal_ltr FROM stock_opname WHERE silo_id = ? ORDER BY periode',
      [SILO.satu],
    );
    assert.equal(baris.length, 2);
    assert.equal(Number(baris[0].jumlah_awal_ltr), 100);
    assert.equal(Number(baris[1].jumlah_awal_ltr), 200);
  });
});

describe('B-3 - validasi yang benar-benar memblokir', () => {
  /**
   * Perbaikan strukturalnya: menyimpan satu baris TIDAK menuntut kelengkapan,
   * memfinalisasi periode menuntutnya. Admin karena itu dapat mengisi bertahap
   * tanpa kehilangan pekerjaan.
   */
  test('menyimpan satu baris tidak menuntut seluruh silo terisi', async () => {
    const hasil = await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 1200 },
      AKTOR.admin, IP_UJI,
    );
    assert.equal(hasil.cara, 'dibuat');

    const isi = await so.daftar(PERIODE);
    assert.equal(isi.jumlahTerisi, 1);
    assert.ok(isi.jumlahSilo > 1, 'masih ada silo lain yang belum diisi');
  });

  test('finalisasi periode yang belum lengkap DITOLAK, dan menyebut silonya', async () => {
    await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 1200 },
      AKTOR.admin, IP_UJI,
    );

    await assert.rejects(
      () => so.finalisasi(PERIODE, AKTOR.admin, IP_UJI),
      (err) => {
        assert.equal(err.code, 'FR-8.5');
        assert.ok(err.details.siloBelumDihitung.length > 0);
        // Admin tidak boleh disuruh mencari sendiri silo mana yang kurang
        assert.match(err.message, /Belum dihitung/);
        return true;
      },
    );

    const [baris] = await pool.query(
      'SELECT COUNT(*) n FROM stock_opname WHERE periode = ? AND is_finalized = TRUE',
      [PERIODE],
    );
    assert.equal(Number(baris[0].n), 0, 'tidak ada yang terkunci');
  });

  test('periode lengkap dapat difinalisasi', async () => {
    const jumlah = await isiSemua(500);
    const hasil = await so.finalisasi(PERIODE, AKTOR.admin, IP_UJI);

    assert.equal(hasil.finalized, true);
    assert.equal(hasil.jumlahSilo, jumlah);
    assert.equal(hasil.totalLtr, 500 * jumlah);
  });
});

describe('Nol berbeda dari kosong', () => {
  /**
   * Silo yang benar-benar kosong saat dihitung adalah hasil yang SAH. Menolak
   * nol akan memaksa Admin mengisi angka palsu, dan angka itu kelak menjadi
   * dasar saldo berjalan.
   */
  test('nol tersimpan sebagai nilai, bukan ditolak', async () => {
    await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 0 },
      AKTOR.admin, IP_UJI,
    );

    const isi = await so.daftar(PERIODE);
    const baris = isi.baris.find((b) => b.siloId === SILO.satu);
    assert.equal(baris.jumlahAwalLtr, 0);
    assert.equal(baris.terisi, true, 'nol berarti sudah dihitung');
  });

  test('silo yang belum dihitung bernilai null, bukan nol', async () => {
    const isi = await so.daftar(PERIODE);
    const baris = isi.baris.find((b) => b.siloId === SILO.dua);
    assert.equal(baris.jumlahAwalLtr, null);
    assert.equal(baris.terisi, false);
  });

  test('nilai negatif ditolak', async () => {
    await assert.rejects(
      () =>
        so.simpanBaris(
          { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: -1 },
          AKTOR.admin, IP_UJI,
        ),
      (err) => {
        assert.equal(err.code, 'FR-8.5');
        return true;
      },
    );
  });
});

describe('BR-20 - periode terkunci setelah final', () => {
  test('menyimpan ke periode yang sudah final DITOLAK', async () => {
    await isiSemua(300);
    await so.finalisasi(PERIODE, AKTOR.admin, IP_UJI);

    await assert.rejects(
      () =>
        so.simpanBaris(
          { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 999 },
          AKTOR.admin, IP_UJI,
        ),
      (err) => {
        assert.equal(err.code, 'BR-20');
        return true;
      },
    );

    const [baris] = await pool.query(
      'SELECT jumlah_awal_ltr FROM stock_opname WHERE periode = ? AND silo_id = ?',
      [PERIODE, SILO.satu],
    );
    assert.equal(Number(baris[0].jumlah_awal_ltr), 300, 'nilai lama tidak tersentuh');
  });

  test('finalisasi dua kali ditolak', async () => {
    await isiSemua(300);
    await so.finalisasi(PERIODE, AKTOR.admin, IP_UJI);

    await assert.rejects(
      () => so.finalisasi(PERIODE, AKTOR.admin, IP_UJI),
      (err) => {
        assert.equal(err.code, 'BR-20');
        return true;
      },
    );
  });

  test('periode lain tidak ikut terkunci', async () => {
    await isiSemua(300);
    await so.finalisasi(PERIODE, AKTOR.admin, IP_UJI);

    const lain = await so.simpanBaris(
      { periode: '2026-09', siloId: SILO.satu, jumlahAwalLtr: 400 },
      AKTOR.admin, IP_UJI,
    );
    assert.equal(lain.cara, 'dibuat');
  });
});

describe('Validasi nilai dan periode', () => {
  test('volume melebihi batas keras silo ditolak', async () => {
    // SILO6 nominal 3.000 dengan toleransi 1.000, jadi batas kerasnya 4.000
    await assert.rejects(
      () =>
        so.simpanBaris(
          { periode: PERIODE, siloId: SILO.enam, jumlahAwalLtr: 4001 },
          AKTOR.admin, IP_UJI,
        ),
      (err) => {
        assert.equal(err.code, 'BR-24');
        assert.equal(err.details.batasKerasLtr, 4000);
        return true;
      },
    );
  });

  test('tepat pada batas keras diterima', async () => {
    const hasil = await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.enam, jumlahAwalLtr: 4000 },
      AKTOR.admin, IP_UJI,
    );
    assert.equal(hasil.jumlahAwalLtr, 4000);
  });

  test('periode yang tidak sah ditolak', async () => {
    for (const buruk of ['2026-13', '2026-8', 'Agustus', '2026']) {
      await assert.rejects(
        () =>
          so.simpanBaris(
            { periode: buruk, siloId: SILO.satu, jumlahAwalLtr: 100 },
            AKTOR.admin, IP_UJI,
          ),
        (err) => {
          assert.equal(err.code, 'FR-8.1', `periode "${buruk}" seharusnya ditolak`);
          return true;
        },
      );
    }
  });

  test('buffer tidak termasuk silo yang wajib dihitung', async () => {
    const isi = await so.daftar(PERIODE);
    assert.ok(!isi.baris.some((b) => b.kode === '000'), 'buffer dikecualikan (FR-8.2)');
  });
});

describe('Jejak audit', () => {
  test('penyimpanan dan finalisasi tercatat beserta pelakunya', async () => {
    await isiSemua(250);
    await so.finalisasi(PERIODE, AKTOR.admin, IP_UJI);

    const [jejak] = await pool.query(
      "SELECT action, actor_id FROM audit_log WHERE entity = 'stock_opname' ORDER BY id",
    );
    const aksi = jejak.map((j) => j.action);

    assert.ok(aksi.includes('CREATE'), 'penyimpanan pertama tercatat');
    assert.ok(aksi.includes('FINALIZE_SO'), 'finalisasi tercatat');
    assert.ok(jejak.every((j) => j.actor_id === AKTOR.admin.id));
  });

  test('perubahan nilai mencatat nilai sebelumnya', async () => {
    await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 100 },
      AKTOR.admin, IP_UJI,
    );
    await so.simpanBaris(
      { periode: PERIODE, siloId: SILO.satu, jumlahAwalLtr: 250 },
      AKTOR.admin, IP_UJI,
    );

    const [jejak] = await pool.query(
      "SELECT action, before_json, after_json FROM audit_log WHERE entity = 'stock_opname' ORDER BY id",
    );
    const ubah = jejak.find((j) => j.action === 'UPDATE');
    assert.ok(ubah, 'perubahan tercatat sebagai UPDATE');

    const sebelum = typeof ubah.before_json === 'string'
      ? JSON.parse(ubah.before_json) : ubah.before_json;
    assert.equal(sebelum.jumlahAwalLtr, 100, 'nilai lama tidak dikaburkan');
  });
});
