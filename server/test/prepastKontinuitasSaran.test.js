/**
 * Kontinuitas Prepast — saran Flowrate/Temp After Heater/Temp Output.
 *
 * Checkbox "Proses Kontinu" di form Prepast baru sebelumnya cuma menyarankan
 * Waktu Mulai dari record sebelumnya. Operator sering mengetik ulang
 * Flowrate/Temp After Heater/Temp Output yang sama persis untuk batch lanjutan
 * — sekarang ikut disarankan lewat checkbox yang sama, sekadar nilai awal
 * yang tetap bebas diubah, BUKAN patokan yang mengikat.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let receiving;
let prepast;

const SILO = 2;
const T = (jam, menit = 0) => new Date(2026, 8, 12, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
});

beforeEach(reset);
after(tutup);

async function buatReceiving(qtyKg = 10000) {
  return receiving.buat(
    { supplierId: 1, qtyKg, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
    AKTOR.operator, IP_UJI,
  );
}

describe('konteksKontinuitas — saran nilai proses', () => {
  test('belum ada record sebelumnya di plant -> sebelumnya null', async () => {
    const hasil = await prepast.konteksKontinuitas();
    assert.equal(hasil.sebelumnya, null);
  });

  test('sebelumnya membawa flowrate/tempAfterHeater/tempOutput record terakhir', async () => {
    const rcv = await buatReceiving();
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 3000 }],
        prepastStart: T(7), prepastFinish: T(8),
        flowrate: 5.2, tempAfterHeater: 87.5, tempOutput: 7,
      },
      AKTOR.operator, IP_UJI,
    );

    const hasil = await prepast.konteksKontinuitas();
    assert.ok(hasil.sebelumnya);
    assert.equal(Number(hasil.sebelumnya.flowrate), 5.2);
    assert.equal(Number(hasil.sebelumnya.tempAfterHeater), 87.5);
    assert.equal(Number(hasil.sebelumnya.tempOutput), 7);
  });

  test('record sebelumnya yang masih gantung (nilai proses kosong) memberi saran kosong pula', async () => {
    const rcv = await buatReceiving();
    // Prepast finish, tapi flowrate/temp belum diisi — tetap "record
    // terakhir" yang sah (finish sudah ada), sarannya memang kosong apa
    // adanya, bukan dipaksa jadi angka.
    await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 3000 }],
        prepastStart: T(7), prepastFinish: T(8),
      },
      AKTOR.operator, IP_UJI,
    );

    const hasil = await prepast.konteksKontinuitas();
    assert.equal(hasil.sebelumnya.flowrate, null);
    assert.equal(hasil.sebelumnya.tempAfterHeater, null);
    assert.equal(hasil.sebelumnya.tempOutput, null);
  });
});
