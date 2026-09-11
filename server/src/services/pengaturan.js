/**
 * Pengaturan aplikasi — preferensi global, berlaku sama untuk semua orang.
 *
 * Beda dari master data (daftar entri: supplier, silo, dst.) — ini SATU baris
 * tetap (id selalu 1) untuk hal-hal yang bukan atribut satu entitas, cuma
 * preferensi tampilan aplikasi secara keseluruhan. Pengaturan baru cukup
 * menambah kolom di tabel yang sama, bukan bikin tabel baru tiap kali.
 */

import { pool, withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { pastikanBerwenang, AKSI } from '../auth/permissions.js';

/** Kolom yang boleh diubah lewat perbarui(), beserta cara memaksanya jadi boolean. */
const KOLOM = ['tampilkan_sisa_silo'];

async function ambilBaris(conn) {
  const [baris] = await conn.query('SELECT * FROM pengaturan_aplikasi WHERE id = 1');
  return baris[0];
}

/** Dibaca siapa pun yang sudah login — murni preferensi tampilan, bukan rahasia. */
export async function ambil() {
  const baris = await ambilBaris(pool);
  return {
    tampilkanSisaSilo: Boolean(baris.tampilkan_sisa_silo),
    diperbaruiPada: baris.updated_at,
  };
}

/**
 * Mengubah pengaturan global — khusus Admin (BR-27-nya master data: wilayah
 * yang sama dengan Master Data lain, lihat permissions.js).
 */
export async function perbarui(perubahan, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.MASTER_KELOLA);

  const kolom = Object.keys(perubahan).filter((k) => KOLOM.includes(k));
  if (kolom.length === 0) return ambil();

  return withTransaction(async (conn) => {
    const lama = await ambilBaris(conn);

    await conn.query(
      `UPDATE pengaturan_aplikasi
          SET ${kolom.map((k) => `\`${k}\` = ?`).join(', ')}, updated_by_id = ?
        WHERE id = 1`,
      [...kolom.map((k) => Boolean(perubahan[k])), aktor.id],
    );

    const baru = await ambilBaris(conn);
    await catatAudit(conn, {
      entity: 'pengaturan_aplikasi', entityId: 1, action: 'UPDATE',
      actorId: aktor.id, before: lama, after: baru, ip,
    });

    return {
      tampilkanSisaSilo: Boolean(baru.tampilkan_sisa_silo),
      diperbaruiPada: baru.updated_at,
    };
  });
}
