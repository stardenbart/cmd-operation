import { config as muatEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// .env berada di akar repositori, bukan di dalam workspace server/.
// Tanpa path eksplisit, dotenv mencarinya relatif terhadap direktori kerja —
// yang berbeda antara `npm run dev` (root) dan `npm run db:migrate` (server/).
const AKAR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
muatEnv({ path: join(AKAR, '.env') });

/** Membaca env wajib; gagal cepat bila kosong — lebih baik daripada error samar saat runtime. */
function wajib(nama) {
  const nilai = process.env[nama];
  if (!nilai) {
    throw new Error(
      `Konfigurasi wajib "${nama}" belum diisi. Salin .env.example ke .env lalu lengkapi.`,
    );
  }
  return nilai;
}

const angka = (nama, bawaan) => Number(process.env[nama] ?? bawaan);
const boolean = (nama, bawaan = false) => {
  const nilai = process.env[nama];
  if (nilai == null) return bawaan;
  return ['1', 'true', 'yes', 'on'].includes(nilai.trim().toLowerCase());
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: angka('PORT', 3000),

  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: angka('DB_PORT', 3306),
    database: process.env.DB_NAME ?? 'fm_receiving',
    user: process.env.DB_USER ?? 'fm_app',
    password: wajib('DB_PASSWORD'),
    connectionLimit: angka('DB_CONNECTION_LIMIT', 10),
    collation: process.env.DB_COLLATION ?? 'utf8mb4_unicode_ci',
    ssl: boolean('DB_SSL'),
    sslCa: process.env.DB_SSL_CA?.replace(/\\n/g, '\n'),
  },

  auth: {
    jwtSecret: wajib('JWT_SECRET'),
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
    idleTimeoutHours: angka('SESSION_IDLE_TIMEOUT_HOURS', 8),
    // Delapan, bukan enam seperti PIN lama. Enam digit angka hanya sejuta
    // kemungkinan, dan itu justru alasan pindah dari PIN (migrasi 012).
    passwordMinLength: angka('PASSWORD_MIN_LENGTH', 8),
    maxAttempts: angka('LOGIN_MAX_ATTEMPTS', 5),
    lockoutMinutes: angka('LOGIN_LOCKOUT_MINUTES', 15),
  },

  // Seluruh timestamp disimpan UTC (A-4). Zona ini hanya untuk tampilan & export.
  time: {
    timezone: process.env.APP_TIMEZONE ?? 'Asia/Jakarta',
    driftWarnSeconds: angka('CLOCK_DRIFT_WARN_SECONDS', 5),
  },

  export: {
    outputDir: process.env.EXPORT_OUTPUT_DIR ?? './export-output',
    dailyCron: process.env.EXPORT_DAILY_CRON ?? '0 6 * * *',
  },

  log: {
    level: process.env.LOG_LEVEL ?? 'info',
    dir: process.env.LOG_DIR ?? './logs',
  },
};
