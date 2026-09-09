/**
 * Pembatas laju permintaan - NFR keamanan
 *
 * MENGAPA DITULIS SENDIRI, BUKAN MEMAKAI PUSTAKA.
 *
 * Aplikasi ini berjalan sebagai SATU instans di jaringan pabrik, di belakang
 * Nginx. Pada bentuk itu, penghitung di memori proses sudah cukup dan tidak
 * menambah satu pun dependensi yang harus dijaga - Redis atau store eksternal
 * baru bermakna bila ada beberapa instans yang harus berbagi hitungan, dan itu
 * bukan keadaan yang ada di sini.
 *
 * APA YANG DIJAGANYA, DAN APA YANG TIDAK.
 *
 * Penguncian per-AKUN sudah ada di auth/service.js: lima kali salah password
 * mengunci akun itu. Yang TIDAK dijaga penguncian akun adalah penyerang yang
 * mencoba SATU tebakan terhadap BANYAK username - tiap akun tetap di bawah
 * ambangnya, tetapi ribuan permintaan tetap lewat. Pembatas ini menutup celah
 * itu dengan menghitung per ALAMAT IP, bukan per akun.
 *
 * Keduanya saling melengkapi, bukan menggantikan: satu menjaga dari sisi
 * korban, satu dari sisi penyerang.
 */

import { AppError } from './errors.js';

/**
 * Membuat satu pembatas laju berbasis jendela geser sederhana.
 *
 * @param {object} opsi
 * @param {number} opsi.jendelaMs    panjang jendela dalam milidetik
 * @param {number} opsi.maks         permintaan maksimal per IP dalam jendela
 * @param {string} [opsi.pesan]      pesan saat batas terlampaui
 * @param {(req) => boolean} [opsi.lewati]  kembalikan true untuk melewati hitungan
 */
export function pembatasLaju({ jendelaMs, maks, pesan, lewati }) {
  /**
   * Peta IP -> daftar cap waktu permintaan di dalam jendela.
   *
   * Map, bukan objek biasa: kuncinya berasal dari luar (alamat IP), dan objek
   * biasa mewarisi kunci seperti "__proto__" yang dapat dipakai mengacau
   * strukturnya. Map tidak punya masalah itu.
   */
  const jejak = new Map();

  /*
   * Pembersihan berkala.
   *
   * Tanpa ini, IP yang menyerang sekali lalu pergi meninggalkan entri yang
   * tidak pernah terhapus - kebocoran memori yang lambat tetapi pasti. Timer
   * di-unref supaya keberadaannya tidak menahan proses tetap hidup saat mau
   * dimatikan.
   */
  const bersihkan = setInterval(() => {
    const batas = Date.now() - jendelaMs;
    for (const [ip, cap] of jejak) {
      const tersisa = cap.filter((t) => t > batas);
      if (tersisa.length === 0) jejak.delete(ip);
      else jejak.set(ip, tersisa);
    }
  }, jendelaMs);
  bersihkan.unref?.();

  return (req, res, next) => {
    if (lewati?.(req)) return next();

    // req.ip sudah menghormati 'trust proxy' yang di-set di app.js, sehingga
    // di belakang Nginx yang terbaca IP klien sebenarnya, bukan IP Nginx.
    const ip = req.ip ?? 'tak-dikenal';
    const sekarang = Date.now();
    const batas = sekarang - jendelaMs;

    const cap = (jejak.get(ip) ?? []).filter((t) => t > batas);
    cap.push(sekarang);
    jejak.set(ip, cap);

    if (cap.length > maks) {
      // Retry-After membantu klien yang jujur menahan diri, dan tidak
      // membocorkan apa pun yang berguna bagi penyerang.
      const tungguDetik = Math.ceil(jendelaMs / 1000);
      res.set('Retry-After', String(tungguDetik));
      return next(
        new AppError(pesan ?? 'Terlalu banyak permintaan. Coba lagi nanti.', {
          status: 429,
          code: 'RATE_LIMITED',
        }),
      );
    }

    return next();
  };
}

/**
 * Pembatas untuk endpoint autentikasi.
 *
 * Ketat, sebab inilah pintu yang paling banyak digedor: 10 percobaan per menit
 * per IP sudah jauh di atas kebutuhan manusia yang sedang login, dan jauh di
 * bawah laju yang berguna untuk menebak password secara otomatis.
 *
 * Login yang BERHASIL tidak dihukum: `lewati` mengeluarkan permintaan yang
 * sudah membawa sesi sah, supaya operator yang berpindah halaman dengan cepat
 * tidak terkena batas ini.
 */
export const batasAuth = pembatasLaju({
  jendelaMs: 60_000,
  maks: 10,
  pesan: 'Terlalu banyak percobaan masuk. Tunggu satu menit lalu coba lagi.',
});

/**
 * Pembatas longgar untuk seluruh API.
 *
 * Bukan untuk menahan serangan - itu tugas pembatas auth - melainkan jaring
 * pengaman terhadap klien yang rusak atau skrip yang lepas kendali dan
 * membanjiri server dengan ribuan permintaan per detik. Ambangnya tinggi
 * supaya pemakaian normal, termasuk dashboard yang menyegar tiap 30 detik dari
 * banyak perangkat, tidak pernah menyentuhnya.
 */
export const batasUmum = pembatasLaju({
  jendelaMs: 60_000,
  maks: 600,
});
