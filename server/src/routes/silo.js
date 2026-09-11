import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { wajibLogin, wajibWewenang } from '../middleware/auth.js';
import { AKSI } from '../auth/permissions.js';
import { asyncHandler, NotFoundError } from '../middleware/errors.js';
import { validasiQuery } from '../middleware/validasi.js';
import { normalisasiWaktuFilter, selisihMenit } from '../services/waktu.js';
import { snapshotSilo } from '../services/snapshotSilo.js';
import { siloLive, batchAktifLive, kgBelumTerkonversi } from '../services/dashboardLive.js';

const router = Router();
router.use(wajibLogin);

const skemaWaktu = z.object({
  dari: z.string().transform((v, ctx) => {
    try { return normalisasiWaktuFilter(v); } catch {
      ctx.addIssue({ code: 'custom', message: 'Tanggal/waktu tidak sah' });
      return z.NEVER;
    }
  }).optional(),
  sampai: z.string().transform((v, ctx) => {
    try { return normalisasiWaktuFilter(v); } catch {
      ctx.addIssue({ code: 'custom', message: 'Tanggal/waktu tidak sah' });
      return z.NEVER;
    }
  }).optional(),
}).superRefine((v, ctx) => {
  const mulai = v.dari ? new Date(v.dari) : null;
  const akhir = v.sampai ? new Date(v.sampai) : null;
  if ((mulai && Number.isNaN(mulai.getTime())) || (akhir && Number.isNaN(akhir.getTime()))) {
    ctx.addIssue({ code: 'custom', message: 'Tanggal/waktu tidak sah' });
  } else if (mulai && akhir && akhir < mulai) {
    ctx.addIssue({ code: 'custom', message: 'Waktu akhir tidak boleh lebih awal' });
  } else if (mulai && akhir && akhir - mulai > 90 * 86_400_000) {
    ctx.addIssue({ code: 'custom', message: 'Rentang maksimum adalah 90 hari' });
  }
});

/**
 * Kartu silo untuk dashboard — FR-2.
 *
 * Seluruh angka berasal dari VIEW, bukan dihitung di klien. Power Apps
 * menghitung ulang volume di setiap label dengan filter empat-kondisi yang
 * disalin lebih dari 30 kali (M-8); di sini satu sumber.
 */
router.get(
  '/',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaWaktu),
  asyncHandler(async (req, res) => {
    if (req.query.sampai) {
      const [hasil, kg] = await Promise.all([
        snapshotSilo(new Date(req.query.sampai)),
        kgBelumTerkonversi(),
      ]);
      const penyimpanan = hasil.silos.filter((b) => !b.is_buffer);
      res.json({
        data: hasil.silos,
        mode: 'historis',
        rentang: req.query,
        ringkasan: {
          totalVolLtr: penyimpanan.reduce((s, b) => s + Number(b.vol_aktual_ltr), 0),
          totalKapasitasLtr: penyimpanan.reduce((s, b) => s + Number(b.kapasitas_maks_ltr), 0),
          perluDicek: hasil.silos.filter((b) => b.status_cek === 'PERLU_DICEK').length,
          melampauiNominal: hasil.silos.filter((b) => b.dalam_toleransi).length,
          // Ini kondisi SEKARANG, bukan pada waktu snapshot — Berat Jenis
          // yang belum diisi adalah backlog operasional yang berlaku
          // terlepas dari rentang waktu yang sedang dilihat.
          ...kg,
        },
      });
      return;
    }
    // Mode real-time: sumber tunggal dipakai bersama tautan publik.
    res.json(await siloLive());
  }),
);

/**
 * Batch yang masih AKTIF di seluruh silo - tabel di bawah kartu Dashboard.
 *
 * Kartu silo menjawab "berapa isi silo ini". Tabel ini menjawab pertanyaan
 * berikutnya, yang sebelumnya menuntut membuka Detail Silo satu per satu:
 * isinya susu SIAPA, berapa TS-nya, dan sudah berapa lama berdiri.
 *
 * Definisi "aktif" DISALIN dari batchFifo() di services/transfer.js -
 * status_fifo ACTIVE, sisa di atas nol, status approval bukan yang diabaikan.
 * Definisi yang berbeda antara yang ditampilkan dan yang dipakai mengalokasi
 * FIFO akan membuat tabel ini memperlihatkan susu yang tidak pernah ikut
 * dialokasikan, dan tidak ada yang tahu mana yang benar.
 *
 * DUA STANDING TIME, dan keduanya dikirim karena keduanya menjawab pertanyaan
 * yang berbeda:
 *
 *   standingMenit       per BATCH, dari `prepast_finish`. Umur susu ITU
 *                       sendiri. Dua batch di satu silo memang berbeda umur.
 *
 *   standingSiloMenit   per SILO (BR-09). Inilah standing time yang dipakai
 *                       sebagai indikator mutu: diukur dari batch TERTUA yang
 *                       masih benar-benar berisi susu di silo. Saat batch tertua
 *                       habis terkuras, anchor bergeser ke batch berisi
 *                       berikutnya; ketika silo benar-benar kosong, standing
 *                       time hilang dan mulai lagi dari nol saat susu baru masuk.
 *
 * Angka kedua inilah yang dipakai grafik Standing time di Analitik dan kartu
 * silo di Dashboard, sehingga seluruh halaman memakai satu kamus yang sama.
 */
