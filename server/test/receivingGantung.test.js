import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { statusKelengkapanReceiving, FIELD_KELENGKAPAN_RECEIVING } from '../src/services/receivingGantung.js';

describe('statusKelengkapanReceiving', () => {
  test('berat jenis dan total solid terisi -> tidak gantung', () => {
    assert.deepEqual(
      statusKelengkapanReceiving({ beratJenis: 1.025, nilaiTs: 12.4 }),
      { isGantung: false, fieldKosong: [] },
    );
  });

  test('berat jenis kosong -> gantung, menyebut Berat Jenis', () => {
    assert.deepEqual(
      statusKelengkapanReceiving({ beratJenis: null, nilaiTs: 12.4 }),
      { isGantung: true, fieldKosong: [{ key: 'beratJenis', label: 'Berat Jenis' }] },
    );
  });

  test('total solid kosong -> gantung, menyebut Total Solid', () => {
    assert.deepEqual(
      statusKelengkapanReceiving({ beratJenis: 1.025, nilaiTs: undefined }),
      { isGantung: true, fieldKosong: [{ key: 'nilaiTs', label: 'Total Solid' }] },
    );
  });

  test('keduanya kosong -> gantung, menyebut keduanya', () => {
    assert.deepEqual(
      statusKelengkapanReceiving({ beratJenis: '', nilaiTs: null }),
      {
        isGantung: true,
        fieldKosong: [
          { key: 'beratJenis', label: 'Berat Jenis' },
          { key: 'nilaiTs', label: 'Total Solid' },
        ],
      },
    );
  });

  test('nol adalah nilai ukur yang sah, bukan kosong', () => {
    assert.deepEqual(
      statusKelengkapanReceiving({ beratJenis: 0, nilaiTs: 0 }),
      { isGantung: false, fieldKosong: [] },
    );
  });

  test('field yang diperiksa persis Berat Jenis dan Total Solid', () => {
    assert.deepEqual(
      FIELD_KELENGKAPAN_RECEIVING.map((f) => f.key),
      ['beratJenis', 'nilaiTs'],
    );
  });
});
