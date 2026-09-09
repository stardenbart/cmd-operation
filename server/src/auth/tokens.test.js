/**
 * Uji lapis token — FR-1.2
 *
 * Menguji perilaku pembungkus, bukan pustaka JWT-nya. Yang penting:
 * token palsu, kedaluwarsa, dan yang ditandatangani rahasia lain harus
 * DITOLAK — bukan diterima diam-diam.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  buatAccessToken,
  verifikasiAccessToken,
  buatRefreshToken,
  hashRefreshToken,
} from './tokens.js';
import { config } from '../config.js';

/** Rahasia yang sama dengan yang dipakai server menandatangani. */
const RAHASIA_UJI = config.auth.jwtSecret;

const OPERATOR = { id: 7, kode: 'OP001', nama: 'Ade Yudistira', role: 'Operator' };

describe('access token', () => {
  test('membawa identitas dan peran operator', () => {
    const token = buatAccessToken(OPERATOR);
    const klaim = verifikasiAccessToken(token);

    assert.equal(klaim.sub, 7);
    assert.equal(klaim.kode, 'OP001');
    assert.equal(klaim.role, 'Operator');
  });

  test('tidak pernah membawa hash PIN', () => {
    const token = buatAccessToken({ ...OPERATOR, pin_hash: '$argon2id$rahasia' });
    const klaim = verifikasiAccessToken(token);

    assert.equal(klaim.pin_hash, undefined);
    assert.ok(
      !JSON.stringify(klaim).includes('argon2'),
      'hash PIN tidak boleh ikut ke dalam token',
    );
  });

  test('menolak token yang isinya diubah', () => {
    const token = buatAccessToken(OPERATOR);
    const [kepala, isi, tanda] = token.split('.');
    const isiPalsu = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(isi, 'base64url')), role: 'SPV' }),
    ).toString('base64url');

    assert.throws(() => verifikasiAccessToken(`${kepala}.${isiPalsu}.${tanda}`));
  });

  test('menolak token yang ditandatangani rahasia lain', () => {
    const palsu = jwt.sign({ sub: 7, role: 'Admin' }, 'rahasia-lain');

    assert.throws(() => verifikasiAccessToken(palsu));
  });

  test('menolak token kedaluwarsa', () => {
    const token = buatAccessToken(OPERATOR, { kedaluwarsa: '-1s' });

    assert.throws(() => verifikasiAccessToken(token), /expired|kedaluwarsa/i);
  });

  test('menolak string yang bukan token', () => {
    assert.throws(() => verifikasiAccessToken('bukan-token'));
    assert.throws(() => verifikasiAccessToken(''));
    assert.throws(() => verifikasiAccessToken(undefined));
  });

  /**
   * Token beralgoritma "none" - tanpa tanda tangan sama sekali - harus
   * DITOLAK. Ini serangan klasik: penyerang menyusun token berisi peran Admin,
   * menyetel alg=none, dan berharap verifikasi mempercayai kolom alg milik
   * tokennya sendiri. Verifikasi yang menyematkan algorithms tidak akan
   * pernah tertipu.
   */
  test('menolak token beralgoritma "none"', () => {
    const kepala = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const isi = Buffer.from(JSON.stringify({ sub: 1, role: 'Admin' })).toString('base64url');
    const tokenNone = `${kepala}.${isi}.`;
    assert.throws(() => verifikasiAccessToken(tokenNone));
  });

  /**
   * Token yang tanda tangannya sah tetapi memakai algoritma LAIN dari yang
   * diterbitkan server juga ditolak. jwt.sign HS256 dan verify yang hanya
   * menerima HS256 tidak boleh menerima, misalnya, HS512 - meski keduanya
   * HMAC dengan rahasia yang sama.
   */
  test('menolak token beralgoritma lain meski rahasianya benar', () => {
    const tokenHS512 = jwt.sign({ sub: 1, role: 'Admin' }, RAHASIA_UJI, { algorithm: 'HS512' });
    assert.throws(() => verifikasiAccessToken(tokenHS512));
  });
});

describe('refresh token', () => {
  test('menghasilkan nilai acak yang berbeda setiap kali', () => {
    const a = buatRefreshToken();
    const b = buatRefreshToken();

    assert.notEqual(a, b);
    assert.ok(a.length >= 43, 'entropi refresh token terlalu kecil');
  });

  test('hash bersifat deterministik untuk masukan yang sama', () => {
    const token = buatRefreshToken();

    assert.equal(hashRefreshToken(token), hashRefreshToken(token));
  });

  test('hash berbeda untuk token berbeda', () => {
    assert.notEqual(hashRefreshToken(buatRefreshToken()), hashRefreshToken(buatRefreshToken()));
  });

  test('hash tidak mengandung token aslinya', () => {
    // Basis data hanya menyimpan hash — token mentah tidak pernah tersimpan,
    // sehingga kebocoran tabel tidak langsung berarti pembajakan sesi.
    const token = buatRefreshToken();

    assert.ok(!hashRefreshToken(token).includes(token));
  });
});
