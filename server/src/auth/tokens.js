/**
 * Lapis token — FR-1.2
 *
 * Access token berumur pendek (15 menit) membawa identitas & peran.
 * Refresh token berumur panjang disimpan sebagai HASH di basis data —
 * nilai mentahnya tidak pernah tersimpan, sehingga kebocoran tabel tidak
 * langsung berarti pembajakan sesi.
 */

import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Membuat access token.
 *
 * Hanya memuat field yang memang dibutuhkan untuk otorisasi. Objek operator
 * TIDAK disebar apa adanya — payload JWT hanya ter-encode base64, bukan
 * terenkripsi, sehingga siapa pun yang memegang token dapat membacanya.
 *
 * Hak akses custom (FR-34.2.4) disertakan sebagai klaim `cp` HANYA bila tidak
 * kosong, supaya token user biasa tidak membengkak dan tidak perlu query DB
 * pada tiap request.
 *
 * @param {{id:number, kode:string, nama_lengkap?:string, nama?:string, role:string, custom_permissions?:string[]}} operator
 * @param {{kedaluwarsa?: string, shift?: number}} opsi
 */
export function buatAccessToken(operator, { kedaluwarsa, shift } = {}) {
  const muatan = {
    sub: operator.id,
    kode: operator.kode,
    nama: operator.nama_lengkap ?? operator.nama,
    role: operator.role,
  };
  const cp = operator.custom_permissions ?? operator.customPermissions;
  if (Array.isArray(cp) && cp.length > 0) muatan.cp = cp;
  // Shift ASAL SESI (bukan dihitung ulang tiap token) — dibandingkan dengan
  // shift saat ini di wajibLogin(), lihat auth/shift.js.
  if (shift != null) muatan.shift = shift;
  return jwt.sign(
    muatan,
    config.auth.jwtSecret,
    {
      // Algoritma disebut EKSPLISIT, bukan dibiarkan default. Meski defaultnya
      // sudah HS256, menyebutnya di sini membuat pasangannya di verifikasi -
      // yang menyematkan algorithms - tidak bergantung pada default yang bisa
      // berubah antar versi pustaka.
      algorithm: 'HS256',
      expiresIn: kedaluwarsa ?? config.auth.accessTtl,
    },
  );
}

/**
 * Memverifikasi access token.
 *
 * @throws {jwt.JsonWebTokenError} bila tanda tangan salah, isi diubah,
 *   token kedaluwarsa, atau bentuknya bukan JWT
 */
export function verifikasiAccessToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new jwt.JsonWebTokenError('Token tidak diberikan');
  }
  /*
   * `algorithms` DISEMATKAN. Tanpanya, jwt.verify mempercayai kolom "alg" di
   * header token - yang dikendalikan penyusun token, bukan server. Pada kunci
   * HMAC ini tidak serawan kebingungan RS256-vs-HS256, tetapi verifikasi yang
   * menerima algoritma apa pun yang disebut tokennya tetap kelemahan yang
   * tidak perlu ada. Server yang menyematkan HS256 hanya menerima token yang
   * ditandatangani dengan cara yang sama seperti ia menerbitkannya.
   */
  return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] });
}

/** Refresh token: 32 byte acak, base64url. */
export function buatRefreshToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash refresh token untuk disimpan di basis data.
 *
 * SHA-256 cukup di sini — berbeda dari PIN, refresh token sudah memiliki
 * entropi penuh 256 bit, sehingga tidak rentan terhadap serangan kamus dan
 * tidak memerlukan hash lambat seperti argon2.
 */
export function hashRefreshToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
