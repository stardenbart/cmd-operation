/**
 * Middleware autentikasi & otorisasi — FR-1.4, BR-22, uji T-16
 *
 * Wewenang diperiksa DI SINI, bukan dengan menyembunyikan tombol di UI.
 *
 * Otorisasi Power Apps sepenuhnya bertumpu pada properti `Visible` tombol,
 * sehingga siapa pun yang dapat memanggil operasi tulis dapat menyetujui atau
 * mem-void record (B-22). Uji T-16 memanggil endpoint secara langsung,
 * melewati UI, untuk memastikan lapis ini benar-benar menahan.
 */

import { verifikasiAccessToken } from '../auth/tokens.js';
import { can } from '../auth/permissions.js';
import { shiftPada } from '../auth/shift.js';
import { UnauthorizedError, ForbiddenError } from './errors.js';

/** Mewajibkan access token yang sah. Mengisi `req.user`. */
export function wajibLogin(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new UnauthorizedError('Token tidak disertakan'));
  }

  try {
    const klaim = verifikasiAccessToken(token);

    /*
     * Sesi berakhir begitu shift berganti — DIPERIKSA DI SINI, tiap request,
     * bukan hanya saat refresh(). Access token hidup 15 menit; menunggu
     * kedaluwarsa wajarnya berarti operator shift berikutnya bisa memakai
     * identitas operator shift sebelumnya (yang lupa logout) sampai 15 menit
     * — jejak audit mencatat orang yang salah. `shift` di klaim adalah shift
     * ASAL SESI (lihat login()/refresh()), dibandingkan dengan shift SAAT
     * INI, bukan disamakan dengan waktu token diterbitkan.
     */
    if (klaim.shift !== shiftPada()) {
      return next(new UnauthorizedError('Sesi berakhir — pergantian shift, silakan masuk kembali'));
    }

    req.user = {
      id: klaim.sub,
      kode: klaim.kode,
      nama: klaim.nama,
      role: klaim.role,
      // Hak akses custom (FR-34) - array bila ada, selalu tersedia untuk can().
      cp: Array.isArray(klaim.cp) ? klaim.cp : [], // values cp darimana
    };
    return next();
  } catch (err) {
    const kedaluwarsa = err.name === 'TokenExpiredError';
    return next(
      new UnauthorizedError(
        kedaluwarsa ? 'Sesi telah berakhir, silakan masuk kembali' : 'Token tidak valid',
      ),
    );
  }
}

/**
 * Mewajibkan wewenang tertentu menurut matriks 2.10.1.
 *
 * @example
 *   router.post('/approve', wajibLogin, wajibWewenang(AKSI.APPROVAL_PUTUSKAN), handler)
 */
export function wajibWewenang(aksi) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }
    if (!can(req.user.role, aksi, req.user.cp)) {
      req.log?.warn(
        { role: req.user.role, aksi, operator: req.user.kode },
        'Percobaan tindakan tanpa wewenang',
      );
      return next(
        new ForbiddenError(
          `Peran ${req.user.role} tidak berwenang melakukan tindakan ini`,
        ),
      );
    }
    return next();
  };
}
