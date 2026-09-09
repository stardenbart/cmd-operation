/**
 * Pemuatan master operator - Fase 4
 *
 * Berbeda dari list transaksi, operator adalah MASTER: ia harus ada sebelum
 * baris transaksi mana pun dapat diselesaikan, sebab tiap baris menunjuk
 * operatornya lewat nama.
 *
 * DUA KEPUTUSAN YANG DIAMBIL DI SINI, KEDUANYA PANTAS DIBACA:
 *
 *  KREDENSIAL TIDAK PERNAH DIMIGRASIKAN.  Export SharePoint memuat kolom
 *  `pin_code` berisi PIN dalam bentuk terbaca. Kolom itu SENGAJA DIABAIKAN.
 *  Memindahkannya berarti memindahkan kredensial yang sudah pernah terbaca
 *  orang lain ke sistem yang menganggapnya sah.
 *
 *  Sejak migrasi 012, `password_hash` dibiarkan NULL - bukan diisi password
 *  acak. Bedanya penting: password acak yang tidak pernah diberitahukan
 *  kepada pemiliknya adalah akun yang TERLIHAT siap dipakai padahal tidak,
 *  sedangkan NULL menyatakan apa adanya bahwa kredensialnya belum pernah
 *  diterbitkan. Admin menerbitkannya lewat Master Data (FR-26.2.5), dan
 *  saat itulah passwordnya ditampilkan sekali untuk diserahkan.
 *
 *  `username` diisi dari `kode`: kode itu sudah unik, sudah dikenal operator,
 *  dan sudah tercetak di catatan mutu.
 *
 *  PERAN YANG TIDAK DIKENAL TURUN KE OPERATOR.  Sistem lama mengenal peran
 *  "Manager" yang tidak ada padanannya di matriks 2.10.1. Menolak barisnya
 *  akan ikut menolak seluruh transaksi yang menyebut namanya; menaikkannya ke
 *  Admin akan memberi wewenang yang tidak pernah diputuskan siapa pun. Yang
 *  dipilih adalah wewenang TERENDAH, dan namanya dilaporkan supaya Admin
 *  menaikkannya secara sadar.
 */

import { bacaList } from './bacaSumber.js';
import { parseTeks, parseBoolean } from './parseNilai.js';

/** Nama berkas master operator. */
export const BERKAS_OPERATOR = 'Operator_Master';

/** Peran sistem lama ke peran matriks 2.10.1. */
const PETA_PERAN = {
  Operator: 'Operator',
  SPV: 'SPV',
  Admin: 'Admin',
};

/**
 * Memuat operator dari export master.
 *
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {string} dir
 * @param {{catat: Function}} laporan
 */
