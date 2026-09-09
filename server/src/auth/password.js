/**
 * Password sementara - FR-26.2.5
 *
 * Dipakai tiga tempat yang semuanya menerbitkan kredensial untuk orang lain:
 * seed (akun Admin pertama), migrasi (operator dari master lama), dan reset
 * oleh Admin. Satu tempat, supaya aturannya tidak pernah berbeda-beda.
 *
 * DUA HAL YANG MENENTUKAN BENTUK ABJADNYA:
 *
 *  Password ini DIBACAKAN atau DISALIN dari layar, sering di lantai produksi.
 *  Karena itu huruf dan angka yang mudah tertukar dibuang seluruhnya: O dan 0,
 *  I dan l dan 1. Password yang benar tetapi salah dibaca menghasilkan
 *  panggilan ke Admin, dan panggilan itu berakhir dengan reset lagi.
 *
 *  Password ini SEMENTARA dan wajib diganti saat login pertama, jadi yang
 *  dibutuhkan cukup tidak dapat ditebak - bukan mudah diingat. Panjangnya
 *  dibuat 10 dengan pemisah di tengah supaya mudah dibacakan per kelompok.
 */

import { randomInt } from 'node:crypto';

/** Tanpa O, 0, I, l, 1 - lihat catatan di atas. */
const ABJAD = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/**
 * @param {number} [panjang] jumlah karakter acak, di luar tanda pemisah
 * @returns {string} mis. "Kx7m-Qp92R"
 */
export function bangkitkanPasswordSementara(panjang = 10) {
  // randomInt, bukan Math.random: yang dibangkitkan di sini adalah kredensial.
  const acak = Array.from(
    { length: panjang },
    () => ABJAD[randomInt(0, ABJAD.length)],
  ).join('');

  // Pemisah di tengah hanya untuk dibacakan. Ia bagian dari passwordnya.
  const tengah = Math.floor(panjang / 2);
  return `${acak.slice(0, tengah)}-${acak.slice(tengah)}`;
}
