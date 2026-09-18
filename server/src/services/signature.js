/**
 * Tanda tangan digital operator - kolom Paraf Halaman 1 form GMP.
 *
 * Menggantikan QR (migrasi 034): gambar disimpan SEKALI per operator,
 * dipakai ulang untuk setiap record yang mereka kerjakan. Layanan ini
 * SENGAJA hanya mengizinkan operator mengatur tanda tangannya SENDIRI
 * (bukan Admin mengatur milik orang lain) - sama seperti Ganti Password:
 * tanda tangan itu identitas pribadi, bukan sesuatu yang wajar diwakilkan.
 */

import { pool } from '../db/pool.js';
import { BusinessError } from '../middleware/errors.js';

/** Tanda PNG - 8 bita pertama berkas PNG sah, selalu sama persis. */
const TANDA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Batas ukuran wajar untuk gambar tanda tangan - jauh di atas kebutuhan
 * sesungguhnya (biasanya beberapa KB), sekadar pagar dari unggahan asal. */
const MAKS_BITA = 2 * 1024 * 1024;

/**
 * Menyimpan tanda tangan operator. Menimpa yang lama bila sudah ada -
 * tanda tangan boleh diganti (mis. digambar ulang lebih rapi), tidak
 * seperti jejak audit yang harus permanen.
 */
export async function simpanTandaTangan(operatorId, png) {
  if (!Buffer.isBuffer(png) || png.length === 0) {
    throw new BusinessError('SIGNATURE_REQUIRED', 'Tanda tangan tidak boleh kosong.');
  }
  if (!png.subarray(0, 8).equals(TANDA_PNG)) {
    throw new BusinessError('SIGNATURE_INVALID', 'Berkas yang dikirim bukan gambar PNG yang sah.');
  }
  if (png.length > MAKS_BITA) {
    throw new BusinessError('SIGNATURE_INVALID', 'Ukuran gambar tanda tangan terlalu besar.');
  }
  await pool.query(
    'UPDATE operator SET signature_image = ?, signature_updated_at = UTC_TIMESTAMP() WHERE id = ?',
    [png, operatorId],
  );
}

export async function hapusTandaTangan(operatorId) {
  await pool.query(
    'UPDATE operator SET signature_image = NULL, signature_updated_at = NULL WHERE id = ?',
    [operatorId],
  );
}

/** @returns {Promise<Buffer|null>} */
export async function ambilTandaTangan(operatorId) {
  const [[baris]] = await pool.query(
    'SELECT signature_image FROM operator WHERE id = ?',
    [operatorId],
  );
  return baris?.signature_image ?? null;
}

export async function punyaTandaTangan(operatorId) {
  const [[baris]] = await pool.query(
    'SELECT signature_image IS NOT NULL AS ada FROM operator WHERE id = ?',
    [operatorId],
  );
  return Boolean(baris?.ada);
}

/**
 * Ditegakkan sebelum Receiving baru tersimpan (BR khusus fitur ini) - itu
 * yang menentukan isi kolom "Dikerjakan Oleh"/Paraf Halaman 1, bukan
 * Prepast/Transfer/Monitoring. Dipanggil di AWAL, sebelum tulisan apa pun,
 * supaya operator tanpa tanda tangan tidak pernah menghasilkan record
 * yang Paraf-nya bakal kosong di form.
 */
export async function pastikanPunyaTandaTangan(operatorId) {
  if (!(await punyaTandaTangan(operatorId))) {
    throw new BusinessError(
      'SIGNATURE_REQUIRED',
      'Anda belum membuat tanda tangan digital. Buat dulu lewat tombol "Tanda Tangan Saya" di kanan atas sebelum menyimpan Receiving.',
    );
  }
}