export async function muatOperator(conn, dir, laporan) {
  const isi = await bacaList(dir, BERKAS_OPERATOR);
  if (!isi) {
    laporan.catat('operator', null, 'berkas sumber tidak ditemukan', {
      rincian: [
        `dicari nama yang memuat "${BERKAS_OPERATOR}". Tanpa master operator, `
        + 'baris transaksi tidak dapat diselesaikan operatornya.',
      ],
    });
    return { dimuat: 0, diturunkan: [] };
  }

  let dimuat = 0;
  const diturunkan = [];

  /*
   * Akun universal "Operator" - 131 baris riwayat menunjuk ke sini.
   *
   * Di sistem lama ada satu akun bersama yang dipakai sebelum tiap operator
   * punya akunnya sendiri, dan `nama_op`-nya tertulis harfiah "Operator".
   * Akun itu tidak ada di master, sehingga seluruh 131 barisnya ditolak - dan
   * penolakan itu menjalar: 47 prepast kehilangan induk penerimaannya, lalu
   * alokasi FIFO-nya ikut yatim.
   *
   * Akunnya dibuat supaya riwayatnya punya tempat berlabuh. Dibuat NONAKTIF,
   * dan itu bukan setengah hati: di sistem baru PIN adalah tanda tangan
   * elektronik milik satu orang (FR-1.1), jadi akun bersama tidak boleh
   * dipakai untuk mencatat apa pun yang BARU. Yang lama tetap terbaca, yang
   * baru tidak dapat memakainya. Admin dapat mengaktifkannya lewat Master
   * Data bila memang diputuskan lain.
   */
  const UNIVERSAL = { kode: '0000', nama: 'Operator' };
  {
    await conn.query(
      `INSERT INTO operator
         (kode, username, nama_lengkap, password_hash, must_change_password, role, is_active)
       VALUES (?, ?, ?, NULL, TRUE, 'Operator', FALSE)
       ON DUPLICATE KEY UPDATE nama_lengkap = VALUES(nama_lengkap)`,
      [UNIVERSAL.kode, UNIVERSAL.kode, UNIVERSAL.nama],
    );
    dimuat += 1;
    laporan.catat('operator', null, 'akun universal dibuat', {
      kode: UNIVERSAL.kode,
      ditolak: false,
      rincian: [
        'Akun bersama "Operator" dari sistem lama dibuat sebagai operator '
        + 'NONAKTIF supaya riwayat yang menyebutnya tetap dapat dimuat. Akun '
        + 'ini tidak dapat dipakai mencatat transaksi baru.',
      ],
    });
  }

  for (const b of isi.data) {
    const kode = parseTeks(b.user_id);
    const nama = parseTeks(b.nama_lengkap);
    const peranSumber = parseTeks(b.role);
    const aktif = parseBoolean(b.is_active) ?? true;

    if (!kode || !nama) {
      laporan.catat('operator', b._barisSumber, 'nilai tidak terbaca', {
        kode,
        rincian: ['user_id dan nama_lengkap wajib diisi'],
      });
      continue;
    }

    const peran = PETA_PERAN[peranSumber] ?? 'Operator';
    if (!PETA_PERAN[peranSumber]) {
      diturunkan.push({ kode, nama, peranSumber });
      laporan.catat('operator', b._barisSumber, 'peran tidak dikenal, diturunkan ke Operator', {
        kode, ditolak: false,
        rincian: [
          `peran "${peranSumber}" tidak ada di matriks 2.10.1; dimuat sebagai `
          + 'Operator. Naikkan lewat Master Data bila memang berwenang lebih.',
        ],
      });
    }

    /*
     * MENJALANKAN ULANG TIDAK PERNAH MENGUBAH WEWENANG.
     *
     * Sebelumnya klausa ini menimpa `role` dan `is_active` dari master
     * SharePoint. Itu benar selama cutover, dan menjadi berbahaya sesudahnya:
     * begitu aplikasi hidup, yang memegang kebenaran soal operator adalah
     * Master Data, bukan SharePoint. Admin yang menaikkan wewenang seseorang
     * lewat aplikasi akan melihat wewenang itu turun sendiri hanya karena
     * migrasi dijalankan lagi - dan penurunan itu tidak menimbulkan galat
     * apa pun.
     *
     * Yang diperbarui hanya nama. Selisih wewenang DILAPORKAN, bukan
     * dipaksakan, supaya manusia yang memutuskan mana yang benar.
     */
    const [ada] = await conn.query(
      'SELECT role, is_active FROM operator WHERE kode = ?', [kode],
    );

    if (ada.length > 0) {
      const beda = [];
      if (ada[0].role !== peran) {
        beda.push(`peran di aplikasi "${ada[0].role}", di master "${peran}"`);
      }
      if (Boolean(ada[0].is_active) !== Boolean(aktif)) {
        beda.push(
          `status di aplikasi "${ada[0].is_active ? 'aktif' : 'nonaktif'}", `
          + `di master "${aktif ? 'aktif' : 'nonaktif'}"`,
        );
      }
      if (beda.length > 0) {
        laporan.catat('operator', b._barisSumber, 'wewenang berbeda, TIDAK diubah', {
          kode, ditolak: false,
          rincian: [
            `${beda.join('; ')}. Yang di aplikasi dipertahankan; ubah lewat `
            + 'Master Data bila master yang benar.',
          ],
        });
      }
    }

    await conn.query(
      `INSERT INTO operator
         (kode, username, nama_lengkap, password_hash, must_change_password, role, is_active)
       VALUES (?, ?, ?, NULL, TRUE, ?, ?)
       ON DUPLICATE KEY UPDATE
         nama_lengkap = VALUES(nama_lengkap)`,
      [kode, kode, nama, peran, aktif],
    );
    dimuat += 1;
  }

  return { dimuat, diturunkan };
}
