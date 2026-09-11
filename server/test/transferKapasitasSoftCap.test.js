/**
 * Transfer Pindah Silo — kapasitas nominal tidak lagi memblokir (BR-24).
 *
 * Keputusan operasional (dikonfirmasi pengguna, September 2026): operator
 * produksi sempat terhambat mencatat susu yang secara fisik sudah ada di
 * silo karena sistem menolak keras begitu kapasitas+toleransi terlampaui.
 * Untuk Pindah Silo, kapasitas nominal sekarang murni peringatan.
 *
 * Prepast (pecahanSilo.js) awalnya SENGAJA tidak ikut berubah pada putaran
 * pertama keputusan ini — lihat riwayat git. Keputusan itu kemudian dibalik:
 * Prepast sekarang ikut melunak dengan cara yang sama persis (lihat
 * prepastKapasitasSoftCap.test.js).
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let transfer;
let dataList;

// SILO1 & SILO2 — kapasitas nominal 5.000 L, toleransi bawaan 1.000 L
// (batas keras 6.000 L). SILO25A — kapasitas 25.000 L, dipakai sebagai
// sumber saat volumenya sendiri perlu melebihi kapasitas SILO1/SILO2
// (mengisi lewat Prepast ke SILO1/SILO2 langsung akan kena batas keras
// Prepast yang TIDAK berubah — lihat pengujian di bawah).
const SILO = { satu: 2, dua: 3, besar: 8 };
const W = (jam, menit = 0) => new Date(2026, 7, 10, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  transfer = await import('../src/services/transfer.js');
  dataList = await import('../src/services/dataList.js');
});

beforeEach(reset);
after(tutup);

async function isiSilo(siloId, volumeLtr) {
  const rcv = await receiving.buat(
    { supplierId: 1, qtyKg: volumeLtr, beratJenis: 1, nilaiTs: 12.4, finishTime: W(6) },
    AKTOR.operator, IP_UJI,
  );
  await prepast.buat(
    {
      receivingId: rcv.id,
      pecahan: [{ siloId, volumeLtr }],
      prepastStart: W(7), prepastFinish: W(8),
      flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
    },
    AKTOR.operator, IP_UJI,
  );
}

async function volumeSilo(siloId) {
  const [b] = await pool.query('SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?', [siloId]);
  return Number(b[0].vol_aktual_ltr);
}

async function pindahSilo(siloAsalId, siloTujuanId, volumeLtr) {
  return transfer.buat(
    {
      trfTime: W(12), siloAsalId, jenis: 'PINDAH SILO', volumeLtr, siloTujuanId,
    },
    AKTOR.operator, IP_UJI,
  );
}

describe('Transfer Pindah Silo — kapasitas nominal jadi soft cap', () => {
  test('volume yang melebihi bahkan batas keras TETAP tersimpan, bukan ditolak', async () => {
    // Sumbernya SILO25A (kapasitas 25.000 L) supaya bisa menampung 6.500 L
    // sekaligus — batas keras yang mau diuji ada di SILO TUJUAN (SILO2),
    // bukan di sumbernya.
    await isiSilo(SILO.besar, 6500);

    // SILO2 kosong, batas keras 6.000 L. Transfer 6.500 L dulu adalah
    // skenario yang DULU ditolak BusinessError FR-29.7.
    const hasil = await pindahSilo(SILO.besar, SILO.dua, 6500);

    assert.ok(hasil.melampauiNominalTujuan);
    assert.equal(hasil.melampauiNominalTujuan.melebihiBatasKeras, true);
    assert.equal(hasil.melampauiNominalTujuan.sisaNominalLtr, 5000);
    assert.equal(hasil.melampauiNominalTujuan.batasKerasLtr, 6000);
    assert.equal(hasil.melampauiNominalTujuan.kelebihanLtr, 1500);

    // Volume sungguh masuk apa adanya — tidak dipotong ke batas keras.
    assert.equal(await volumeSilo(SILO.dua), 6500);
  });

  test('volume dalam nominal tidak memicu peringatan sama sekali', async () => {
    await isiSilo(SILO.satu, 3000);
    const hasil = await pindahSilo(SILO.satu, SILO.dua, 3000);

    assert.equal(hasil.melampauiNominalTujuan, null);
    assert.equal(await volumeSilo(SILO.dua), 3000);
  });

  test('volume lewat nominal tapi masih dalam toleransi: peringatan ada, melebihiBatasKeras false', async () => {
    await isiSilo(SILO.satu, 5500);
    const hasil = await pindahSilo(SILO.satu, SILO.dua, 5500);

    assert.ok(hasil.melampauiNominalTujuan);
    assert.equal(hasil.melampauiNominalTujuan.melebihiBatasKeras, false);
    assert.equal(await volumeSilo(SILO.dua), 5500);
  });

  test('Prepast ikut melunak dengan cara yang sama — lihat prepastKapasitasSoftCap.test.js', async () => {
    const rcv = await receiving.buat(
      { supplierId: 1, qtyKg: 6001, beratJenis: 1, nilaiTs: 12.4, finishTime: W(6) },
      AKTOR.operator, IP_UJI,
    );

    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO.satu, volumeLtr: 6001 }],
        prepastStart: W(7), prepastFinish: W(8),
        flowrate: 5.5, tempAfterHeater: 86, tempOutput: 4,
      },
      AKTOR.operator, IP_UJI,
    );

    assert.equal(hasil.dibuat[0].melampauiKapasitas, true);
    assert.equal(await volumeSilo(SILO.satu), 6001);
  });

  test('melampaui_kapasitas tersimpan dan dapat difilter lewat Data List', async () => {
    await isiSilo(SILO.besar, 6500);
    const hasil = await pindahSilo(SILO.besar, SILO.dua, 6500);

    const [[baris]] = await pool.query(
      'SELECT melampaui_kapasitas FROM transfer WHERE id = ?',
      [hasil.id],
    );
    assert.equal(Boolean(baris.melampaui_kapasitas), true);

    const daftar = await dataList.daftar(
      'transfer', { lewatKapasitas: true }, AKTOR.operator,
    );
    assert.ok(daftar.data.some((d) => Number(d.id) === hasil.id));

    const detail = await dataList.detail('transfer', hasil.id);
    assert.ok(detail.field.some((f) => f.label === 'Kapasitas tujuan'));
  });

  test('transfer normal (tidak melebihi) TIDAK muncul di filter lewatKapasitas', async () => {
    await isiSilo(SILO.satu, 1000);
    const hasil = await pindahSilo(SILO.satu, SILO.dua, 1000);

    const [[baris]] = await pool.query(
      'SELECT melampaui_kapasitas FROM transfer WHERE id = ?',
      [hasil.id],
    );
    assert.equal(Boolean(baris.melampaui_kapasitas), false);

    const daftar = await dataList.daftar(
      'transfer', { lewatKapasitas: true }, AKTOR.operator,
    );
    assert.equal(daftar.data.some((d) => Number(d.id) === hasil.id), false);
  });
});
