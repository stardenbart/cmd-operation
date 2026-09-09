/**
 * Kontrak error — F0-10
 *
 * Bentuk balasan seragam: { code, message, details }
 * `code` merujuk nomor business rule bila yang dilanggar adalah aturan bisnis,
 * sehingga klien maupun log dapat menunjuk aturan mana yang tersentuh.
 */

export class AppError extends Error {
  constructor(message, { status = 400, code = 'BAD_REQUEST', details = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Pelanggaran aturan bisnis. `code` diisi nomor aturan (mis. 'BR-05').
 *
 * @example
 *   throw new BusinessError('BR-05', 'Volume transfer melebihi total supplier tersedia', {
 *     diminta: 8000, tersedia: 5000,
 *   });
 */
export class BusinessError extends AppError {
  constructor(rule, message, details = null) {
    super(message, { status: 422, code: rule, details });
    this.name = 'BusinessError';
  }
}

export class NotFoundError extends AppError {
  constructor(apa = 'Data') {
    super(`${apa} tidak ditemukan`, { status: 404, code: 'NOT_FOUND' });
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Sesi tidak valid atau telah berakhir') {
    super(message, { status: 401, code: 'UNAUTHORIZED' });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Anda tidak berwenang melakukan tindakan ini') {
    super(message, { status: 403, code: 'FORBIDDEN' });
    this.name = 'ForbiddenError';
  }
}

/** Penangan error terakhir. Dipasang paling belakang di rantai middleware. */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express mengenali 4 argumen sebagai error handler
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      logger.warn({ code: err.code, path: req.path }, err.message);
      return res.status(err.status).json({
        code: err.code,
        message: err.message,
        details: err.details,
      });
    }

    /*
     * Galat dari express.json() SEBELUM jatuh ke 500.
     *
     * Body yang melampaui batas 1 MB dan JSON yang rusak adalah kesalahan
     * PERMINTAAN, bukan cacat server. Tanpa pemetaan ini keduanya terbalas
     * 500 - status yang salah menuntun klien menyalahkan server, dan pada
     * body kelewat besar, 500 bahkan mengaburkan bahwa yang perlu diperkecil
     * adalah permintaannya sendiri.
     */
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Data yang dikirim terlalu besar.',
        details: null,
      });
    }
    if (err.type === 'entity.parse.failed' || (err.status === 400 && err.expose)) {
      return res.status(400).json({
        code: 'BAD_JSON',
        message: 'Isi permintaan bukan JSON yang sah.',
        details: null,
      });
    }

    // Constraint database yang lolos ke sini adalah cacat kode, bukan kesalahan
    // pengguna — dicatat lengkap, tetapi tidak dibocorkan ke klien.
    logger.error({ err, path: req.path }, 'Kesalahan tak tertangani');
    return res.status(500).json({
      code: 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan pada server. Hubungi administrator.',
      details: null,
    });
  };
}

/** Pembungkus route async agar penolakan promise sampai ke errorHandler. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
