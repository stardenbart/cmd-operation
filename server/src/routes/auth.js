import { Router } from 'express';
import { z } from 'zod';
import * as auth from '../auth/service.js';
import { aksiUntukUser } from '../auth/permissions.js';
import { wajibLogin } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/errors.js';

const router = Router();

/** Memvalidasi body permintaan; pelanggaran menjadi error 400 yang jelas. */
function validasi(skema) {
  return (req, res, next) => {
    const hasil = skema.safeParse(req.body);
    if (!hasil.success) {
      return next(
        new AppError('Data yang dikirim tidak valid', {
          code: 'VALIDATION_ERROR',
          details: hasil.error.issues.map((i) => ({
            field: i.path.join('.'),
            pesan: i.message,
          })),
        }),
      );
    }
    req.body = hasil.data;
    return next();
  };
}

const skemaLogin = z.object({
  username: z.string().trim().min(1).max(60),
  // Batas atas 200, bukan 12: password bukan PIN, dan memotongnya di 12
  // membuat password panjang gagal diverifikasi tanpa sebab yang terlihat.
  password: z.string().min(1).max(200),
});

const skemaGantiPassword = z.object({
  passwordLama: z.string().min(1).max(200),
  passwordBaru: z.string().min(1).max(200),
});

/*
 * Endpoint /operators DIHAPUS bersama dropdown login.
 *
 * Ia mengirim daftar seluruh operator aktif ke perangkat mana pun yang membuka
 * halaman login, tanpa perlu login lebih dulu. Selama dropdown ada, daftar itu
 * memang tidak dapat dihindari; begitu login memakai username, daftar itu
 * berubah menjadi bocoran murni - siapa saja yang bekerja di sini, dan
 * username mereka.
 */

router.post(
  '/login',
  validasi(skemaLogin),
  asyncHandler(async (req, res) => {
    const hasil = await auth.login({
      username: req.body.username,
      password: req.body.password,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });

    // Refresh token dikirim sebagai cookie httpOnly — tidak dapat dibaca
    // JavaScript, sehingga XSS tidak langsung berarti pembajakan sesi.
    res.cookie('fm_refresh', hasil.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      accessToken: hasil.accessToken,
      operator: hasil.operator,
      mustChangePin: hasil.mustChangePin,
      // Dikirim agar klien dapat menyembunyikan menu yang tidak relevan.
      // Ini kenyamanan tampilan, BUKAN mekanisme keamanan — penegakannya
      // tetap di endpoint (BR-22).
      wewenang: aksiUntukUser(hasil.operator.role, hasil.operator.customPermissions),
    });
  }),
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const hasil = await auth.refresh({
      refreshToken: req.cookies?.fm_refresh ?? req.body?.refreshToken,
      userAgent: req.headers['user-agent'],
    });

    res.cookie('fm_refresh', hasil.refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ accessToken: hasil.accessToken });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await auth.logout({ refreshToken: req.cookies?.fm_refresh });
    res.clearCookie('fm_refresh', { path: '/api/v1/auth' });
    res.json({ pesan: 'Berhasil keluar' });
  }),
);

router.post(
  '/change-password',
  wajibLogin,
  validasi(skemaGantiPassword),
  asyncHandler(async (req, res) => {
    await auth.gantiPassword({
      operatorId: req.user.id,
      passwordLama: req.body.passwordLama,
      passwordBaru: req.body.passwordBaru,
      ip: req.ip,
    });
    // Seluruh sesi dicabut oleh gantiPassword(), termasuk yang ini.
    res.clearCookie('fm_refresh', { path: '/api/v1/auth' });
    res.json({ pesan: 'Password berhasil diganti. Silakan masuk kembali.' });
  }),
);

/** Identitas & wewenang sesi berjalan. */
router.get(
  '/me',
  wajibLogin,
  asyncHandler(async (req, res) => {
    res.json({
      // FR-34.5.3: customPermissions ikut dikembalikan agar klien menghitung menu.
      operator: { ...req.user, customPermissions: req.user.cp },
      wewenang: aksiUntukUser(req.user.role, req.user.cp),
    });
  }),
);

export default router;
