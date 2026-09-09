/**
 * Dashboard analitik - FR-27
 *
 * Aplikasi lama hanya menampilkan keadaan SAAT INI: volume, pH terakhir,
 * standing time berjalan. Tidak ada satu pun tampilan yang memperlihatkan tren
 * atau penyimpangan lintas waktu, padahal seluruh datanya sudah tersimpan
 * sejak awal.
 *
 * DUA ATURAN YANG MEMBENTUK BERKAS INI:
 *
 *  FR-27.1.5  Agregasi dihitung di MySQL, bukan di klien. Menarik ribuan baris
 *             ke browser lalu menjumlahkannya di sana adalah persis pola yang
 *             membuat aplikasi lama melambat (M-2), dan pada tablet pabrik
 *             biayanya terasa.
 *
 *  FR-27.1.1  Tiap panel menjawab satu pertanyaan operasional. Pertanyaannya
 *             ditulis di komentar tiap fungsi; panel tanpa pertanyaan tidak
 *             dibuat.
 *
 * Kolom DATETIME menyimpan UTC (A-4), sedangkan "per hari" pada dashboard
 * berarti hari SETEMPAT. Karena itu pengelompokan memakai CONVERT_TZ dengan
 * offset yang dibaca dari jam sistem.
 */

import { pool } from '../db/pool.js';
import { batasTanggal, selisihMenit } from './waktu.js';
import { daftarSesi as daftarSesiPrepast } from './kontinuitasPrepast.js';
import { snapshotSilo } from './snapshotSilo.js';

/** Status yang dianggap nyata. Sama dengan yang dipakai form (D-12). */
const STATUS_NYATA = ['Approved', 'Pending Approval'];
const TANDA_STATUS = STATUS_NYATA.map(() => '?').join(',');

const OPRP_MIN = 81;
const PH_MIN = 6.0;
const PH_MAKS = 7.0;

const angka = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Penyaring tidak langsung untuk panel yang berbasis PENERIMAAN.
 *
 * Penerimaan masuk ke buffer, bukan ke silo penyimpanan (BR-02), jadi
 * "penerimaan silo 3" tidak punya arti langsung. Yang punya arti: penerimaan
 * yang PREPASTNYA masuk ke silo itu. Itulah yang disaring di sini, dan
 * itulah yang ditanyakan orang saat memilih satu silo pada dashboard.
 */
function saringLewatPrepast(r, kolomIdReceiving) {
  if (!adaSilo(r)) return '';
  return `AND EXISTS (
            SELECT 1 FROM prepast_record pp
             WHERE pp.receiving_id = ${kolomIdReceiving}
               AND pp.silo_tujuan_id IN (${tandaSilo(r)})
               AND pp.jenis_batch = 'PREPAST'
          )`;
}

/** Penyaring langsung, untuk panel yang kolomnya memang menyebut silo. */
function saringSilo(r, kolom) {
  return adaSilo(r) ? `AND ${kolom} IN (${tandaSilo(r)})` : '';
}

const nilaiSilo = (r) => (Array.isArray(r.siloIds) ? r.siloIds : []);
const adaSilo = (r) => nilaiSilo(r).length > 0;
const tandaSilo = (r) => nilaiSilo(r).map(() => '?').join(', ');

/**
 * Label hari sebagai TEKS 'YYYY-MM-DD', bukan kolom DATE.
 *
 * Driver mysql2 mengubah kolom DATE menjadi objek Date JavaScript, dan objek
 * itu kemudian tampil sebagai "Mon Aug 10 2026 07:00:00 GMT+0700" begitu
 * dijadikan teks untuk label sumbu. Memformatnya di SQL membuat yang keluar
 * memang teks tanggal, tanpa bergantung pada perilaku driver.
 */
const HARI = (kolom) => `DATE_FORMAT(CONVERT_TZ(${kolom}, '+00:00', ?), '%Y-%m-%d')`;

/** Rentang setempat, beserta rentang pembanding sepanjang yang sama. */
export function rentang(dari, sampai, siloIds = []) {
  const mulai = batasTanggal(dari, 'mulai');
  const akhir = batasTanggal(sampai ?? dari, 'akhir');
  const panjangMs = akhir.getTime() - mulai.getTime();
  const daftarSilo = [...new Set(
    (Array.isArray(siloIds) ? siloIds : [siloIds])
      .filter((id) => id !== null && id !== undefined && id !== '')
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
  )];

  return {
    mulai,
    akhir,
    // Bentuk ISO disimpan apa adanya: berkas export dan judul panel perlu
    // menyebut periode sebagaimana pengguna memilihnya, bukan hasil
    // pembacaan ulang objek Date.
    dariIso: dari,
    sampaiIso: sampai ?? dari,
    /**
     * Penyaring silo, boleh kosong.
     *
     * Tidak semua panel dapat disaring per silo, dan itu bukan kelalaian.
     * Penerimaan masuk ke BUFFER, bukan ke silo penyimpanan (BR-02), jadi
     * "penerimaan silo 3" tidak punya arti langsung. Panel semacam itu
     * disaring lewat jalur tidak langsung - penerimaan yang PREPASTNYA
     * masuk ke silo terpilih - dan yang benar-benar tidak dapat disaring
     * menyatakan dirinya lewat `berlakuSiloFilter: false` supaya
     * antarmukanya dapat berterus terang, bukan menampilkan angka seluruh
     * pabrik seolah-olah itu angka satu silo.
     */
    siloIds: daftarSilo,
    // Dipertahankan untuk konsumen lama yang hanya membaca satu pilihan.
    siloId: daftarSilo.length === 1 ? daftarSilo[0] : null,
    // Pembanding: periode sepanjang yang sama, tepat sebelum periode ini.
    // Delta terhadap "bulan lalu" yang panjangnya berbeda akan menyesatkan.
    bandingMulai: new Date(mulai.getTime() - panjangMs - 1),
    bandingAkhir: new Date(mulai.getTime() - 1),
    // PRD v7 menetapkan filter dan pengelompokan hari secara eksplisit dalam
    // WIB. Jangan mengambil offset mesin: Vercel berjalan dalam UTC.
    tz: '+07:00',
  };
}