router.get(
  '/batch-aktif',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  validasiQuery(skemaWaktu),
  asyncHandler(async (req, res) => {
    if (req.query.sampai) {
      const akhirRentang = new Date(req.query.sampai);
      const hasil = await snapshotSilo(akhirRentang);
      const silo = new Map(hasil.silos.map((s) => [Number(s.silo_id), s]));
      res.json({ data: hasil.batch.map((b) => ({
        siloId: b.silo_id,
        siloKode: silo.get(Number(b.silo_id))?.kode,
        siloName: silo.get(Number(b.silo_id))?.silo_name,
        prepastId: b.id,
        batchKode: b.kode,
        jenisBatch: b.jenis_batch,
        supplierName: b.supplier_name,
        volumeLtr: Number(b.sisa),
        nilaiTs: b.nilai_ts === null ? null : Number(b.nilai_ts),
        prepastFinish: b.prepast_finish,
        prepastFinishIso: null,
        standingMenit: b.prepast_finish
          ? Math.max(0, selisihMenit(new Date(b.prepast_finish), akhirRentang))
          : null,
        standingSiloMenit: silo.get(Number(b.silo_id))?.standing_time_menit,
        standingSiloSejak: null,
      })) });
      return;
    }
    // Mode real-time: sumber tunggal dipakai bersama tautan publik.
    res.json({ data: await batchAktifLive() });
  }),
);

/**
 * Detail satu silo - FR-11.
 *
 * Yang dikembalikan hanya KEPALA halaman: identitas silo, angka volumenya,
 * tab mana yang berlaku, dan daftar supplier untuk filternya. Riwayat
 * transaksinya TIDAK diambil di sini, melainkan lewat `/data/:modul?siloId=`
 * yang sudah berpaginasi dan berfilter.
 *
 * Itu disengaja. Menyalin kueri riwayat ke sini berarti dua tempat yang harus
 * dijaga tetap serupa, dan halaman Detail Silo di Power Apps rusak justru
 * karena itu: filternya ditulis ulang, lalu salah (B-7).
 */
router.get(
  '/:id',
  wajibWewenang(AKSI.DASHBOARD_LIHAT),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);

    const [baris] = await pool.query(
      `SELECT v.silo_id, v.kode, v.silo_name, v.is_buffer, v.urutan,
              v.vol_aktual_ltr, v.jumlah_batch_aktif,
              v.kapasitas_maks_ltr, v.toleransi_ltr,
              v.kapasitas_dengan_toleransi_ltr, v.vol_tersedia_ltr,
              v.vol_tersedia_toleransi_ltr,
              v.persen_isi, v.dalam_toleransi, v.standing_time_anchor,
              v.monitoring_interval_jam,
              m.last_check_at, m.last_ph, m.last_temp,
              m.menit_sejak_cek, m.status_cek, m.standing_time_menit
         FROM v_silo_volume v
         JOIN v_silo_monitoring_status m ON m.silo_id = v.silo_id
        WHERE v.silo_id = ?`,
      [id],
    );
    const silo = baris[0];
    if (!silo) throw new NotFoundError('Silo');

    // Buffer menerima penerimaan; silo penyimpanan tidak (FR-11.1)
    const tab = silo.is_buffer
      ? ['receiving', 'transfer']
      : ['prepast', 'monitoring', 'transfer', 'pengembalian'];

    // Supplier yang benar-benar pernah masuk silo ini, bukan seluruh master:
    // daftar 31 supplier yang 28 di antaranya tidak pernah menyentuh silo ini
    // membuat filternya lebih lambat dipakai daripada tidak difilter.
    const [suppliers] = await pool.query(
      `SELECT DISTINCT sup.id, sup.supplier_name
         FROM supplier sup
        WHERE EXISTS (SELECT 1 FROM receiving r
                       WHERE r.supplier_id = sup.id AND r.silo_id = ?)
           OR EXISTS (SELECT 1 FROM prepast_record p
                       WHERE p.supplier_id = sup.id AND p.silo_tujuan_id = ?)
        ORDER BY sup.supplier_name`,
      [id, id],
    );

    res.json({ data: silo, tab, suppliers });
  }),
);

export default router;
