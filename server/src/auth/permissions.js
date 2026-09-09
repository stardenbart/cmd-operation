/**
 * Matriks wewenang — PRD 2.10.1, BR-22
 *
 * Satu-satunya sumber kebenaran otorisasi. FUNGSI MURNI, tanpa I/O.
 *
 * Di Power Apps wewenang tersebar sebagai variabel global yang dihitung ulang
 * di beberapa layar, dan sempat tidak sinkron: `varIsSpv` bernilai
 * `role = "SPV" || role = "Admin"` saat login, tetapi `role = "SPV"` saja
 * di Data List (B-21). Dengan satu matriks terpusat, kelas bug itu hilang.
 *
 * Otorisasi ditegakkan di endpoint, BUKAN dengan menyembunyikan tombol.
 * Menyembunyikan tombol bukan otorisasi (B-22).
 */

import { ForbiddenError } from '../middleware/errors.js';

export const PERAN = Object.freeze({
  OPERATOR: 'Operator',
  SPV: 'SPV',
  ADMIN: 'Admin',
  // Peran baca-saja (FR-34): melihat Dashboard, Analitik, Data, Panduan.
  // Wewenang di luar itu diberikan lewat hak akses custom, bukan lewat peran.
  VIEWER: 'Viewer',
});

export const AKSI = Object.freeze({
  // Transaksi harian
  TRANSAKSI_BUAT: 'transaksi:buat',
  TRANSAKSI_SUNTING_PENDING: 'transaksi:sunting_pending',
  TRANSAKSI_SUNTING_APPROVED: 'transaksi:sunting_approved',

  // Koreksi (WF-3)
  KOREKSI_AJUKAN: 'koreksi:ajukan',
  KOREKSI_TINJAU: 'koreksi:tinjau',

  // Persetujuan
  APPROVAL_PUTUSKAN: 'approval:putuskan',
  APPROVAL_MASSAL: 'approval:massal',

  // Pembatalan
  RECORD_VOID: 'record:void',
  /*
   * Void atas record SENDIRI yang BELUM disetujui - dua batasan sekaligus.
   *
   * Operator perlu dapat membatalkan salah inputnya sendiri supaya volumenya
   * kembali dan datanya dapat diperbaiki, tanpa menunggu SPV. Yang tidak boleh
   * adalah membatalkan record yang sudah DISETUJUI - itu menghapus keputusan
   * mutu yang diambil orang lain - maupun record milik orang lain.
   *
   * Dijadikan aksi TERSENDIRI, bukan pelonggaran RECORD_VOID. Aksi yang sama
   * dengan arti berbeda tergantung siapa pemanggilnya adalah cara tercepat
   * membuat matriks 2.10.1 berhenti dapat dibaca.
   */
  RECORD_VOID_SENDIRI: 'record:void_sendiri',

  // Administratif
  STOCK_OPNAME_KELOLA: 'stock_opname:kelola',
  EXPORT_JALANKAN: 'export:jalankan',
  MASTER_KELOLA: 'master:kelola',

  // Baca
  DASHBOARD_LIHAT: 'dashboard:lihat',
});

/**
 * Matriks 2.10.1, ditulis eksplisit.
 *
 * Setiap sel diisi `true` atau `false` — tidak ada yang dibiarkan kosong.
 * Sel kosong akan bernilai undefined, yang memang berarti terlarang, tetapi
 * tanpa jejak bahwa keputusannya pernah diambil. Uji menyeluruh memaksa
 * setiap sel terisi.
 *
 * Perhatikan bahwa Admin BUKAN superset SPV. Keduanya adalah peran penyelia
 * dengan wilayah kerja berbeda: SPV memutuskan mutu, Admin mengurus
 * administrasi. Pemisahan ini menghasilkan pemisahan tugas berlapis tiga —
 * yang menginput bukan yang menyetujui, yang menyetujui bukan yang menetapkan
 * stok awal, dan yang mengelola master data tidak menyentuh transaksi.
 */
