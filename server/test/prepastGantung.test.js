import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepastPerluDilengkapi,
  statusKelengkapanPrepast,
} from '../src/services/prepastGantung.js';

describe('prepastPerluDilengkapi', () => {
  const lengkap = {
    prepastFinish: new Date('2026-09-04T08:00:00Z'),
    flowrate: 5.2, tempAfterHeater: 87, tempOutput: 7,
  };

  test('semua terisi -> tidak perlu dilengkapi', () => {
    assert.equal(prepastPerluDilengkapi(lengkap), false);
  });

  test('waktu selesai kosong -> perlu dilengkapi (perilaku lama tetap)', () => {
    assert.equal(prepastPerluDilengkapi({ ...lengkap, prepastFinish: null }), true);
  });

  test('flowrate kosong (null/undefined/"") -> perlu dilengkapi', () => {
    assert.equal(prepastPerluDilengkapi({ ...lengkap, flowrate: null }), true);
    assert.equal(prepastPerluDilengkapi({ ...lengkap, flowrate: undefined }), true);
    assert.equal(prepastPerluDilengkapi({ ...lengkap, flowrate: '' }), true);
  });

  test('temp after heater kosong -> perlu dilengkapi', () => {
    assert.equal(prepastPerluDilengkapi({ ...lengkap, tempAfterHeater: null }), true);
  });

  test('temp output kosong -> perlu dilengkapi', () => {
    assert.equal(prepastPerluDilengkapi({ ...lengkap, tempOutput: null }), true);
  });

  test('volume kosong -> perlu dilengkapi bila field volume disertakan', () => {
    assert.equal(prepastPerluDilengkapi({ ...lengkap, volumeLtr: null }), true);
    assert.equal(prepastPerluDilengkapi({ ...lengkap, volumeLtr: 1000 }), false);
  });

  test('nol adalah nilai ukur yang sah, bukan kosong', () => {
    assert.equal(
      prepastPerluDilengkapi({ ...lengkap, flowrate: 0, tempAfterHeater: 0, tempOutput: 0 }),
      false,
    );
  });

  test('mengembalikan key dan label field yang masih kosong', () => {
    assert.deepEqual(
      statusKelengkapanPrepast({ ...lengkap, flowrate: null, tempOutput: undefined }),
      {
        isGantung: true,
        fieldKosong: [
          { key: 'flowrate', label: 'Flowrate' },
          { key: 'tempOutput', label: 'Temp Output' },
        ],
      },
    );
  });
});
