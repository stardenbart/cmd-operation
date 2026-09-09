/**
 * Dashboard analitik - FR-27
 *
 * Terbuka bagi siapa pun yang boleh melihat dashboard. Isinya agregat, bukan
 * record perorangan, dan operator yang melihat pola kedatangan hari ini justru
 * bekerja lebih baik.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as analitik from '../services/analitik.js';
import { bangunBerkasAnalitik, namaBerkasAnalitik } from '../services/analitikExcel.js';
import { pool } from '../db/pool.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler } from '../middleware/errors.js';
import { validasiQuery } from '../middleware/validasi.js';
import { normalisasiWaktuFilter } from '../services/waktu.js';

const router = Router();
router.use(wajibLogin);

const TANGGAL_WAKTU = z.string().transform((v, ctx) => {
  try {
    return normalisasiWaktuFilter(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'tanggal/waktu tidak sah' });
    return z.NEVER;
  }
});

const skemaRentang = z
  .object({
    mode: z.enum(['realtime', 'historis']).optional(),
    dari: z.preprocess((v) => (v === '' || v == null ? undefined : v), TANGGAL_WAKTU.optional()),
    sampai: z.preprocess((v) => (v === '' || v == null ? undefined : v), TANGGAL_WAKTU.optional()),
  })
  .extend({
    siloIds: z.preprocess(
      (v) => (v === '' || v == null
        ? undefined
        : typeof v === 'string' ? v.split(',').filter(Boolean) : v),
      z.array(z.coerce.number().int().positive()).max(50).optional(),
    ),
    // Kompatibilitas untuk tautan lama yang hanya membawa satu silo.
    siloId: z.preprocess(
      (v) => (v === '' || v == null || v === 'semua' ? undefined : v),
      z.coerce.number().int().positive().optional(),
    ),
  })
  .refine((v) => !v.dari || !v.sampai || new Date(v.sampai) >= new Date(v.dari), {
    message: 'tanggal akhir tidak boleh lebih awal daripada tanggal mulai',
  })
  .refine((v) => !v.dari || !v.sampai
    || new Date(v.sampai).getTime() - new Date(v.dari).getTime() <= 90 * 86_400_000, {
    message: 'rentang maksimum adalah 90 hari',
  });

function rentangDariQuery(query) {
  if (query.dari) {
    return analitik.rentang(query.dari, query.sampai, idSiloDariQuery(query));
  }
  const sekarang = new Date();
  const bagian = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(sekarang).map((p) => [p.type, p.value]),
  );
  const awalHariWib = `${bagian.year}-${bagian.month}-${bagian.day}T00:00:00+07:00`;
  return analitik.rentang(
    awalHariWib, sekarang.toISOString(), idSiloDariQuery(query),
  );
}

/** Silo yang dapat dipilih sebagai penyaring. Buffer dikecualikan (BR-02). */
async function daftarSiloPenyaring() {
  const [baris] = await pool.query(
    `SELECT id, silo_name FROM silo
      WHERE is_active = TRUE AND is_buffer = FALSE ORDER BY urutan`,
  );
  return baris.map((b) => ({ id: b.id, siloName: b.silo_name }));
}

const idSiloDariQuery = (query) => (
  query.siloIds?.length > 0 ? query.siloIds : query.siloId ? [query.siloId] : []
);

async function namaSilo(siloIds) {
  if (!siloIds?.length) return [];
  const [baris] = await pool.query(
    `SELECT silo_name FROM silo
      WHERE id IN (${siloIds.map(() => '?').join(', ')})
      ORDER BY urutan`,
    siloIds,
  );
  return baris.map((b) => b.silo_name);
}

/**
 * Seluruh dashboard dalam SATU permintaan.
 *
 * Dua belas grafik berarti dua belas permintaan bila dipisah, dan pada tablet
 * pabrik lewat wifi itu terasa. Yang lebih penting: panel-panelnya harus
 * memperlihatkan keadaan yang SAMA. Permintaan terpisah yang tiba beberapa
 * detik berjauhan dapat menampilkan angka ringkasan dari sebelum sebuah
 * transfer dan grafik dari sesudahnya, dan pembacanya tidak akan tahu.
 */
router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaRentang),
  asyncHandler(async (req, res) => {
    const r = rentangDariQuery(req.query);
    const siloNames = await namaSilo(r.siloIds);

    res.json({
      rentang: {
        dari: r.dariIso,
        sampai: r.sampaiIso,
        zonaWaktu: r.tz,
        siloId: r.siloId,
        siloIds: r.siloIds,
        siloName: siloNames.length > 0 ? siloNames.join(', ') : null,
        siloNames,
        mode: req.query.dari ? 'historis' : 'realtime',
      },
      // Empat kumpulan data ini saling bebas, jadi diminta BERSAMAAN.
      // Menunggunya satu per satu hanya menjumlahkan latensi tanpa alasan;
      // basis data sudah mengerjakan yang terberat (grafik) secara paralel.
      ...(await (async () => {
        const [siloTersedia, ringkasan, perhatian, grafik] = await Promise.all([
          daftarSiloPenyaring(),
          analitik.ringkasan(r),
          analitik.perhatian(r),
          analitik.semuaGrafik(r),
        ]);
        return { siloTersedia, ringkasan, perhatian, grafik };
      })()),
    });
  }),
);

/**
 * Mode "Sesi Prepast" - FR-33.4. Data sesi terstruktur per silo (IN/OUT),
 * memakai filter waktu & silo yang sama dengan dashboard.
 */
router.get(
  '/sesi',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaRentang),
  asyncHandler(async (req, res) => {
    const r = rentangDariQuery(req.query);
    const [siloTersedia, siloNames, hasil] = await Promise.all([
      daftarSiloPenyaring(),
      namaSilo(r.siloIds),
      analitik.sesiDetail(r),
    ]);
    res.json({
      rentang: {
        dari: r.dariIso,
        sampai: r.sampaiIso,
        zonaWaktu: r.tz,
        siloIds: r.siloIds,
        siloName: siloNames.length > 0 ? siloNames.join(', ') : null,
        siloNames,
        mode: req.query.dari ? 'historis' : 'realtime',
      },
      siloTersedia,
      ...hasil,
    });
  }),
);

/** Satu grafik saja, untuk penyegaran sebagian atau export CSV per panel. */
router.get(
  '/grafik/:jenis',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaRentang),
  asyncHandler(async (req, res) => {
    const r = rentangDariQuery(req.query);
    const hasil = await analitik.grafik(req.params.jenis, r);

    if (!hasil) {
      res.status(404).json({
        code: 'NOT_FOUND',
        message: `Grafik tidak dikenal: ${req.params.jenis}`,
        details: { tersedia: Object.keys(analitik.GRAFIK) },
      });
      return;
    }
    res.json({ data: hasil });
  }),
);

/**
 * Export seluruh dashboard ke Excel - FR-27.1.6.
 *
 * Yang diekspor ANGKANYA, bukan gambar grafiknya: berkas yang dibawa ke rapat
 * perlu dapat dihitung ulang dan dipivot penerimanya, dan gambar tidak dapat.
 */
router.get(
  '/excel',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaRentang),
  asyncHandler(async (req, res) => {
    const r = rentangDariQuery(req.query);
    const siloNames = await namaSilo(r.siloIds);
    const konteks = { siloName: siloNames.length > 0 ? siloNames.join(', ') : null };

    const buffer = await bangunBerkasAnalitik(r, konteks);
    const nama = namaBerkasAnalitik(r, konteks);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nama}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.end(buffer);
  }),
);

export default router;