const MATRIKS = Object.freeze({
  [PERAN.OPERATOR]: Object.freeze({
    [AKSI.TRANSAKSI_BUAT]: true,
    [AKSI.TRANSAKSI_SUNTING_PENDING]: true,
    [AKSI.TRANSAKSI_SUNTING_APPROVED]: false,
    [AKSI.KOREKSI_AJUKAN]: true,
    [AKSI.KOREKSI_TINJAU]: false,
    [AKSI.APPROVAL_PUTUSKAN]: false,
    [AKSI.APPROVAL_MASSAL]: false,
    [AKSI.RECORD_VOID]: false,
    // Boleh membatalkan input SENDIRI yang belum disetujui - lihat catatan
    // pada definisi aksinya.
    [AKSI.RECORD_VOID_SENDIRI]: true,
    [AKSI.STOCK_OPNAME_KELOLA]: false,
    [AKSI.EXPORT_JALANKAN]: false,
    [AKSI.MASTER_KELOLA]: false,
    [AKSI.DASHBOARD_LIHAT]: true,
  }),

  [PERAN.SPV]: Object.freeze({
    [AKSI.TRANSAKSI_BUAT]: true,
    [AKSI.TRANSAKSI_SUNTING_PENDING]: true,
    [AKSI.TRANSAKSI_SUNTING_APPROVED]: true,
    // SPV memutuskan permintaan koreksi, bukan mengajukannya
    [AKSI.KOREKSI_AJUKAN]: false,
    [AKSI.KOREKSI_TINJAU]: true,
    [AKSI.APPROVAL_PUTUSKAN]: true,
    [AKSI.APPROVAL_MASSAL]: true,
    [AKSI.RECORD_VOID]: true,
    [AKSI.RECORD_VOID_SENDIRI]: true,
    // Stock opname & master data adalah wilayah Admin
    [AKSI.STOCK_OPNAME_KELOLA]: false,
    [AKSI.EXPORT_JALANKAN]: true,
    [AKSI.MASTER_KELOLA]: false,
    [AKSI.DASHBOARD_LIHAT]: true,
  }),

  [PERAN.ADMIN]: Object.freeze({
    // Admin tidak melakukan input transaksi harian (D-14).
    // Satu-satunya inputnya adalah volume awal bulan pada stock opname.
    [AKSI.TRANSAKSI_BUAT]: false,
    [AKSI.TRANSAKSI_SUNTING_PENDING]: false,
    [AKSI.TRANSAKSI_SUNTING_APPROVED]: false,
    [AKSI.KOREKSI_AJUKAN]: false,
    // Approval & void adalah keputusan mutu — tidak diwarisi Admin (BR-22)
    [AKSI.KOREKSI_TINJAU]: false,
    [AKSI.APPROVAL_PUTUSKAN]: false,
    [AKSI.APPROVAL_MASSAL]: false,
    [AKSI.RECORD_VOID]: false,
    [AKSI.RECORD_VOID_SENDIRI]: false,
    [AKSI.STOCK_OPNAME_KELOLA]: true,
    [AKSI.EXPORT_JALANKAN]: true,
    [AKSI.MASTER_KELOLA]: true,
    [AKSI.DASHBOARD_LIHAT]: true,
  }),

  /*
   * Viewer (FR-34, BR-26) - hanya melihat. Satu-satunya wewenang bawaan adalah
   * dashboard:lihat, yang lewat filter MENU membuka Dashboard, Analitik, Data
   * (baca-saja), dan Panduan. Segala tindakan lain harus diberikan eksplisit
   * lewat hak akses custom per user - tidak pernah lewat peran ini.
   */
  [PERAN.VIEWER]: Object.freeze({
    [AKSI.TRANSAKSI_BUAT]: false,
    [AKSI.TRANSAKSI_SUNTING_PENDING]: false,
    [AKSI.TRANSAKSI_SUNTING_APPROVED]: false,
    [AKSI.KOREKSI_AJUKAN]: false,
    [AKSI.KOREKSI_TINJAU]: false,
    [AKSI.APPROVAL_PUTUSKAN]: false,
    [AKSI.APPROVAL_MASSAL]: false,
    [AKSI.RECORD_VOID]: false,
    [AKSI.RECORD_VOID_SENDIRI]: false,
    [AKSI.STOCK_OPNAME_KELOLA]: false,
    [AKSI.EXPORT_JALANKAN]: false,
    [AKSI.MASTER_KELOLA]: false,
    [AKSI.DASHBOARD_LIHAT]: true,
  }),
});

/** Kumpulan seluruh nilai AKSI yang sah, untuk menyaring custom permissions. */
const AKSI_SAH = new Set(Object.values(AKSI));

/**
 * Katalog aksi untuk UI hak akses custom (FR-34.3.2) - label manusiawi dan
 * kategori. `dashboard:lihat` sengaja tidak masuk: semua peran memilikinya,
 * jadi ia tak pernah menjadi hak akses tambahan.
 */
export const KATALOG_AKSI = Object.freeze([
  { aksi: AKSI.TRANSAKSI_BUAT, label: 'Buat transaksi', kategori: 'Transaksi' },
  { aksi: AKSI.TRANSAKSI_SUNTING_PENDING, label: 'Sunting transaksi pending', kategori: 'Transaksi' },
  { aksi: AKSI.TRANSAKSI_SUNTING_APPROVED, label: 'Sunting transaksi approved', kategori: 'Transaksi' },
  { aksi: AKSI.KOREKSI_AJUKAN, label: 'Ajukan koreksi', kategori: 'Transaksi' },
  { aksi: AKSI.APPROVAL_PUTUSKAN, label: 'Putuskan approval', kategori: 'Persetujuan' },
  { aksi: AKSI.APPROVAL_MASSAL, label: 'Approval massal', kategori: 'Persetujuan' },
  { aksi: AKSI.KOREKSI_TINJAU, label: 'Tinjau permintaan koreksi', kategori: 'Persetujuan' },
  { aksi: AKSI.RECORD_VOID, label: 'Batalkan record apa pun', kategori: 'Pembatalan' },
  { aksi: AKSI.RECORD_VOID_SENDIRI, label: 'Batalkan record pending', kategori: 'Pembatalan' },
  { aksi: AKSI.STOCK_OPNAME_KELOLA, label: 'Kelola stock opname', kategori: 'Administratif' },
  { aksi: AKSI.EXPORT_JALANKAN, label: 'Jalankan export', kategori: 'Administratif' },
  { aksi: AKSI.MASTER_KELOLA, label: 'Kelola master data & import', kategori: 'Administratif' },
]);

