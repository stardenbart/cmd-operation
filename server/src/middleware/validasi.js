import { z } from 'zod';
import { AppError } from './errors.js';
import { parseAngka } from '../services/konversi.js';

/** Memvalidasi body permintaan; pelanggaran menjadi error 400 yang jelas. */
export function validasiBody(skema) {
  return (req, res, next) => {
    const hasil = skema.safeParse(req.body);
    if (!hasil.success) {
      return next(
        new AppError('Data yang dikirim tidak valid', {
          code: 'VALIDATION_ERROR',
          details: hasil.error.issues.map((i) => ({
            field: i.path.join('.') || '(body)',
            pesan: i.message,
          })),
        }),
      );
    }
    req.body = hasil.data;
    return next();
  };
}

export function validasiQuery(skema) {
  return (req, res, next) => {
    const hasil = skema.safeParse(req.query);
    if (!hasil.success) {
      return next(
        new AppError('Parameter permintaan tidak valid', {
          code: 'VALIDATION_ERROR',
          details: hasil.error.issues.map((i) => ({
            field: i.path.join('.'),
            pesan: i.message,
          })),
        }),
      );
    }
    req.query = hasil.data;
    return next();
  };
}

/**
 * Angka desimal yang diketik operator — menerima titik maupun koma.
 *
 * Dibungkus di lapis validasi supaya tiap route tidak perlu mengurainya
 * sendiri. Di Power Apps, `Substitute(text, ",", ".")` tersebar di belasan
 * formula dan sebagian terlewat.
 */
export const angkaDesimal = ({ min = 0, maxDecimals, inclusive = false } = {}) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    try {
      const n = parseAngka(v);
      if (inclusive ? n < min : n <= min) {
        ctx.addIssue({
          code: 'custom',
          message: inclusive ? `minimal ${min}` : `harus lebih besar dari ${min}`,
        });
        return z.NEVER;
      }
      if (maxDecimals !== undefined) {
        const desimal = String(n).split('.')[1]?.length ?? 0;
        if (desimal > maxDecimals) {
          ctx.addIssue({ code: 'custom', message: `maksimal ${maxDecimals} angka desimal` });
          return z.NEVER;
        }
      }
      return n;
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: err.message });
      return z.NEVER;
    }
  });

/**
 * Angka desimal yang boleh dikosongkan.
 *
 * `.optional()` saja tidak cukup: form HTML mengirim field kosong sebagai
 * string kosong, bukan undefined, sehingga nilai itu tetap masuk ke transform
 * dan ditolak sebagai "angka tidak boleh kosong". Operator jadi tidak dapat
 * melewatkan field yang memang opsional.
 */
export const angkaDesimalOpsional = (opsi) =>
  z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    angkaDesimal(opsi).optional(),
  );

/** Teks yang boleh dikosongkan — alasan yang sama seperti di atas. */
export const teksOpsional = (maks = 1000) =>
  z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().max(maks).optional(),
  );

/**
 * Waktu sebagai satu nilai datetime — WF-1.
 *
 * Power Apps memakai tiga kontrol terpisah (DatePicker + jam + menit) dan
 * merakit string "mm/dd/yyyy hh:mm", lalu membongkarnya kembali dengan
 * offset karakter yang di-hardcode. Enam aturan validasi "harus 2 digit"
 * dan "menit <= 59" lahir dari situ — dan hilang seluruhnya di sini.
 */
export const waktu = () =>
  z.coerce.date({ errorMap: () => ({ message: 'waktu tidak valid' }) });
