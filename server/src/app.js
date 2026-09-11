import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { cekKoneksi } from './db/pool.js';
import cookieParser from 'cookie-parser';
import { errorHandler, asyncHandler, NotFoundError } from './middleware/errors.js';
import { wajibLogin, wajibWewenang } from './middleware/auth.js';
import { batasAuth, batasUmum } from './middleware/rateLimit.js';
import authRoutes from './routes/auth.js';
import receivingRoutes from './routes/receiving.js';
import prepastRoutes from './routes/prepast.js';
import transferRoutes from './routes/transfer.js';
import siloRoutes from './routes/silo.js';
import monitoringRoutes from './routes/monitoring.js';
import pengembalianRoutes from './routes/pengembalian.js';
import approvalRoutes from './routes/approval.js';
import voidRoutes from './routes/void.js';
import dataListRoutes from './routes/dataList.js';
import koreksiRoutes from './routes/koreksi.js';
import permintaanKoreksiRoutes from './routes/permintaanKoreksi.js';
import exportRoutes from './routes/export.js';
import stockOpnameRoutes from './routes/stockOpname.js';
import masterRoutes from './routes/master.js';
import analitikRoutes from './routes/analitik.js';
import importDataRoutes from './routes/importData.js';
import lossesRoutes from './routes/losses.js';
import publicRoutes from './routes/public.js';
import dashboardShareRoutes from './routes/dashboardShare.js';
import pengaturanRoutes from './routes/pengaturan.js';

export function buatApp(logger) {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  // Jaring pengaman terhadap klien yang membanjiri; ambangnya tinggi supaya
  // pemakaian normal tidak pernah menyentuhnya. Health check dikecualikan
  // agar pemantau luar dapat menyapa sesering apa pun.
  app.use('/api', batasUmum);

  // Di produksi klien disajikan Nginx dari origin yang sama, sehingga CORS
  // tidak diperlukan. Saat pengembangan, Vite berjalan di port terpisah.
  if (!config.isProd) {
    app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  }

  // --- Health check (NFR-20) ---
  app.get(
    '/health',
    asyncHandler(async (req, res) => {
      const mulai = Date.now();
      let db = 'ok';
      try {
        await cekKoneksi();
      } catch {
        db = 'gagal';
      }

      const sehat = db === 'ok';
      res.status(sehat ? 200 : 503).json({
        status: sehat ? 'ok' : 'gagal',
        uptime_detik: Math.floor(process.uptime()),
        db,
        // Waktu server dalam UTC. Perbedaan mencolok dengan jam klien adalah
        // petunjuk awal jam server melenceng (NFR-14).
        server_time_utc: new Date().toISOString(),
        latency_ms: Date.now() - mulai,
      });
    }),
  );

  app.get('/api/v1', (req, res) => {
    res.json({
      nama: 'CMD 1 Operation API',
      versi: 'v1',
      env: config.env,
    });
  });

  // Pembatas ketat KHUSUS pintu auth, di depan router-nya. Menutup celah yang
  // tidak dijaga penguncian per-akun: menebak satu password ke banyak
  // username sekaligus (lihat rateLimit.js).
  app.use('/api/v1/auth/login', batasAuth);
  app.use('/api/v1/auth/change-password', batasAuth);
  app.use('/api/v1/auth', authRoutes);

  // Endpoint pembuktian penegakan wewenang di server (uji T-16).
  // Sengaja tidak punya UI: pengujian memanggilnya langsung, melewati
  // tampilan sepenuhnya, untuk memastikan yang menahan adalah lapis server —
  // bukan tombol yang disembunyikan.
  app.get(
    '/api/v1/_rbac-check/:aksi',
    wajibLogin,
    (req, res, next) => wajibWewenang(req.params.aksi)(req, res, next),
    (req, res) => res.json({ diizinkan: true, aksi: req.params.aksi, role: req.user.role }),
  );

  app.use('/api/v1/receiving', receivingRoutes);
  app.use('/api/v1/prepast', prepastRoutes);
  app.use('/api/v1/transfer', transferRoutes);
  app.use('/api/v1/silos', siloRoutes);
  app.use('/api/v1/export', exportRoutes);
  app.use('/api/v1/stock-opname', stockOpnameRoutes);
  app.use('/api/v1/master', masterRoutes);
  app.use('/api/v1/analitik', analitikRoutes);
  app.use('/api/v1/import', importDataRoutes);
  app.use('/api/v1/losses', lossesRoutes);
  app.use('/api/v1/monitoring', monitoringRoutes);
  app.use('/api/v1/pengembalian', pengembalianRoutes);
  app.use('/api/v1/approval', approvalRoutes);
  app.use('/api/v1/void', voidRoutes);
  app.use('/api/v1/data', dataListRoutes);
  app.use('/api/v1/koreksi', koreksiRoutes);
  app.use('/api/v1/permintaan-koreksi', permintaanKoreksiRoutes);
  // Tautan publik dashboard: endpoint tanpa login (gerbang token) + pengelolaannya.
  app.use('/api/v1/public', publicRoutes);
  app.use('/api/v1/dashboard-share', dashboardShareRoutes);
  app.use('/api/v1/pengaturan', pengaturanRoutes);

  // --- Route modul lain dipasang di sini seiring fase berjalan ---

  app.use((req, res, next) => next(new NotFoundError('Endpoint')));
  app.use(errorHandler(logger));

  return app;
}