/**
 * Apakah peran ini berwenang melakukan tindakan tersebut?
 *
 * Selalu mengembalikan boolean. Peran maupun tindakan yang tidak dikenal
 * ditolak — bukan diabaikan.
 *
 * Hak akses custom (FR-34.2) bersifat ADITIF: `can` mengembalikan true bila
 * matriks peran mengizinkan ATAU aksi ada di `customPermissions`. Custom tidak
 * pernah mencabut yang sudah diizinkan matriks (BR-27) - tidak ada jalur untuk
 * itu di sini.
 *
 * @param {string} peran
 * @param {string} aksi
 * @param {string[]} [customPermissions] aksi tambahan di luar matriks peran
 * @returns {boolean}
 */
export function can(peran, aksi, customPermissions) {
  if (MATRIKS[peran]?.[aksi] === true) return true;
  return Array.isArray(customPermissions) && customPermissions.includes(aksi);
}

/**
 * Seluruh tindakan yang diizinkan bagi suatu peran.
 * Dipakai klien untuk menyembunyikan menu yang tidak relevan — sebagai
 * kenyamanan, bukan sebagai mekanisme keamanan.
 *
 * @param {string} peran
 * @returns {string[]}
 */
export function aksiUntukPeran(peran) {
  const baris = MATRIKS[peran];
  if (!baris) return [];
  return Object.entries(baris)
    .filter(([, diizinkan]) => diizinkan === true)
    .map(([aksi]) => aksi);
}

/**
 * Gabungan aksi matriks peran + hak akses custom yang sah (FR-34.2.5).
 * Dipakai klien untuk menyaring menu, dan endpoint /auth/me untuk mengabarkannya.
 * Custom yang bukan AKSI valid dibuang; hasilnya tanpa duplikat.
 *
 * @param {string} peran
 * @param {string[]} [customPermissions]
 * @returns {string[]}
 */
export function aksiUntukUser(peran, customPermissions) {
  const gabung = new Set(aksiUntukPeran(peran));
  if (Array.isArray(customPermissions)) {
    for (const aksi of customPermissions) if (AKSI_SAH.has(aksi)) gabung.add(aksi);
  }
  return [...gabung];
}

/**
 * Membersihkan senarai custom permissions terhadap suatu peran (FR-34.3.5):
 * membuang aksi yang tak dikenal, yang duplikat, dan yang SUDAH diberikan
 * matriks peran itu (redundan). Dipakai saat peran user diubah.
 *
 * @param {string} peran
 * @param {string[]} [customPermissions]
 * @returns {string[]}
 */
export function customPermissionsBersih(peran, customPermissions) {
  if (!Array.isArray(customPermissions)) return [];
  const hasil = [];
  const terlihat = new Set();
  for (const aksi of customPermissions) {
    if (!AKSI_SAH.has(aksi) || terlihat.has(aksi)) continue;
    if (can(peran, aksi)) continue; // sudah dimiliki peran - redundan
    terlihat.add(aksi);
    hasil.push(aksi);
  }
  return hasil;
}

/**
 * Menegakkan wewenang DI LAPIS SERVICE, bukan hanya di rute.
 *
 * Middleware rute sudah memeriksanya, dan pemeriksaan itu nyata - tidak seperti
 * properti `Visible` tombol di Power Apps (B-22). Tetapi penjagaan yang hanya
 * ada di satu lapis berlaku hanya bagi pemanggil yang melewati lapis itu, dan
 * proyek ini sudah dua kali tersandung pola yang sama: skema zod di lapis rute
 * yang dilewati alur persetujuan permintaan koreksi, dan penjaga dedupe di
 * lapis api yang dilewati pemulih sesi. Keduanya benar sampai jalur masuk
 * kedua lahir.
 *
 * Karena approval dan void adalah keputusan mutu yang tidak dapat dibatalkan,
 * pemeriksaannya diletakkan tepat di tempat keputusan itu diambil.
 *
 * Hak akses custom (`aktor.cp`) ikut diperhitungkan, sehingga penjagaan lapis
 * service konsisten dengan middleware rute (FR-34.5.2).
 *
 * @param {{role: string, cp?: string[]}} aktor
 * @param {string} aksi  salah satu nilai AKSI
 */
export function pastikanBerwenang(aktor, aksi) {
  if (!aktor?.role || !can(aktor.role, aksi, aktor.cp)) {
    throw new ForbiddenError(
      `Peran ${aktor?.role ?? 'tanpa peran'} tidak berwenang melakukan tindakan ini`,
    );
  }
}
