/**
 * Monitoring — jejak celah jadwal (BR-10) & volume kosong tidak lagi
 * mengunci input.
 *
 * v_silo_monitoring_status hanya membandingkan SEKARANG dengan cek terakhir
 * — begitu ada cek baru (biarpun telat), status live-nya langsung "OK" lagi
 * dan jejak satu jadwal cek terlewat di antaranya hilang sama sekali. Yang
 * diuji di sini: jejak itu SEKARANG tersimpan permanen di baris cek yang
 * menyusul (jam_sejak_cek_sebelumnya, lewat_jadwal), dihitung terhadap cek
 * yang KRONOLOGISNYA mendahului — bukan sekadar "yang terakhir di-insert" —
 * supaya pengisian backdated tetap benar.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let monitoring;
let dataList;

// SILO1 (id 2) — monitoring_interval_jam 4 (lihat db/seeds/001_master_seed.sql).
const SILO = 2;
const T = (jam, menit = 0, hari = 14) => new Date(2026, 8, hari, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  monitoring = await import('../src/services/monitoring.js');
  dataList = await import('../src/services/dataList.js');
});

beforeEach(reset);
after(tutup);

/** Mengisi SILO1 supaya volumenya > 0 untuk pengujian. */
async function isiSilo(volumeLtr = 1000) {
  const rcv = await receiving.buat(
    { supplierId: 1, qtyKg: volumeLtr, beratJenis: 1, nilaiTs: 12.4, finishTime: T(5) },
    AKTOR.operator, IP_UJI,
  );
  await prepast.buat(
    {
      receivingId: rcv.id,
      pecahan: [{ siloId: SILO, volumeLtr }],
      prepastStart: T(5, 30), prepastFinish: T(5, 45),
      flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
    },
    AKTOR.operator, IP_UJI,
  );
}

describe('simpanRonde — jejak celah jadwal', () => {
  test('cek pertama pada silo: jam_sejak_cek_sebelumnya NULL, tidak ditandai lewat jadwal', async () => {
    await isiSilo();
    const hasil = await monitoring.simpanRonde(
      { timeCheck: T(6), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    assert.equal(hasil.lewatJadwal.length, 0);
    assert.equal(hasil.dibuat[0].lewatJadwal, false);

    const [[baris]] = await pool.query(
      'SELECT jam_sejak_cek_sebelumnya, lewat_jadwal FROM monitoring WHERE id = ?',
      [hasil.dibuat[0].id],
    );
    assert.equal(baris.jam_sejak_cek_sebelumnya, null);
    assert.equal(Boolean(baris.lewat_jadwal), false);
  });

  test('cek berikutnya MASIH DALAM ambang (4 jam) — tidak ditandai', async () => {
    await isiSilo();
    await monitoring.simpanRonde(
      { timeCheck: T(6), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    const hasil = await monitoring.simpanRonde(
      { timeCheck: T(10), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] }, // +4 jam, tepat di ambang
      AKTOR.operator, IP_UJI,
    );
    assert.equal(hasil.lewatJadwal.length, 0);
    assert.equal(hasil.dibuat[0].lewatJadwal, false);
  });

  test('cek berikutnya MELEBIHI ambang — ditandai lewat jadwal, dikembalikan di response', async () => {
    await isiSilo();
    await monitoring.simpanRonde(
      { timeCheck: T(6), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    // Loncat langsung ke jam 11 — persis skenario yang dilaporkan pengguna:
    // jam 9 (yang seharusnya jadi cek berikutnya dalam ambang 4 jam) terlewat.
    const hasil = await monitoring.simpanRonde(
      { timeCheck: T(11), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    assert.equal(hasil.lewatJadwal.length, 1);
    assert.equal(hasil.lewatJadwal[0].jamSejakCekSebelumnya, 5);
    assert.equal(hasil.lewatJadwal[0].ambangJam, 4);
    assert.equal(hasil.dibuat[0].lewatJadwal, true);

    const [[baris]] = await pool.query(
      'SELECT jam_sejak_cek_sebelumnya, lewat_jadwal FROM monitoring WHERE id = ?',
      [hasil.dibuat[0].id],
    );
    assert.equal(Number(baris.jam_sejak_cek_sebelumnya), 5);
    assert.equal(Boolean(baris.lewat_jadwal), true);
  });

  test('pengisian backdated dibandingkan dengan cek yang KRONOLOGISNYA mendahului, bukan yang terakhir di-insert', async () => {
    await isiSilo();
    // Simpan jam 11 dulu (di-insert lebih dulu)...
    await monitoring.simpanRonde(
      { timeCheck: T(11), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    // ...lalu operator baru sadar lupa mencatat jam 6 pagi, mengisinya
    // belakangan (backdated). Ini cek PERTAMA secara kronologis untuk silo
    // ini, jadi TIDAK boleh dibandingkan dengan baris jam 11 yang sudah ada.
    const hasilJam6 = await monitoring.simpanRonde(
      { timeCheck: T(6), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    assert.equal(hasilJam6.dibuat[0].lewatJadwal, false);
    const [[baris]] = await pool.query(
      'SELECT jam_sejak_cek_sebelumnya FROM monitoring WHERE id = ?',
      [hasilJam6.dibuat[0].id],
    );
    assert.equal(baris.jam_sejak_cek_sebelumnya, null);
  });
});

describe('konteksRonde — volume kosong tidak lagi mengunci', () => {
  test('volumeKosongSaatIni true untuk silo kosong, false untuk yang berisi', async () => {
    await isiSilo();
    const konteks = await monitoring.konteksRonde();
    const siloIsi = konteks.find((s) => s.silo_id === SILO);
    assert.equal(siloIsi.volumeKosongSaatIni, false);

    const siloLain = konteks.find((s) => s.silo_id !== SILO);
    assert.equal(siloLain.volumeKosongSaatIni, true);
  });

  test('simpanRonde tetap menerima input untuk silo yang volumenya 0 saat ini', async () => {
    const konteks = await monitoring.konteksRonde();
    const siloKosong = konteks.find((s) => s.silo_id !== SILO);
    assert.equal(siloKosong.volumeKosongSaatIni, true);

    const hasil = await monitoring.simpanRonde(
      { timeCheck: T(6), hasil: [{ siloId: siloKosong.silo_id, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    assert.equal(hasil.dibuat.length, 1);
  });
});

describe('Data List — filter & detail lewat jadwal', () => {
  test('lewatJadwal muncul di daftar & detail, tidak di record yang tidak lewat jadwal', async () => {
    await isiSilo();
    await monitoring.simpanRonde(
      { timeCheck: T(6), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    const hasilLewat = await monitoring.simpanRonde(
      { timeCheck: T(11), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    const id = hasilLewat.dibuat[0].id;

    const daftar = await dataList.daftar('monitoring', { lewatJadwal: true }, AKTOR.operator);
    const baris = daftar.data.find((d) => Number(d.id) === id);
    assert.ok(baris);
    assert.equal(baris.lewatJadwal, true);

    const detail = await dataList.detail('monitoring', id);
    assert.ok(detail.field.some((f) => f.label === 'Jadwal'));
  });

  test('record yang tidak lewat jadwal tidak muncul di filter lewatJadwal', async () => {
    await isiSilo();
    const hasil = await monitoring.simpanRonde(
      { timeCheck: T(6), hasil: [{ siloId: SILO, ph: 6.5, temp: 4.5 }] },
      AKTOR.operator, IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    const daftar = await dataList.daftar('monitoring', { lewatJadwal: true }, AKTOR.operator);
    assert.equal(daftar.data.some((d) => Number(d.id) === id), false);
  });
});
