/**
 * Uji pembatas laju - keamanan
 *
 * Yang diuji bukan "apakah ia menghitung", melainkan hal-hal yang kalau salah
 * membuat pembatas ini terlihat bekerja padahal tidak: jendela yang tidak
 * pernah bergeser, IP berbeda yang saling menghukum, dan permintaan sah yang
 * ikut terkena.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pembatasLaju } from '../src/middleware/rateLimit.js';

/** Menjalankan middleware secara sinkron dan mengembalikan status akhirnya. */
function jalankan(mw, ip) {
  let status = 200;
  let terpanggilNext = false;
  const req = { ip };
  const res = { set() {} };
  mw(req, res, (err) => {
    terpanggilNext = true;
    if (err) status = err.status;
  });
  return { status, terpanggilNext };
}

describe('pembatasLaju', () => {
  test('menolak setelah ambang terlampaui, dari IP yang sama', () => {
    const mw = pembatasLaju({ jendelaMs: 60_000, maks: 3 });
    const ip = '10.0.0.5';

    assert.equal(jalankan(mw, ip).status, 200);
    assert.equal(jalankan(mw, ip).status, 200);
    assert.equal(jalankan(mw, ip).status, 200);
    // Permintaan keempat melewati ambang.
    assert.equal(jalankan(mw, ip).status, 429);
  });

  test('selalu memanggil next - tidak pernah menggantung permintaan', () => {
    const mw = pembatasLaju({ jendelaMs: 60_000, maks: 1 });
    assert.equal(jalankan(mw, '10.0.0.6').terpanggilNext, true);
    assert.equal(jalankan(mw, '10.0.0.6').terpanggilNext, true, 'yang ditolak pun lewat next(err)');
  });

  test('IP berbeda dihitung TERPISAH', () => {
    const mw = pembatasLaju({ jendelaMs: 60_000, maks: 2 });
    // IP A menghabiskan jatahnya.
    jalankan(mw, 'A'); jalankan(mw, 'A');
    assert.equal(jalankan(mw, 'A').status, 429);
    // IP B tidak boleh ikut terhukum oleh perbuatan A.
    assert.equal(jalankan(mw, 'B').status, 200);
  });

  test('opsi lewati mengeluarkan permintaan dari hitungan', () => {
    const mw = pembatasLaju({
      jendelaMs: 60_000,
      maks: 1,
      lewati: (req) => req.istimewa === true,
    });
    const ip = '10.0.0.7';
    // Yang dilewati tidak menambah hitungan, berapa kali pun.
    for (let i = 0; i < 5; i += 1) {
      let status = 200;
      mw({ ip, istimewa: true }, { set() {} }, (err) => { if (err) status = err.status; });
      assert.equal(status, 200);
    }
    // Dan jatah normalnya masih utuh.
    assert.equal(jalankan(mw, ip).status, 200);
    assert.equal(jalankan(mw, ip).status, 429);
  });

  test('kunci "__proto__" sebagai IP tidak mengacau struktur', () => {
    // Map, bukan objek biasa - kunci ini tidak boleh menyentuh prototipe.
    const mw = pembatasLaju({ jendelaMs: 60_000, maks: 1 });
    assert.equal(jalankan(mw, '__proto__').status, 200);
    assert.equal(jalankan(mw, '__proto__').status, 429);
    // IP normal tetap bekerja sesudahnya.
    assert.equal(jalankan(mw, '10.0.0.8').status, 200);
  });

  test('menyetel Retry-After saat menolak', () => {
    const mw = pembatasLaju({ jendelaMs: 30_000, maks: 1 });
    const dipasang = {};
    const req = { ip: '10.0.0.9' };
    const res = { set(k, v) { dipasang[k] = v; } };
    mw(req, res, () => {});
    mw(req, res, () => {});
    assert.equal(dipasang['Retry-After'], '30');
  });
});
