/**
 * "Lengkapi Prepast" — Volume record utama boleh diedit ulang.
 *
 * Sebelumnya, sekali Volume tersimpan (mis. saat CREATE), lengkapiDraft()
 * menolak keras siapa pun yang mengubahnya lagi — dan untuk record yang
 * masih Gantung/Pending (belum Approved), "Ajukan koreksi" juga belum
 * tersedia (itu cuma untuk record Approved). Akibatnya: kalau Volume salah
 * ketik pada record yang masih Gantung, TIDAK ADA jalan memperbaikinya.
 *
 * Sekarang Volume boleh diganti lewat pelengkapan selama record masih
 * Gantung/Pending (dijamin pastikanBolehLengkapi()). Silo TETAP terkunci —
 * di luar lingkup ini (anchor standing time & kapasitas tangki lain jauh
 * lebih rawan daripada sekadar angka volume yang keliru).
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;
let transfer;

// SILO1 (id 2) — kapasitas nominal 5.000 L, toleransi 1.000 L (batas keras 6.000 L).
const SILO = 2;
const T = (jam, menit = 0) => new Date(2026, 8, 13, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
  transfer = await import('../src/services/transfer.js');
});

beforeEach(reset);
after(tutup);

async function buatReceiving(qtyKg = 10000) {
  return receiving.buat(
    { supplierId: 1, qtyKg, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
    AKTOR.operator, IP_UJI,
  );
}

async function buatDraftDenganVolume(receivingId, volumeLtr) {
  const hasil = await prepast.buat(
    {
      receivingId,
      pecahan: [{ siloId: SILO, volumeLtr }],
      prepastStart: T(7),
    },
    AKTOR.operator, IP_UJI,
  );
  return hasil.dibuat[0].id;
}

describe('lengkapiDraft — Volume record utama boleh diganti', () => {
  test('menaikkan volume mengurangi sisa induk sesuai delta, bukan angka penuh', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftDenganVolume(rcv.id, 2000);

    const hasil = await prepast.lengkapiDraft(id, { volumeLtr: 3000 }, AKTOR.operator, IP_UJI);
    assert.equal(Number(hasil.volumeLtr), 3000);

    const [[record]] = await pool.query(
      'SELECT vol_prepast_ltr, qty_remaining_ltr FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Number(record.vol_prepast_ltr), 3000);
    assert.equal(Number(record.qty_remaining_ltr), 3000);

    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    // 10000 - 3000 (bukan 10000 - 2000 - 3000 = salah, itu menghitung dua kali)
    assert.equal(Number(induk.qty_remaining_ltr), 7000);
  });

  test('menurunkan volume mengembalikan selisihnya ke sisa induk', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftDenganVolume(rcv.id, 3000);

    await prepast.lengkapiDraft(id, { volumeLtr: 1000 }, AKTOR.operator, IP_UJI);

    const [[record]] = await pool.query(
      'SELECT vol_prepast_ltr, qty_remaining_ltr FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Number(record.vol_prepast_ltr), 1000);
    assert.equal(Number(record.qty_remaining_ltr), 1000);

    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    assert.equal(Number(induk.qty_remaining_ltr), 9000);

    const [[silo]] = await pool.query(
      'SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?', [SILO],
    );
    assert.equal(Number(silo.vol_aktual_ltr), 1000);
  });

  test('mengubah volume ke angka yang sama persis tidak mengubah apa pun (bukan volumeBerubah)', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftDenganVolume(rcv.id, 2000);

    await prepast.lengkapiDraft(id, { volumeLtr: 2000 }, AKTOR.operator, IP_UJI);

    const [[induk]] = await pool.query(
      'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [rcv.id],
    );
    assert.equal(Number(induk.qty_remaining_ltr), 8000);
  });

  test('silo tujuan TETAP tidak dapat diganti lewat pelengkapan — di luar lingkup ini', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftDenganVolume(rcv.id, 2000);

    await assert.rejects(
      () => prepast.lengkapiDraft(id, { siloId: 3 }, AKTOR.operator, IP_UJI),
      (err) => err.code === 'SILO_ALREADY_SET',
    );
  });

  test('tidak dapat diturunkan di bawah volume yang sudah ditransfer keluar', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftDenganVolume(rcv.id, 3000);

    // Tarik 1000 L keluar dari SILO1 lewat Pindah Silo — FIFO tidak menunggu
    // Approved, jadi ini sah dilakukan sekalipun record Prepast-nya sendiri
    // masih Pending.
    await transfer.buat(
      {
        siloAsalId: SILO, jenis: 'PINDAH SILO', volumeLtr: 1000, siloTujuanId: 3, trfTime: T(12),
      },
      AKTOR.operator, IP_UJI,
    );

    const [[sebelum]] = await pool.query(
      'SELECT qty_remaining_ltr FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Number(sebelum.qty_remaining_ltr), 2000, 'sisa di record ini tinggal 2000 setelah ditarik 1000');

    // Turun ke 900 L berarti mengklaim sisa MINUS — 1000 L yang sudah
    // ditransfer keluar tidak boleh diakui masih ada.
    await assert.rejects(
      () => prepast.lengkapiDraft(id, { volumeLtr: 900 }, AKTOR.operator, IP_UJI),
      (err) => err.code === 'PREPAST_VOLUME_SUDAH_DITRANSFER' && err.details?.konsumsiLtr === 1000,
    );

    // Tepat di angka yang sudah ditransfer masih diterima (sisa jadi 0, bukan negatif).
    const hasil = await prepast.lengkapiDraft(id, { volumeLtr: 1000 }, AKTOR.operator, IP_UJI);
    assert.equal(Number(hasil.volumeLtr), 1000);
    const [[setelah]] = await pool.query(
      'SELECT vol_prepast_ltr, qty_remaining_ltr FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Number(setelah.vol_prepast_ltr), 1000);
    assert.equal(Number(setelah.qty_remaining_ltr), 0);
  });

  test('menaikkan volume melewati batas keras silo tetap tersimpan, ditandai — BR-24 soft cap berlaku juga di sini', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftDenganVolume(rcv.id, 2000);

    const hasil = await prepast.lengkapiDraft(id, { volumeLtr: 6001 }, AKTOR.operator, IP_UJI);
    assert.equal(hasil.melampauiKapasitas, true);

    const [[record]] = await pool.query(
      'SELECT melampaui_kapasitas FROM prepast_record WHERE id = ?', [id],
    );
    assert.equal(Boolean(record.melampaui_kapasitas), true);
  });
});