/**
 * Baris ringkasan - FR-27.2.
 *
 * Menjawab: berapa masuk, berapa terpakai, berapa tersimpan, seberapa penuh
 * pabrik, dan bagaimana mutu susu masuknya.
 */
export async function ringkasan(r) {
  const jumlahkan = async (mulai, akhir) => {
    /**
     * Bila satu silo dipilih, "masuk" berarti PREPAST yang mengisinya, bukan
     * penerimaan: penerimaan masuk ke buffer (BR-02), dan menyebutnya sebagai
     * penerimaan silo akan mengklaim sesuatu yang tidak terjadi.
     */
    const [masuk] = adaSilo(r)
      ? await pool.query(
        `SELECT COALESCE(SUM(p.vol_prepast_ltr), 0) AS ltr,
                COUNT(*) AS jumlah,
                AVG(NULLIF(rc.nilai_ts, 0)) AS rata_ts
           FROM prepast_record p
           /* LEFT JOIN, bukan INNER. Tidak semua prepast punya batch
              penerimaan induk: prepast anak hasil pindah silo dan baris
              penyiapan awal memiliki receiving_id kosong. INNER JOIN
              membuangnya diam-diam, dan volumenya hilang dari angka silo -
              SILO3 sempat terbaca 0 L padahal berisi 6.000 L. TS-nya memang
              tidak diketahui untuk baris itu, dan AVG mengabaikan NULL. */
           LEFT JOIN receiving rc ON rc.id = p.receiving_id
          WHERE p.prepast_finish BETWEEN ? AND ?
            AND p.silo_tujuan_id IN (${tandaSilo(r)})
            AND p.jenis_batch = 'PREPAST'
            AND p.status_approval IN (${TANDA_STATUS})`,
        [mulai, akhir, ...nilaiSilo(r), ...STATUS_NYATA],
      )
      : await pool.query(
        `SELECT COALESCE(SUM(qty_ltr), 0) AS ltr,
                COUNT(*) AS jumlah,
                AVG(NULLIF(nilai_ts, 0)) AS rata_ts
           FROM receiving
          WHERE finish_time BETWEEN ? AND ?
            AND status_approval IN (${TANDA_STATUS})`,
        [mulai, akhir, ...STATUS_NYATA],
      );

    const [keluar] = await pool.query(
      `SELECT COALESCE(SUM(vol_ltr), 0) AS ltr, COUNT(*) AS jumlah
         FROM transfer
        WHERE trf_time BETWEEN ? AND ?
          AND transfer_type = 'PEMAKAIAN PRODUKSI'
          AND status_approval IN (${TANDA_STATUS})
          ${saringSilo(r, 'silo_asal_id')}`,
      [mulai, akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
    );
    return {
      masukLtr: angka(masuk[0].ltr),
      jumlahPenerimaan: Number(masuk[0].jumlah),
      rataTs: angka(masuk[0].rata_ts),
      keluarLtr: angka(keluar[0].ltr),
      jumlahTransfer: Number(keluar[0].jumlah),
    };
  };

  const kini = await jumlahkan(r.mulai, r.akhir);
  const banding = await jumlahkan(r.bandingMulai, r.bandingAkhir);

  // Saldo dan utilisasi adalah keadaan SEKARANG, bukan agregat periode:
  // "berapa yang masih tersimpan" tidak punya arti untuk rentang masa lalu.
  const [silo] = await pool.query(
    `SELECT COALESCE(SUM(vol_aktual_ltr), 0) AS terisi,
            COALESCE(SUM(kapasitas_maks_ltr), 0) AS kapasitas
       FROM v_silo_volume
      WHERE is_buffer = FALSE ${saringSilo(r, 'silo_id')}`,
    nilaiSilo(r),
  );
  const [buffer] = await pool.query(
    'SELECT COALESCE(SUM(vol_aktual_ltr), 0) AS terisi FROM v_silo_volume WHERE is_buffer = TRUE',
  );

  const terisi = angka(silo[0].terisi);
  const kapasitas = angka(silo[0].kapasitas);

  // Sparkline: deret harian penerimaan sepanjang periode
  const [deret] = adaSilo(r)
    ? await pool.query(
      `SELECT ${HARI('prepast_finish')} AS hari,
              COALESCE(SUM(vol_prepast_ltr), 0) AS ltr
         FROM prepast_record
        WHERE prepast_finish BETWEEN ? AND ?
          AND silo_tujuan_id IN (${tandaSilo(r)})
          AND jenis_batch = 'PREPAST'
          AND status_approval IN (${TANDA_STATUS})
        GROUP BY hari ORDER BY hari`,
      [r.tz, r.mulai, r.akhir, ...nilaiSilo(r), ...STATUS_NYATA],
    )
    : await pool.query(
      `SELECT ${HARI('finish_time')} AS hari,
              COALESCE(SUM(qty_ltr), 0) AS ltr
         FROM receiving
        WHERE finish_time BETWEEN ? AND ?
          AND status_approval IN (${TANDA_STATUS})
        GROUP BY hari ORDER BY hari`,
      [r.tz, r.mulai, r.akhir, ...STATUS_NYATA],
    );

  const delta = (kiniNilai, bandingNilai) => {
    if (bandingNilai === null || bandingNilai === 0) return null;
    return ((kiniNilai - bandingNilai) / bandingNilai) * 100;
  };

  return {
    // Label ikut berubah supaya angkanya tidak salah dibaca
    labelMasuk: adaSilo(r) ? 'Prepast masuk' : 'Penerimaan periode',
    labelKeluar: adaSilo(r) ? 'Transfer keluar silo' : 'Pemakaian produksi',
    penerimaan: {
      ltr: kini.masukLtr,
      jumlah: kini.jumlahPenerimaan,
      deltaPersen: delta(kini.masukLtr, banding.masukLtr),
      sparkline: deret.map((d) => ({ hari: d.hari, ltr: angka(d.ltr) })),
    },
    pemakaian: {
      ltr: kini.keluarLtr,
      jumlah: kini.jumlahTransfer,
      deltaPersen: delta(kini.keluarLtr, banding.keluarLtr),
    },
    saldo: { siloLtr: terisi, bufferLtr: angka(buffer[0].terisi) },
    utilisasi: {
      persen: kapasitas > 0 ? (terisi / kapasitas) * 100 : 0,
      terisiLtr: terisi,
      kapasitasLtr: kapasitas,
    },
    mutu: {
      rataTs: kini.rataTs,
      deltaPersen: delta(kini.rataTs, banding.rataTs),
    },
  };
}

/**
 * Panel perhatian - FR-27.3.
 *
 * Bagian paling berguna dari dashboard, dan yang paling tidak ada di aplikasi
 * lama. Panel yang kosong TIDAK disembunyikan (FR-27.3.8): ketiadaan
 * peringatan adalah informasi, dan panel yang hilang saat bersih membuat
 * pembacanya tidak tahu apakah pemeriksaannya berjalan.
 */
export async function perhatian(r = { siloIds: [] }) {
  // Lewat jadwal cek - ambangnya kolom per silo (BR-10, memperbaiki B-19)
  const [lewatJadwal] = await pool.query(
    `SELECT silo_id, kode, silo_name, monitoring_interval_jam,
            last_check_at, menit_sejak_cek, status_cek
       FROM v_silo_monitoring_status
      WHERE BINARY status_cek = BINARY 'PERLU_DICEK' ${saringSilo(r, 'silo_id')}
      ORDER BY menit_sejak_cek DESC`,
    nilaiSilo(r),
  );

  const [standingTime] = await pool.query(
    `SELECT m.silo_id, m.kode, m.silo_name, m.standing_time_menit,
            v.vol_aktual_ltr
       FROM v_silo_monitoring_status m
       JOIN v_silo_volume v ON v.silo_id = m.silo_id
      WHERE m.standing_time_menit IS NOT NULL AND v.vol_aktual_ltr > 0
        ${saringSilo(r, 'm.silo_id')}
      ORDER BY m.standing_time_menit DESC`,
    nilaiSilo(r),
  );

  // Penyimpangan OPRP - titik kendali keamanan pangan, ambang dari catatan
  // kaki form (bukan angka hafalan)
  const [oprp] = await pool.query(
    `SELECT p.id, p.kode, p.temp_after_heater, p.prepast_finish,
            s.silo_name, o.nama_lengkap AS operator_nama
       FROM prepast_record p
       JOIN silo s     ON s.id = p.silo_tujuan_id
       JOIN operator o ON o.id = p.operator_id
      WHERE p.temp_after_heater IS NOT NULL AND p.temp_after_heater < ?
        AND p.status_approval IN (${TANDA_STATUS})
        ${saringSilo(r, 'p.silo_tujuan_id')}
      ORDER BY p.prepast_finish DESC
      LIMIT 50`,
    [OPRP_MIN, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  const [ph] = await pool.query(
    `SELECT m.id, m.kode, m.ph_check, m.temp_check, m.time_check, s.silo_name
       FROM monitoring m
       JOIN silo s ON s.id = m.silo_id
      WHERE (m.ph_check < ? OR m.ph_check > ?)
        AND m.status_approval IN (${TANDA_STATUS})
        ${saringSilo(r, 'm.silo_id')}
      ORDER BY m.time_check DESC
      LIMIT 50`,
    [PH_MIN, PH_MAKS, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  // Draft belum lengkap (BR-23) - tidak dapat disetujui sampai dilengkapi
  const [draft] = await pool.query(
    `SELECT 'prepast' AS modul, p.id, p.kode, p.created_at
       FROM prepast_record p WHERE p.is_gantung = TRUE
      UNION ALL
     SELECT 'transfer', t.id, t.kode, t.created_at
       FROM transfer t WHERE t.is_gantung = TRUE
      ORDER BY created_at`,
  );

  const [antrean] = await pool.query(
    `SELECT modul, COUNT(*) AS jumlah,
            MAX(TIMESTAMPDIFF(HOUR, dibuat, UTC_TIMESTAMP())) AS usia_tertua_jam
       FROM (
         SELECT 'receiving' AS modul, created_at AS dibuat FROM receiving
          WHERE status_approval = 'Pending Approval'
         UNION ALL
         SELECT 'prepast', created_at FROM prepast_record
          WHERE status_approval = 'Pending Approval'
         UNION ALL
         SELECT 'transfer', created_at FROM transfer
          WHERE status_approval = 'Pending Approval'
         UNION ALL
         SELECT 'monitoring', created_at FROM monitoring
          WHERE status_approval = 'Pending Approval'
       ) q
      GROUP BY modul ORDER BY jumlah DESC`,
  );

  return {
    lewatJadwal: lewatJadwal.map((s) => ({
      siloId: s.silo_id,
      siloName: s.silo_name,
      intervalJam: Number(s.monitoring_interval_jam),
      menitSejakCek: angka(s.menit_sejak_cek),
      cekTerakhir: s.last_check_at,
    })),
    standingTime: standingTime.map((s) => ({
      siloId: s.silo_id,
      siloName: s.silo_name,
      menit: Number(s.standing_time_menit),
      volumeLtr: angka(s.vol_aktual_ltr),
    })),
    oprp: oprp.map((p) => ({
      modul: 'prepast',
      id: p.id,
      kode: p.kode,
      siloName: p.silo_name,
      tempAfterHeater: angka(p.temp_after_heater),
      ambang: OPRP_MIN,
      waktu: p.prepast_finish,
      operator: p.operator_nama,
    })),
    ph: ph.map((m) => ({
      modul: 'monitoring',
      id: m.id,
      kode: m.kode,
      siloName: m.silo_name,
      ph: angka(m.ph_check),
      suhu: angka(m.temp_check),
      waktu: m.time_check,
      rentangAman: { min: PH_MIN, maks: PH_MAKS },
    })),
    draft: draft.map((d) => ({
      modul: d.modul, id: d.id, kode: d.kode, dibuat: d.created_at,
    })),
    antrean: antrean.map((a) => ({
      modul: a.modul,
      jumlah: Number(a.jumlah),
      usiaTertuaJam: angka(a.usia_tertua_jam),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Grafik - FR-27.4                                                    */
/* ------------------------------------------------------------------ */

/** FR-27.4.1 - "Apakah pemakaian mengimbangi penerimaan?" */
async function neracaHarian(r) {
  if (adaSilo(r)) {
    // Saat silo disaring, "masuk" berarti prepast yang mengisinya dan
    // "keluar" berarti transfer yang mengambil darinya. Memakai penerimaan
    // di sini akan mencampur angka buffer ke dalam neraca silo terpilih.
    const [barisSilo] = await pool.query(
      `SELECT hari,
              COALESCE(SUM(masuk), 0) AS masuk,
              COALESCE(SUM(keluar), 0) AS keluar
         FROM (
           SELECT ${HARI('prepast_finish')} AS hari, vol_prepast_ltr AS masuk, 0 AS keluar
             FROM prepast_record
            WHERE prepast_finish BETWEEN ? AND ?
              AND silo_tujuan_id IN (${tandaSilo(r)})
              AND status_approval IN (${TANDA_STATUS})
           UNION ALL
           SELECT ${HARI('trf_time')}, 0, vol_ltr
             FROM transfer
            WHERE trf_time BETWEEN ? AND ?
              AND silo_asal_id IN (${tandaSilo(r)})
              AND transfer_type = 'PEMAKAIAN PRODUKSI'
              AND status_approval IN (${TANDA_STATUS})
         ) q
        GROUP BY hari ORDER BY hari`,
      [r.tz, r.mulai, r.akhir, ...nilaiSilo(r), ...STATUS_NYATA,
        r.tz, r.mulai, r.akhir, ...nilaiSilo(r), ...STATUS_NYATA],
    );

    return {
      jenis: 'garis',
      satuan: 'L',
      seri: [
        { kunci: 'masuk', label: 'Prepast masuk' },
        { kunci: 'keluar', label: 'Transfer keluar' },
      ],
      data: barisSilo.map((b) => ({
        label: b.hari, masuk: angka(b.masuk), keluar: angka(b.keluar),
      })),
    };
  }

  const [baris] = await pool.query(
    `SELECT hari,
            COALESCE(SUM(masuk), 0) AS masuk,
            COALESCE(SUM(keluar), 0) AS keluar
       FROM (
         SELECT ${HARI('finish_time')} AS hari,
                qty_ltr AS masuk, 0 AS keluar
           FROM receiving
          WHERE finish_time BETWEEN ? AND ? AND status_approval IN (${TANDA_STATUS})
         UNION ALL
         SELECT ${HARI('trf_time')}, 0, vol_ltr
           FROM transfer
          WHERE trf_time BETWEEN ? AND ? AND transfer_type = 'PEMAKAIAN PRODUKSI'
            AND status_approval IN (${TANDA_STATUS})
       ) q
      GROUP BY hari ORDER BY hari`,
    [r.tz, r.mulai, r.akhir, ...STATUS_NYATA, r.tz, r.mulai, r.akhir, ...STATUS_NYATA],
  );

  return {
    jenis: 'garis',
    satuan: 'L',
    seri: [
      { kunci: 'masuk', label: 'Penerimaan' },
      { kunci: 'keluar', label: 'Pemakaian produksi' },
    ],
    data: baris.map((b) => ({
      label: b.hari,
      masuk: angka(b.masuk),
      keluar: angka(b.keluar),
    })),
  };
}

/** FR-27.4.2 - "Kapan truk menumpuk?" */
async function polaJam(r) {
  const [baris] = await pool.query(
    `SELECT DAYOFWEEK(CONVERT_TZ(r.finish_time, '+00:00', ?)) AS hari,
            HOUR(CONVERT_TZ(r.finish_time, '+00:00', ?)) AS jam,
            COUNT(*) AS jumlah, COALESCE(SUM(r.qty_ltr), 0) AS ltr
       FROM receiving r
      WHERE r.finish_time BETWEEN ? AND ? AND r.status_approval IN (${TANDA_STATUS})
        ${saringLewatPrepast(r, 'r.id')}
      GROUP BY hari, jam`,
    [r.tz, r.tz, r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  return {
    jenis: 'heatmap',
    // DAYOFWEEK MySQL: 1 = Minggu
    hari: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'],
    data: baris.map((b) => ({
      hariIndeks: Number(b.hari) - 1,
      jam: Number(b.jam),
      jumlah: Number(b.jumlah),
      ltr: angka(b.ltr),
    })),
  };
}

/** FR-27.4.3 - "Silo mana yang paling sibuk?" */
async function aktivitasSilo(r) {
  const [baris] = await pool.query(
    `SELECT s.id, s.silo_name,
            COALESCE(SUM(q.masuk), 0) AS masuk,
            COALESCE(SUM(q.keluar), 0) AS keluar
       FROM silo s
       LEFT JOIN (
         SELECT silo_tujuan_id AS silo_id, vol_prepast_ltr AS masuk, 0 AS keluar
           FROM prepast_record
          WHERE prepast_finish BETWEEN ? AND ? AND jenis_batch = 'PREPAST'
            AND status_approval IN (${TANDA_STATUS})
         UNION ALL
         SELECT silo_asal_id, 0, vol_ltr
           FROM transfer
          WHERE trf_time BETWEEN ? AND ? AND transfer_type = 'PEMAKAIAN PRODUKSI'
            AND status_approval IN (${TANDA_STATUS})
       ) q ON q.silo_id = s.id
      WHERE s.is_buffer = FALSE AND s.is_active = TRUE
        ${saringSilo(r, 's.id')}
      GROUP BY s.id, s.silo_name, s.urutan
      ORDER BY s.urutan`,
    [r.mulai, r.akhir, ...STATUS_NYATA, r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  return {
    jenis: 'batangBertumpuk',
    satuan: 'L',
    seri: [
      { kunci: 'masuk', label: 'Prepast masuk' },
      { kunci: 'keluar', label: 'Transfer keluar' },
    ],
    data: baris.map((b) => ({
      label: b.silo_name,
      masuk: angka(b.masuk),
      keluar: angka(b.keluar),
    })),
  };
}

/** Deret waktu per silo, dipakai grafik suhu dan pH. */
async function deretMonitoring(r, kolom, satuan, pita) {
  const [baris] = await pool.query(
    `SELECT s.silo_name, m.time_check, m.\`${kolom}\` AS nilai
       FROM monitoring m
       JOIN silo s ON s.id = m.silo_id
      WHERE m.time_check BETWEEN ? AND ?
        AND m.\`${kolom}\` IS NOT NULL
        AND m.status_approval IN (${TANDA_STATUS})
        ${saringSilo(r, 'm.silo_id')}
      ORDER BY m.time_check`,
    [r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  const perSilo = new Map();
  for (const b of baris) {
    const daftar = perSilo.get(b.silo_name) ?? [];
    daftar.push({ waktu: b.time_check, nilai: angka(b.nilai) });
    perSilo.set(b.silo_name, daftar);
  }

  return {
    jenis: 'garisWaktu',
    satuan,
    pita,
    seri: [...perSilo.entries()].map(([label, titik]) => ({ kunci: label, label, titik })),
  };
}

/** FR-27.4.4 - "Adakah silo yang menghangat?" */
const suhuSilo = (r) => deretMonitoring(r, 'temp_check', 'C', { min: 2, maks: 6 });

/** FR-27.4.5 - "Adakah tanda pengasaman?" Skala berbeda, jadi grafik terpisah (FR-27.5.1). */
const phSilo = (r) => deretMonitoring(r, 'ph_check', '', { min: PH_MIN, maks: PH_MAKS });

/** Deret prepast, dipakai grafik OPRP dan temp output. */
async function deretPrepast(r, kolom, satuan, ambang, pita) {
  const [baris] = await pool.query(
    `SELECT p.id, p.kode, p.prepast_finish, p.\`${kolom}\` AS nilai, s.silo_name
       FROM prepast_record p
       JOIN silo s ON s.id = p.silo_tujuan_id
      WHERE p.prepast_finish BETWEEN ? AND ?
        AND p.\`${kolom}\` IS NOT NULL
        AND p.jenis_batch = 'PREPAST'
        AND p.status_approval IN (${TANDA_STATUS})
        ${saringSilo(r, 'p.silo_tujuan_id')}
      ORDER BY p.prepast_finish`,
    [r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  return {
    jenis: 'garisWaktu',
    satuan,
    ambang,
    pita,
    seri: [{
      kunci: kolom,
      label: satuan === 'C' && ambang ? `Temp After Heater` : 'Nilai',
      titik: baris.map((b) => ({
        waktu: b.prepast_finish,
        nilai: angka(b.nilai),
        kode: b.kode,
        siloName: b.silo_name,
        kritis: ambang !== undefined && angka(b.nilai) < ambang,
      })),
    }],
  };
}

/** FR-27.4.6 - "Adakah pelanggaran OPRP?" */
const oprpGrafik = (r) => deretPrepast(r, 'temp_after_heater', 'C', OPRP_MIN);

/** FR-27.4.7 - "Apakah pendinginan konsisten?" Rentangnya jauh berbeda dari OPRP. */
const tempOutputGrafik = (r) => deretPrepast(r, 'temp_output_prd', 'C', undefined, { min: 2, maks: 6 });

/** FR-27.4.8 - "Supplier mana yang mutunya di bawah?" */
async function tsSupplier(r) {
  const [baris] = await pool.query(
    `SELECT sup.supplier_name, AVG(r.nilai_ts) AS rata_ts, COUNT(*) AS jumlah
       FROM receiving r
       JOIN supplier sup ON sup.id = r.supplier_id
      WHERE r.finish_time BETWEEN ? AND ?
        AND r.nilai_ts IS NOT NULL AND r.nilai_ts > 0
        AND r.status_approval IN (${TANDA_STATUS})
        ${saringLewatPrepast(r, 'r.id')}
      GROUP BY sup.id, sup.supplier_name
      ORDER BY rata_ts ASC`,
    [r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  const nilai = baris.map((b) => angka(b.rata_ts));
  const rata = nilai.length ? nilai.reduce((s, v) => s + v, 0) / nilai.length : null;

  return {
    jenis: 'batang',
    satuan: '% TS',
    penanda: rata === null ? null : { label: 'Rata-rata', nilai: rata },
    data: baris.map((b) => ({
      label: b.supplier_name,
      nilai: angka(b.rata_ts),
      jumlah: Number(b.jumlah),
    })),
  };
}

/** FR-27.4.9 - "Siapa pemasok terbesar?" Delapan teratas, sisanya dilipat (FR-27.5.3). */
async function volumeSupplier(r) {
  const [baris] = await pool.query(
    `SELECT sup.supplier_name, COALESCE(SUM(r.qty_ltr), 0) AS ltr, COUNT(*) AS jumlah
       FROM receiving r
       JOIN supplier sup ON sup.id = r.supplier_id
      WHERE r.finish_time BETWEEN ? AND ? AND r.status_approval IN (${TANDA_STATUS})
        ${saringLewatPrepast(r, 'r.id')}
      GROUP BY sup.id, sup.supplier_name
      ORDER BY ltr DESC`,
    [r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  const BATAS = 8;
  const teratas = baris.slice(0, BATAS).map((b) => ({
    label: b.supplier_name, nilai: angka(b.ltr), jumlah: Number(b.jumlah),
  }));
  const sisa = baris.slice(BATAS);

  if (sisa.length > 0) {
    teratas.push({
      label: `Lainnya (${sisa.length} supplier)`,
      nilai: sisa.reduce((s, b) => s + angka(b.ltr), 0),
      jumlah: sisa.reduce((s, b) => s + Number(b.jumlah), 0),
      lipatan: true,
    });
  }

  return { jenis: 'batang', satuan: 'L', data: teratas };
}

/** FR-27.4.10 - "Berapa lama susu berdiri?" */
async function standingTimeGrafik(r) {
  /*
   * Standing time dihitung sampai AKHIR RENTANG, bukan sampai jam sekarang.
   *
   * Sebelumnya panel ini membaca view live (v_silo_monitoring_status) yang
   * selalu mengukur jangkar sampai UTC_TIMESTAMP. Akibatnya memilih rentang
   * bulan lalu tetap menampilkan standing time hari ini, dan volumenya pun
   * volume sekarang. `snapshotSilo(r.akhir)` merekonstruksi keadaan tiap silo
   * pada akhir rentang - jangkar, volume, dan standing time - persis seperti
   * yang dipakai dashboard mode historis, jadi keduanya satu kamus.
   */
  const snap = await snapshotSilo(r.akhir);
  const dipilih = new Set(r.siloIds.map(Number));

  let baris = snap.silos.filter(
    (s) => !s.is_buffer && Number(s.vol_aktual_ltr) > 0,
  );
  if (dipilih.size > 0) {
    baris = baris.filter((s) => dipilih.has(Number(s.silo_id)));
  }
  baris.sort((a, b) => (b.standing_time_menit ?? 0) - (a.standing_time_menit ?? 0));

  return {
    jenis: 'batang',
    satuan: 'jam',
    // Zona ambang: di atas 24 jam pantas diperhatikan, di atas 48 jam serius
    zona: [
      { sampai: 24, nada: 'baik' },
      { sampai: 48, nada: 'waspada' },
      { sampai: null, nada: 'kritis' },
    ],
    data: baris.map((b) => ({
      label: b.silo_name,
      nilai: b.standing_time_menit === null ? 0 : Number(b.standing_time_menit) / 60,
      volumeLtr: Number(b.vol_aktual_ltr),
    })),
  };
}

/** FR-27.4.11 - "Ke mana susu mengalir?" */
async function tujuanTransfer(r) {
  const [baris] = await pool.query(
    `SELECT ${HARI('t.trf_time')} AS hari,
            CASE
              WHEN t.transfer_type = 'PINDAH SILO' THEN 'Pindah silo'
              WHEN t.cmd_destination = 'CMD2' THEN 'CMD2'
              ELSE 'CMD1'
            END AS tujuan,
            COALESCE(SUM(t.vol_ltr), 0) AS ltr
       FROM transfer t
      WHERE t.trf_time BETWEEN ? AND ? AND t.status_approval IN (${TANDA_STATUS})
        ${saringSilo(r, 't.silo_asal_id')}
      GROUP BY hari, tujuan
      ORDER BY hari`,
    [r.tz, r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  const hari = [...new Set(baris.map((b) => String(b.hari)))];
  const data = hari.map((h) => {
    const isi = { label: h, CMD1: 0, CMD2: 0, 'Pindah silo': 0 };
    for (const b of baris.filter((x) => String(x.hari) === h)) {
      isi[b.tujuan] = angka(b.ltr);
    }
    return isi;
  });

  return {
    jenis: 'batangBertumpuk',
    satuan: 'L',
    seri: [
      { kunci: 'CMD1', label: 'CMD1' },
      { kunci: 'CMD2', label: 'CMD2' },
      { kunci: 'Pindah silo', label: 'Pindah silo' },
    ],
    data,
  };
}

/** FR-27.4.12 - "Adakah kemacetan persetujuan?" */
async function waktuTungguApproval() {
  const [baris] = await pool.query(
    `SELECT modul,
            COUNT(*) AS jumlah,
            AVG(TIMESTAMPDIFF(HOUR, dibuat, UTC_TIMESTAMP())) AS rata_jam,
            MAX(TIMESTAMPDIFF(HOUR, dibuat, UTC_TIMESTAMP())) AS maks_jam
       FROM (
         SELECT 'Penerimaan' AS modul, created_at AS dibuat FROM receiving
          WHERE status_approval = 'Pending Approval'
         UNION ALL
         SELECT 'Prepast', created_at FROM prepast_record
          WHERE status_approval = 'Pending Approval'
         UNION ALL
         SELECT 'Transfer', created_at FROM transfer
          WHERE status_approval = 'Pending Approval'
         UNION ALL
         SELECT 'Monitoring', created_at FROM monitoring
          WHERE status_approval = 'Pending Approval'
       ) q
      GROUP BY modul ORDER BY rata_jam DESC`,
  );

  return {
    jenis: 'batang',
    satuan: 'jam',
    data: baris.map((b) => ({
      label: b.modul,
      nilai: angka(b.rata_jam) ?? 0,
      jumlah: Number(b.jumlah),
      maksJam: angka(b.maks_jam),
    })),
  };
}

/**
 * Frekuensi record: berapa KALI, bukan berapa liter - FR-27.
 *
 * Seluruh grafik lain di halaman ini mengukur VOLUME. Yang tidak terjawab
 * olehnya adalah beban kerja: dua puluh penerimaan kecil dan dua penerimaan
 * besar dapat berjumlah liter yang sama, tetapi yang pertama berarti dua puluh
 * kali penimbangan, dua puluh kali input, dan dua puluh kali persetujuan.
 *
 * Pindah silo dipisahkan dari pemakaian produksi. Keduanya baris `transfer`,
 * tetapi pindah silo tidak mengurangi stok pabrik - ia hanya memindahkannya -
 * sehingga menggabungkan keduanya membuat hari dengan banyak pemindahan
 * internal terlihat seperti hari dengan banyak pengeluaran.
 */
async function frekuensiRecord(r) {
  const sesiPrepast = await daftarSesiPrepast(r);
  const [rcv] = await pool.query(
    `SELECT ${HARI('r.finish_time')} AS hari, COUNT(*) AS n
      FROM receiving r
      WHERE r.finish_time BETWEEN ? AND ? AND r.status_approval IN (${TANDA_STATUS})
        ${saringLewatPrepast(r, 'r.id')}
      GROUP BY hari
      ORDER BY hari`,
    [r.tz, r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  const [trf] = await pool.query(
    `SELECT ${HARI('t.trf_time')} AS hari,
            CASE WHEN t.transfer_type = 'PINDAH SILO' THEN 'pindah' ELSE 'produksi' END AS jenis,
            COUNT(*) AS n
       FROM transfer t
      WHERE t.trf_time BETWEEN ? AND ? AND t.status_approval IN (${TANDA_STATUS})
        ${saringSilo(r, 't.silo_asal_id')}
      GROUP BY hari, jenis
      ORDER BY hari`,
    [r.tz, r.mulai, r.akhir, ...STATUS_NYATA, ...nilaiSilo(r)],
  );

  /*
   * Hari dikumpulkan dari KEDUA kueri.
   *
   * Hari yang hanya berisi penerimaan tanpa transfer - atau sebaliknya - tetap
   * harus muncul. Mengambil daftar hari dari salah satu saja akan menghilangkan
   * hari itu dari grafik, dan yang terbaca adalah "tidak ada aktivitas".
   */
  const formatHariWib = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const hariWib = (nilai) => {
    const bagian = Object.fromEntries(
      formatHariWib.formatToParts(new Date(nilai)).map((p) => [p.type, p.value]),
    );
    return `${bagian.year}-${bagian.month}-${bagian.day}`;
  };
  const prepastPerHari = new Map();
  for (const sesi of sesiPrepast) {
    const h = hariWib(sesi.start);
    const nilai = prepastPerHari.get(h) ?? { jumlah: 0, volumeLtr: 0 };
    nilai.jumlah += 1;
    nilai.volumeLtr += sesi.volumeLtr;
    prepastPerHari.set(h, nilai);
  }

  const hari = [...new Set([
    ...rcv.map((b) => String(b.hari)),
    ...trf.map((b) => String(b.hari)),
    ...prepastPerHari.keys(),
  ])].sort();

  const data = hari.map((h) => {
    const t1 = trf.find((x) => String(x.hari) === h && x.jenis === 'produksi');
    const t2 = trf.find((x) => String(x.hari) === h && x.jenis === 'pindah');
    return {
      label: h,
      Penerimaan: angka(rcv.find((x) => String(x.hari) === h)?.n ?? 0),
      'Transfer produksi': angka(t1?.n ?? 0),
      'Pindah silo': angka(t2?.n ?? 0),
      Prepast: prepastPerHari.get(h)?.jumlah ?? 0,
      volumePrepastLtr: prepastPerHari.get(h)?.volumeLtr ?? 0,
    };
  });

  return {
    jenis: 'batangBertumpuk',
    satuan: 'record',
    seri: [
      { kunci: 'Penerimaan', label: 'Penerimaan' },
      { kunci: 'Transfer produksi', label: 'Transfer produksi' },
      { kunci: 'Pindah silo', label: 'Pindah silo' },
      { kunci: 'Prepast', label: 'Total Prepast' },
    ],
    data,
    sesiPrepast,
  };
}

/** Katalog grafik beserta pertanyaan yang dijawabnya - FR-27.1.1. */
export const GRAFIK = Object.freeze({
  'neraca-harian': {
    judul: 'Neraca harian',
    pertanyaan: 'Apakah pemakaian mengimbangi penerimaan?',
    ambil: neracaHarian,
  },
  'frekuensi-record': {
    judul: 'Frekuensi Proses',
    pertanyaan: 'Berapa kali proses aktual per hari, termasuk sesi Prepast kontinu dan tidak kontinu?',
    ambil: frekuensiRecord,
  },
  'pola-jam': {
    judul: 'Pola jam kedatangan',
    pertanyaan: 'Kapan truk menumpuk?',
    ambil: polaJam,
  },
  'aktivitas-silo': {
    judul: 'Aktivitas per silo',
    pertanyaan: 'Silo mana yang paling sibuk?',
    ambil: aktivitasSilo,
  },
  'suhu-silo': {
    judul: 'Suhu simpan per silo',
    pertanyaan: 'Adakah silo yang menghangat?',
    ambil: suhuSilo,
  },
  'ph-silo': {
    judul: 'pH per silo',
    pertanyaan: 'Adakah tanda pengasaman?',
    ambil: phSilo,
  },
  oprp: {
    judul: 'Temp After Heater (OPRP)',
    pertanyaan: 'Adakah pelanggaran OPRP?',
    ambil: oprpGrafik,
  },
  'temp-output': {
    judul: 'Temp Output Produk',
    pertanyaan: 'Apakah pendinginan konsisten?',
    ambil: tempOutputGrafik,
  },
  'ts-supplier': {
    judul: 'TS per supplier',
    pertanyaan: 'Supplier mana yang mutunya di bawah?',
    ambil: tsSupplier,
  },
  'volume-supplier': {
    judul: 'Volume per supplier',
    pertanyaan: 'Siapa pemasok terbesar?',
    ambil: volumeSupplier,
  },
  'standing-time': {
    judul: 'Sebaran standing time',
    pertanyaan: 'Berapa lama susu berdiri?',
    ambil: standingTimeGrafik,
  },
  'tujuan-transfer': {
    judul: 'Tujuan transfer',
    pertanyaan: 'Ke mana susu mengalir?',
    ambil: tujuanTransfer,
  },
  'waktu-tunggu-approval': {
    judul: 'Waktu tunggu approval',
    pertanyaan: 'Adakah kemacetan persetujuan?',
    ambil: waktuTungguApproval,
    // Antrean approval milik modul, bukan milik silo. Menampilkannya
    // sebagai angka satu silo akan mengklaim sesuatu yang tidak diukur.
    berlakuSiloFilter: false,
  },
});

export async function grafik(jenis, r) {
  const def = GRAFIK[jenis];
  if (!def) return null;

  const berlaku = def.berlakuSiloFilter !== false;
  // Panel yang tidak dapat disaring dijalankan tanpa penyaringnya, dan
  // berterus terang lewat `siloFilterDiabaikan`. Menampilkan angka seluruh
  // pabrik seolah-olah angka satu silo lebih buruk daripada tidak menyaring.
  const konteks = berlaku ? r : { ...r, siloId: null, siloIds: [] };

  const hasil = await def.ambil(konteks);
  return {
    jenis,
    judul: def.judul,
    pertanyaan: def.pertanyaan,
    siloFilterDiabaikan: adaSilo(r) && !berlaku,
    ...hasil,
  };
}

/** Seluruh grafik sekaligus, supaya dashboard cukup satu permintaan. */
export async function semuaGrafik(r) {
  /*
   * Ketiga belas grafik dijalankan BERSAMAAN, bukan satu per satu.
   *
   * Tiap grafik kuerinya berdiri sendiri - tidak ada yang memakai hasil yang
   * lain - sehingga menjalankannya berurutan hanya menjumlahkan latensinya
   * tanpa alasan. Pada rentang sebulan, serial terukur ~150 ms; paralel
   * membiarkan basis data mengerjakannya serentak dan waktunya turun ke
   * sekitar grafik yang paling lambat saja.
   *
   * Aman terhadap pool 10 koneksi: mysql2 mengantre permintaan yang melebihi
   * batas alih-alih menggagalkannya, jadi yang terjadi paling buruk hanyalah
   * tiga kueri terakhir menunggu giliran - tetap jauh lebih cepat daripada
   * seluruhnya berbaris.
   */
  const nama = Object.keys(GRAFIK);
  const hasilArray = await Promise.all(nama.map((n) => grafik(n, r)));

  const hasil = {};
  nama.forEach((n, i) => { hasil[n] = hasilArray[i]; });
  return hasil;
}

/**
 * Sesi Prepast terstruktur untuk mode "Sesi Prepast" di Analitik - FR-33.
 *
 * Tiap sesi (dikelompokkan per silo oleh kontinuitasPrepast) dibawa dengan DUA
 * daftar terpisah:
 *  - masuk:  prepast yang mengisi silo (Jam = prepast_start, Supplier).
 *  - keluar: transfer yang MENARIK dari batch sesi itu (lewat FIFO allocation),
 *            satu baris per transfer: Volume, Standing Time (prepast_finish ->
 *            trf_time), TS% (tertimbang dari nilai_ts batch sumber), Jam, Kemana.
 *
 * Catatan: TS% memakai nilai_ts susu sumber (yang tersedia), BUKAN TS rilis QC
 * per transfer - kolom itu belum ada di skema transfer.
 */
export async function sesiDetail(r) {
  const sesi = await daftarSesiPrepast(r);
  if (sesi.length === 0) return { sesi: [] };

  const idKeSesi = new Map();
  for (const s of sesi) for (const rec of s.records) idKeSesi.set(Number(rec.id), s.id);
  const idSemua = [...idKeSesi.keys()];

  // sessionId -> Map(transferId -> baris out terakumulasi)
  const outPerSesi = new Map();
  if (idSemua.length) {
    const [baris] = await pool.query(
      `SELECT ta.prepast_id, t.id AS trf_id, t.vol_ltr, t.trf_time,
              COALESCE(tk.tank_name, st.silo_name) AS tujuan,
              ta.qty_allocated, p.nilai_ts, p.prepast_finish
         FROM transfer_allocation ta
         JOIN transfer t ON t.id = ta.transfer_id
         JOIN prepast_record p ON p.id = ta.prepast_id
         LEFT JOIN tank_master tk ON tk.id = t.tank_id
         LEFT JOIN silo st ON st.id = t.silo_tujuan_id
        WHERE ta.prepast_id IN (${idSemua.map(() => '?').join(',')})
          AND t.status_approval IN ('Approved','Pending Approval')`,
      idSemua,
    );
    for (const b of baris) {
      const sesiId = idKeSesi.get(Number(b.prepast_id));
      if (!sesiId) continue;
      if (!outPerSesi.has(sesiId)) outPerSesi.set(sesiId, new Map());
      const perTrf = outPerSesi.get(sesiId);
      const qty = Number(b.qty_allocated);
      const finish = new Date(b.prepast_finish);
      const ada = perTrf.get(b.trf_id);
      if (ada) {
        ada._qty += qty;
        ada._tsxq += qty * Number(b.nilai_ts ?? 0);
        if (finish < ada._finishMin) ada._finishMin = finish;
      } else {
        perTrf.set(b.trf_id, {
          volume: Number(b.vol_ltr),
          jam: b.trf_time,
          kemana: b.tujuan,
          _qty: qty,
          _tsxq: qty * Number(b.nilai_ts ?? 0),
          _finishMin: finish,
        });
      }
    }
  }

  return {
    sesi: sesi.map((s) => ({
      id: s.id,
      siloId: s.siloId,
      siloName: s.siloName,
      start: s.start,
      finish: s.finish,
      volumeLtr: s.volumeLtr,
      jumlahRecord: s.jumlahRecord,
      // FR-33.3.8 - sesi belum punya finish final = masih berjalan.
      sedangBerjalan: !s.finish,
      masuk: s.records.map((rec) => ({ jam: rec.start, supplier: rec.supplierName })),
      keluar: [...(outPerSesi.get(s.id)?.values() ?? [])]
        .sort((a, b) => new Date(a.jam) - new Date(b.jam))
        .map((o) => ({
          volume: o.volume,
          tsPersen: o._qty > 0 ? Number((o._tsxq / o._qty).toFixed(2)) : null,
          standingMenit: Math.max(0, selisihMenit(o._finishMin, new Date(o.jam))),
          jam: o.jam,
          kemana: o.kemana,
        })),
    })),
  };
}
