/**
 * Data List - FR-10
 *
 * Riwayat seluruh modul dalam satu bentuk, berpaginasi.
 *
 * Power Apps memuat seluruh tabel ke memori perangkat lewat `ClearCollect`,
 * sehingga daftar melambat seiring data bertambah dan diam-diam terpotong
 * begitu melewati batas delegasi SharePoint (M-2, FR-10.9).
 *
 * Wewenang edit dan void dihitung DI SERVER, bukan diserahkan ke UI.
 * Nilai yang dikembalikan hanya untuk menyembunyikan tombol; penegakannya
 * tetap di endpoint masing-masing (BR-22, B-22).
 */

import { pool } from '../db/pool.js';
import { can, AKSI } from '../auth/permissions.js';
import { BusinessError } from '../middleware/errors.js';
import { statusKelengkapanPrepast } from './prepastGantung.js';
import { statusKelengkapanReceiving } from './receivingGantung.js';

/**
 * Satu definisi per modul: dari mana barisnya, dan bagaimana meringkasnya.
 *
 * Bentuk keluarannya diseragamkan supaya UI dapat merender satu tabel untuk
 * seluruh modul, alih-alih empat tabel yang harus dijaga tetap serupa.
 */
const MODUL = {
  receiving: {
    sql: `
      SELECT r.id, r.kode, r.qty_ltr AS volume_ltr, r.qty_remaining_ltr,
             r.finish_time AS waktu, r.status_approval, r.status_fifo,
             r.is_gantung, r.rejection_comment,
             CONCAT(sup.supplier_name, ' ke ', s.silo_name) AS ringkasan,
             o.nama_lengkap AS operator_nama, r.operator_id
        FROM receiving r
        JOIN supplier sup ON sup.id = r.supplier_id
        JOIN silo s       ON s.id = r.silo_id
        JOIN operator o   ON o.id = r.operator_id`,
    urut: 'r.finish_time DESC, r.id DESC',
    /* Kolom silo disebut TERSENDIRI, bukan disimpulkan dari klausa
       `siloId` di bawah dengan memotong " = ?". Filter banyak-silo perlu
       membangun `IN (?, ?, ...)` sendiri, dan menyimpulkannya dari untaian
       klausa akan patah tanpa galat begitu bentuk klausanya diubah. */
    kolomSilo: 'r.silo_id',
    kolomStatus: 'r.status_approval',
    filter: {
      status: 'r.status_approval = ?',
      siloId: 'r.silo_id = ?',
      supplierId: 'r.supplier_id = ?',
      draftSaja: 'r.is_gantung = TRUE',
      // Subset draftSaja yang lebih sempit — khusus BJ, dituju kartu Dashboard
      // "Menunggu Berat Jenis" (lihat dashboardLive.kgBelumTerkonversi()).
      bjKosong: 'r.berat_jenis IS NULL',
      // Aktif = masih benar-benar ada di buffer (belum habis diprepast).
      aktifSaja: "(r.status_fifo = 'ACTIVE' AND r.qty_remaining_ltr > 0)",
      dariTanggal: 'r.finish_time >= ?',
      sampaiTanggal: 'r.finish_time <= ?',
      cari: '(r.kode LIKE ? OR sup.supplier_name LIKE ?)',
    },
  },

  prepast: {
    sql: `
      SELECT p.id, p.kode, p.vol_prepast_ltr AS volume_ltr, p.qty_remaining_ltr,
             p.prepast_finish AS waktu, p.status_approval, p.status_fifo,
             p.is_gantung, p.melampaui_kapasitas, p.rejection_comment,
             CONCAT(COALESCE(sup.supplier_name, 'Tidak diketahui'), ' ke ',
                    COALESCE(s.silo_name, 'Belum ditentukan')) AS ringkasan,
             o.nama_lengkap AS operator_nama, p.operator_id
        FROM prepast_record p
        LEFT JOIN supplier sup ON sup.id = p.supplier_id
        LEFT JOIN silo s       ON s.id = p.silo_tujuan_id
        JOIN operator o        ON o.id = p.operator_id`,
    where: ["p.jenis_batch = 'PREPAST'"],
    urut: 'p.prepast_finish DESC, p.id DESC',
    /* Kolom silo disebut TERSENDIRI, bukan disimpulkan dari klausa
       `siloId` di bawah dengan memotong " = ?". Filter banyak-silo perlu
       membangun `IN (?, ?, ...)` sendiri, dan menyimpulkannya dari untaian
       klausa akan patah tanpa galat begitu bentuk klausanya diubah. */
    kolomSilo: 'p.silo_tujuan_id',
    kolomStatus: 'p.status_approval',
    filter: {
      status: 'p.status_approval = ?',
      siloId: 'p.silo_tujuan_id = ?',
      supplierId: 'p.supplier_id = ?',
      draftSaja: 'p.is_gantung = TRUE',
      // Aktif = batch masih menyimpan susu di silo ini (belum habis ditransfer).
      aktifSaja: "(p.status_fifo = 'ACTIVE' AND p.qty_remaining_ltr > 0)",
      // Ditinjau SPV/QA — Prepast yang tercatat melebihi batas keras silo
      // tujuan (tidak lagi diblokir sistem, lihat pecahanSilo.js).
      lewatKapasitas: 'p.melampaui_kapasitas = TRUE',
      dariTanggal: 'p.prepast_finish >= ?',
      sampaiTanggal: 'p.prepast_finish <= ?',
      cari: '(p.kode LIKE ? OR sup.supplier_name LIKE ?)',
    },
  },

  pengembalian: {
    sql: `
      SELECT p.id, p.kode, p.vol_prepast_ltr AS volume_ltr, p.qty_remaining_ltr,
             p.prepast_start AS waktu, p.status_approval, p.status_fifo,
             FALSE AS is_gantung, p.rejection_comment,
             CONCAT('Kembali ke ', s.silo_name,
                    COALESCE(CONCAT(' (', p.keterangan_asal, ')'), '')) AS ringkasan,
             o.nama_lengkap AS operator_nama, p.operator_id
        FROM prepast_record p
        JOIN silo s     ON s.id = p.silo_tujuan_id
        JOIN operator o ON o.id = p.operator_id`,
    where: ["p.jenis_batch = 'PENGEMBALIAN'"],
    urut: 'p.prepast_start DESC, p.id DESC',
    /* Kolom silo disebut TERSENDIRI, bukan disimpulkan dari klausa
       `siloId` di bawah dengan memotong " = ?". Filter banyak-silo perlu
       membangun `IN (?, ?, ...)` sendiri, dan menyimpulkannya dari untaian
       klausa akan patah tanpa galat begitu bentuk klausanya diubah. */
    kolomSilo: 'p.silo_tujuan_id',
    kolomStatus: 'p.status_approval',
    filter: {
      status: 'p.status_approval = ?',
      siloId: 'p.silo_tujuan_id = ?',
      aktifSaja: "(p.status_fifo = 'ACTIVE' AND p.qty_remaining_ltr > 0)",
      dariTanggal: 'p.prepast_start >= ?',
      sampaiTanggal: 'p.prepast_start <= ?',
      cari: 'p.kode LIKE ?',
    },
  },

  transfer: {
    sql: `
      SELECT t.id, t.kode, t.vol_ltr AS volume_ltr, NULL AS qty_remaining_ltr,
             t.trf_time AS waktu, t.status_approval, NULL AS status_fifo,
             t.is_gantung, t.melampaui_kapasitas, t.rejection_comment,
             CONCAT(sa.silo_name, ' ke ',
                    COALESCE(st.silo_name, tk.tank_name),
                    COALESCE(CONCAT(' - ', t.batch), '')) AS ringkasan,
             o.nama_lengkap AS operator_nama, t.operator_id
        FROM transfer t
        JOIN silo sa             ON sa.id = t.silo_asal_id
        LEFT JOIN silo st        ON st.id = t.silo_tujuan_id
        LEFT JOIN tank_master tk ON tk.id = t.tank_id
        JOIN operator o          ON o.id = t.operator_id`,
    urut: 't.trf_time DESC, t.id DESC',
    /* Kolom silo disebut TERSENDIRI, bukan disimpulkan dari klausa
       `siloId` di bawah dengan memotong " = ?". Filter banyak-silo perlu
       membangun `IN (?, ?, ...)` sendiri, dan menyimpulkannya dari untaian
       klausa akan patah tanpa galat begitu bentuk klausanya diubah. */
    kolomSilo: 't.silo_asal_id',
    kolomTank: 't.tank_id',
    kolomStatus: 't.status_approval',
    filter: {
      status: 't.status_approval = ?',
      siloId: 't.silo_asal_id = ?',
      tankId: 't.tank_id = ?',
      draftSaja: 't.is_gantung = TRUE',
      // Ditinjau SPV/QA — Pindah Silo yang tercatat melebihi batas keras
      // silo tujuan (tidak lagi diblokir sistem, lihat transfer.js).
      lewatKapasitas: 't.melampaui_kapasitas = TRUE',
      dariTanggal: 't.trf_time >= ?',
      sampaiTanggal: 't.trf_time <= ?',
      cari: '(t.kode LIKE ? OR t.batch LIKE ?)',
    },
  },

  monitoring: {
    sql: `
      SELECT m.id, m.kode, NULL AS volume_ltr, NULL AS qty_remaining_ltr,
             m.time_check AS waktu, m.status_approval, NULL AS status_fifo,
             FALSE AS is_gantung, m.lewat_jadwal, m.rejection_comment,
             CONCAT(s.silo_name, ' - pH ', m.ph_check, ', ', m.temp_check, ' C') AS ringkasan,
             o.nama_lengkap AS operator_nama, m.operator_id
        FROM monitoring m
        JOIN silo s     ON s.id = m.silo_id
        JOIN operator o ON o.id = m.operator_id`,
    urut: 'm.time_check DESC, m.id DESC',
    /* Kolom silo disebut TERSENDIRI, bukan disimpulkan dari klausa
       `siloId` di bawah dengan memotong " = ?". Filter banyak-silo perlu
       membangun `IN (?, ?, ...)` sendiri, dan menyimpulkannya dari untaian
       klausa akan patah tanpa galat begitu bentuk klausanya diubah. */
    kolomSilo: 'm.silo_id',
    kolomStatus: 'm.status_approval',
    filter: {
      status: 'm.status_approval = ?',
      siloId: 'm.silo_id = ?',
      // Ditinjau SPV/QA — cek yang jaraknya dari cek sebelumnya melebihi
      // monitoring_interval_jam silo (BR-10), tetap tersimpan apa adanya,
      // lihat services/monitoring.js.
      lewatJadwal: 'm.lewat_jadwal = TRUE',
      dariTanggal: 'm.time_check >= ?',
      sampaiTanggal: 'm.time_check <= ?',
      cari: 'm.kode LIKE ?',
    },
  },
};

/** Status yang boleh disunting - FR-10.2. */
const STATUS_EDIT_OPERATOR = ['Pending Approval', 'Rejected'];
const STATUS_EDIT_SPV = ['Pending Approval', 'Approved', 'Rejected'];
/** Status yang boleh dibatalkan - FR-10.3. */
const STATUS_VOID = ['Pending Approval', 'Approved', 'Rejected', 'Edit Requested'];

/**
 * Menghitung tindakan yang tersedia untuk satu baris.
 *
 * Dihitung per baris karena bergantung pada status recordnya, bukan hanya
 * pada peran: SPV boleh menyunting record Approved, Operator tidak.
 */
function tindakan(baris, aktor) {
  const status = baris.status_approval;
  const spv = aktor.role === 'SPV';

  const bolehSunting = spv
    ? STATUS_EDIT_SPV.includes(status)
    : can(aktor.role, AKSI.TRANSAKSI_SUNTING_PENDING)
      && STATUS_EDIT_OPERATOR.includes(status);

  /*
   * Void oleh Operator: record SIAPA PUN yang belum disetujui (BR-22).
   * Kepemilikan tidak lagi membatasi - pembatalan sah oleh user mana pun selama
   * tercatat di audit (keputusan governance, dikonfirmasi pengguna). Yang masih
   * membatasi hanya STATUS; record yang sudah disetujui tetap urusan SPV.
   * Penegaknya tetap pastikanBolehVoid() di services/void.js; ini hanya
   * menentukan tombolnya muncul atau tidak.
   */
  const voidSendiri =
    can(aktor.role, AKSI.RECORD_VOID_SENDIRI)
    && status === 'Pending Approval';

  const bolehLengkapi = Boolean(baris.is_gantung)
    && bolehSunting
    && (spv || Number(baris.operator_id) === Number(aktor.id));

  return {
    // Record gantung memakai endpoint pelengkapan khusus. Operator lain tidak
    // boleh mengubahnya lewat tombol koreksi umum.
    bolehSunting: baris.is_gantung ? bolehLengkapi : bolehSunting,
    /*
     * Ini KENYAMANAN TAMPILAN - yang menegakkan tetap pastikanBolehVoid() di
     * services/void.js. Bendera ini hanya menentukan tombolnya muncul atau
     * tidak; kalau ia salah longgar, yang terjadi adalah tombol yang ditolak
     * server, bukan pembatalan yang lolos.
     */
    bolehVoid:
      (can(aktor.role, AKSI.RECORD_VOID) && STATUS_VOID.includes(status))
      || voidSendiri,
    /*
     * Berjenjang mengikuti bolehVoid.
     *
     * Layar tidak dapat menyimpulkan apakah SELURUH rantai memenuhi syarat -
     * turunannya belum dibaca saat baris ini dibentuk. Jadi tombolnya
     * ditampilkan, dan bila rantainya menyentuh record milik orang lain atau
     * yang sudah disetujui, server menolak dengan menyebut record mana. Itu
     * lebih menolong daripada tombol yang tidak pernah muncul tanpa alasan.
     */
    bolehVoidBerjenjang:
      (can(aktor.role, AKSI.RECORD_VOID) && STATUS_VOID.includes(status))
      || voidSendiri,
    // Operator mengajukan permintaan koreksi atas record yang sudah disetujui
    bolehAjukanKoreksi:
      can(aktor.role, AKSI.KOREKSI_AJUKAN) && status === 'Approved',
    // Draft dilengkapi lewat jalur tersendiri (BR-16)
    bolehLengkapi,
  };
}

/**
 * Seluruh input yang masih gantung, untuk penagihan di Home - BR-23.
 *
 * Dikembalikan APA ADANYA tanpa paginasi: yang gantung seharusnya sedikit, dan
 * kalau ia banyak, itu justru keadaan yang harus terlihat seluruhnya - bukan
 * disembunyikan di halaman kedua.
 *
 * Usia dihitung dari `created_at`, bukan dari waktu prosesnya - waktu prosesnya
 * justru yang belum ada. Yang ditagih adalah "sudah berapa lama dibiarkan
 * separuh", dan itu diukur sejak barisnya dibuat.
 */
export async function gantung(aktor) {
  const [baris] = await pool.query(
    `SELECT 'prepast' AS modul, p.kode, p.id, p.created_at, p.operator_id,
            COALESCE(s.silo_name, 'Belum ditentukan') AS tempat,
            p.vol_prepast_ltr AS volume_ltr,
            o.nama_lengkap AS operator_nama, p.prepast_start, p.prepast_finish,
            p.flowrate_pst, p.temp_after_heater, p.temp_output_prd,
            p.silo_tujuan_id, NULL AS berat_jenis, NULL AS nilai_ts
       FROM prepast_record p
       LEFT JOIN silo s ON s.id = p.silo_tujuan_id
       JOIN operator o  ON o.id = p.operator_id
      WHERE p.is_gantung = TRUE
        AND p.status_approval NOT IN ('VOIDED', 'REVISED')
      UNION ALL
     SELECT 'transfer', t.kode, t.id, t.created_at, t.operator_id,
            sa.silo_name, t.vol_ltr, o.nama_lengkap,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
       FROM transfer t
       JOIN silo sa     ON sa.id = t.silo_asal_id
       JOIN operator o  ON o.id = t.operator_id
      WHERE t.is_gantung = TRUE
        AND t.status_approval NOT IN ('VOIDED', 'REVISED')
      UNION ALL
     SELECT 'receiving', r.kode, r.id, r.created_at, r.operator_id,
            s.silo_name, r.qty_ltr, o.nama_lengkap,
            NULL, NULL, NULL, NULL, NULL, NULL, r.berat_jenis, r.nilai_ts
       FROM receiving r
       JOIN silo s      ON s.id = r.silo_id
       JOIN operator o  ON o.id = r.operator_id
      WHERE r.is_gantung = TRUE
        AND r.status_approval NOT IN ('VOIDED', 'REVISED')
      ORDER BY created_at ASC`,
  );

  const sekarang = Date.now();

  const daftar = baris.map((b) => {
    const fieldKosong = b.modul === 'prepast'
      ? statusKelengkapanPrepast({
        siloId: b.silo_tujuan_id,
        volumeLtr: b.volume_ltr,
        prepastStart: b.prepast_start,
        prepastFinish: b.prepast_finish,
        flowrate: b.flowrate_pst,
        tempAfterHeater: b.temp_after_heater,
        tempOutput: b.temp_output_prd,
      }).fieldKosong
      : b.modul === 'receiving'
        ? statusKelengkapanReceiving({
          beratJenis: b.berat_jenis,
          nilaiTs: b.nilai_ts,
        }).fieldKosong
        : [];

    return {
      modul: b.modul,
      id: b.id,
      kode: b.kode,
      tempat: b.tempat,
      volumeLtr: b.volume_ltr === null ? null : Number(b.volume_ltr),
      operatorNama: b.operator_nama,
      dibuat: b.created_at,
      fieldKosong,
      usiaJam: Math.max(0, Math.floor((sekarang - new Date(b.created_at).getTime()) / 3_600_000)),
    /*
     * Siapa yang dapat melengkapinya.
     *
     * Operator melengkapi inputnya SENDIRI; SPV boleh melengkapi milik siapa
     * pun. Bendera ini kenyamanan tampilan - penegakannya tetap di alur
     * koreksi, yang sudah memeriksa wewenang atas barisnya.
     */
      bolehSayaLengkapi:
        aktor.role === 'SPV' || Number(b.operator_id) === Number(aktor.id),
    };
  });

  return {
    data: daftar,
    ringkasan: {
      jumlah: daftar.length,
      perModul: daftar.reduce((a, d) => ({ ...a, [d.modul]: (a[d.modul] ?? 0) + 1 }), {}),
      tertuaJam: daftar.length > 0 ? daftar[0].usiaJam : 0,
    },
  };
}

export async function daftar(modul, kueri, aktor) {
  const def = MODUL[modul];
  if (!def) throw new BusinessError('VALIDATION_ERROR', `Modul tidak dikenal: ${modul}`);

  const { halaman = 1, perHalaman = 25, cari, ...filter } = kueri;

  const syarat = [...(def.where ?? [])];
  const nilai = [];

  /*
   * Banyak silo sekaligus - `siloIds`.
   *
   * Ditangani di luar putaran umum karena jumlah tanda tanyanya bergantung
   * pada banyaknya pilihan, sedangkan putaran di bawah mengandalkan klausa
   * yang bentuknya tetap. Array KOSONG berarti "seluruh silo", bukan "tidak
   * ada satu pun": itu perilaku yang diharapkan dari filter yang belum diisi.
   */
  const daftarSilo = Array.isArray(filter.siloIds)
    ? filter.siloIds.filter((v) => Number.isFinite(Number(v)))
    : [];

  if (daftarSilo.length > 0 && def.kolomSilo) {
    syarat.push(`${def.kolomSilo} IN (${daftarSilo.map(() => '?').join(', ')})`);
    nilai.push(...daftarSilo.map(Number));
  }

  // Banyak tank sekaligus - `tankIds` (analog dengan siloIds). Hanya bermakna
  // untuk modul yang punya kolom tank (transfer).
  const daftarTank = Array.isArray(filter.tankIds)
    ? filter.tankIds.filter((v) => Number.isFinite(Number(v)))
    : [];

  if (daftarTank.length > 0 && def.kolomTank) {
    syarat.push(`${def.kolomTank} IN (${daftarTank.map(() => '?').join(', ')})`);
    nilai.push(...daftarTank.map(Number));
  }

  const daftarStatus = Array.isArray(filter.statusIds)
    ? filter.statusIds.filter((v) => typeof v === 'string' && v.length > 0)
    : [];

  if (daftarStatus.length > 0 && def.kolomStatus) {
    syarat.push(`${def.kolomStatus} IN (${daftarStatus.map(() => '?').join(', ')})`);
    nilai.push(...daftarStatus);
  }

  for (const [kunci, klausa] of Object.entries(def.filter)) {
    if (kunci === 'cari') continue;
    if (kunci === 'status' && daftarStatus.length > 0) continue;
    // siloId tunggal diabaikan bila daftar banyak-silo sudah dipakai, supaya
    // keduanya tidak saling mempersempit menjadi nol baris.
    if (kunci === 'siloId' && daftarSilo.length > 0) continue;
    if (kunci === 'tankId' && daftarTank.length > 0) continue;
    const v = filter[kunci];
    if (v === undefined || v === '' || v === false) continue;
    syarat.push(klausa);
    // Klausa boolean seperti draftSaja tidak membawa parameter
    if (klausa.includes('?')) nilai.push(v);
  }

  if (cari && def.filter.cari) {
    syarat.push(def.filter.cari);
    const jumlahParam = (def.filter.cari.match(/\?/g) ?? []).length;
    for (let i = 0; i < jumlahParam; i += 1) nilai.push(`%${cari}%`);
  }

  const where = syarat.length ? `WHERE ${syarat.join(' AND ')}` : '';
  const offset = (halaman - 1) * perHalaman;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM (${def.sql} ${where}) x`,
    nilai,
  );
  const [baris] = await pool.query(
    `${def.sql} ${where} ORDER BY ${def.urut} LIMIT ? OFFSET ?`,
    [...nilai, perHalaman, offset],
  );

  return {
    data: baris.map((b) => ({
      modul,
      id: b.id,
      kode: b.kode,
      ringkasan: b.ringkasan,
      volumeLtr: b.volume_ltr === null ? null : Number(b.volume_ltr),
      sisaLtr: b.qty_remaining_ltr === null ? null : Number(b.qty_remaining_ltr),
      waktu: b.waktu,
      statusApproval: b.status_approval,
      statusFifo: b.status_fifo,
      isDraft: Boolean(b.is_gantung),
      // Ditinjau SPV/QA — hanya ada pada modul yang kapasitasnya soft cap
      // (Prepast, Transfer); undefined pada modul lain jadi otomatis false.
      melampauiKapasitas: Boolean(b.melampaui_kapasitas),
      // Hanya ada pada modul Monitoring (BR-10); undefined di modul lain
      // jadi otomatis false.
      lewatJadwal: Boolean(b.lewat_jadwal),
      komentarPenolakan: b.rejection_comment,
      operatorNama: b.operator_nama,
      ...tindakan(b, aktor),
    })),
    total,
    halaman,
    perHalaman,
    totalHalaman: Math.max(1, Math.ceil(total / perHalaman)),
  };
}

/**
 * Detail lengkap satu record - untuk fitur "Lihat".
 *
 * Mengembalikan seluruh kolom bermakna dari record, sudah diberi label ramah,
 * ditata dalam kelompok agar lapis tampilan tinggal merendernya sebagai daftar
 * pasangan label-nilai tanpa perlu tahu bentuk tiap modul. Untuk transfer, ikut
 * dibawakan rincian alokasi FIFO-nya.
 */
export async function detail(modul, id) {
  const def = MODUL[modul];
  if (!def) throw new BusinessError('VALIDATION_ERROR', `Modul tidak dikenal: ${modul}`);

  const kueri = {
    receiving: `
      SELECT r.kode, r.status_approval, r.finish_time, r.qty_kg, r.berat_jenis,
             r.nilai_ts, r.qty_ltr, r.qty_remaining_ltr, r.buffer_status,
             r.is_gantung, r.remarks, r.rejection_comment, r.created_at, r.updated_at,
             sup.supplier_name, s.silo_name, o.nama_lengkap AS operator_nama
        FROM receiving r
        JOIN supplier sup ON sup.id = r.supplier_id
        JOIN silo s ON s.id = r.silo_id
        JOIN operator o ON o.id = r.operator_id
       WHERE r.id = ?`,
    prepast: `
      SELECT p.kode, p.status_approval, p.jenis_batch, p.prepast_start, p.prepast_finish,
             p.vol_prepast_ltr, p.qty_remaining_ltr, p.melampaui_kapasitas, p.flowrate_pst,
             p.temp_after_heater, p.temp_output_prd, p.nilai_ts, p.is_gantung,
             p.remarks, p.rejection_comment, p.created_at, p.updated_at,
             COALESCE(sup.supplier_name, 'Tidak diketahui') AS supplier_name,
             COALESCE(s.silo_name, 'Belum ditentukan') AS silo_name,
             r.kode AS receiving_kode, o.nama_lengkap AS operator_nama
        FROM prepast_record p
        LEFT JOIN supplier sup ON sup.id = p.supplier_id
        LEFT JOIN silo s ON s.id = p.silo_tujuan_id
        LEFT JOIN receiving r ON r.id = p.receiving_id
        JOIN operator o ON o.id = p.operator_id
       WHERE p.id = ?`,
    pengembalian: `
      SELECT p.kode, p.status_approval, p.prepast_start, p.vol_prepast_ltr,
             p.qty_remaining_ltr, p.keterangan_asal, p.remarks, p.rejection_comment,
             p.created_at, p.updated_at, s.silo_name, o.nama_lengkap AS operator_nama
        FROM prepast_record p
        JOIN silo s ON s.id = p.silo_tujuan_id
        JOIN operator o ON o.id = p.operator_id
       WHERE p.id = ?`,
    transfer: `
      SELECT t.kode, t.status_approval, t.transfer_type, t.trf_time, t.vol_ltr,
             t.vol_akt_silo_ltr, t.melampaui_kapasitas, t.batch, t.cmd_destination,
             t.standing_time_menit,
             t.is_gantung, t.rejection_comment, t.created_at, t.updated_at,
             sa.silo_name AS silo_asal_nama, st.silo_name AS silo_tujuan_nama,
             tk.tank_name, o.nama_lengkap AS operator_nama
        FROM transfer t
        JOIN silo sa ON sa.id = t.silo_asal_id
        LEFT JOIN silo st ON st.id = t.silo_tujuan_id
        LEFT JOIN tank_master tk ON tk.id = t.tank_id
        JOIN operator o ON o.id = t.operator_id
       WHERE t.id = ?`,
    monitoring: `
      SELECT m.kode, m.status_approval, m.time_check, m.ph_check, m.temp_check,
             m.jam_sejak_cek_sebelumnya, m.lewat_jadwal,
             m.rejection_comment, m.created_at, m.updated_at,
             s.silo_name, s.monitoring_interval_jam, o.nama_lengkap AS operator_nama
        FROM monitoring m
        JOIN silo s ON s.id = m.silo_id
        JOIN operator o ON o.id = m.operator_id
       WHERE m.id = ?`,
  }[modul];

  const [baris] = await pool.query(kueri, [id]);
  const r = baris[0];
  if (!r) throw new BusinessError('NOT_FOUND', 'Record tidak ditemukan');

  const num = (v, d = 2) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));

  // Susunan field per modul: [label, nilai, satuan?]. Nilai null dilewati di UI.
  const F = {
    receiving: [
      ['Supplier', r.supplier_name], ['Silo', r.silo_name],
      ['Waktu selesai terima', r.finish_time, 'waktu'],
      ['Qty (Kg)', num(r.qty_kg)], ['Berat jenis', num(r.berat_jenis, 3)],
      ['Nilai TS', num(r.nilai_ts, 1)], ['Volume (L)', num(r.qty_ltr)],
      ['Sisa di buffer (L)', num(r.qty_remaining_ltr)],
      ['Status buffer', r.buffer_status],
      ['Menggantung', r.is_gantung ? 'Ya - belum lengkap' : 'Tidak'],
      ['Catatan', r.remarks],
    ],
    prepast: [
      ['Supplier', r.supplier_name], ['Silo tujuan', r.silo_name],
      ['Jenis batch', r.jenis_batch], ['Batch induk', r.receiving_kode],
      ['Mulai', r.prepast_start, 'waktu'], ['Selesai', r.prepast_finish, 'waktu'],
      ['Volume (L)', num(r.vol_prepast_ltr)], ['Sisa (L)', num(r.qty_remaining_ltr)],
      ['Flowrate', num(r.flowrate_pst, 1)], ['Temp after heater (°C)', num(r.temp_after_heater, 1)],
      ['Temp output (°C)', num(r.temp_output_prd, 1)], ['Nilai TS', num(r.nilai_ts, 1)],
      ['Menggantung', r.is_gantung ? 'Ya - belum lengkap' : 'Tidak'],
      ['Kapasitas tujuan', r.melampaui_kapasitas ? 'Melebihi batas keras silo tujuan' : null],
      ['Catatan', r.remarks],
    ],
    pengembalian: [
      ['Silo tujuan', r.silo_name], ['Waktu kembali', r.prepast_start, 'waktu'],
      ['Volume (L)', num(r.vol_prepast_ltr)], ['Sisa (L)', num(r.qty_remaining_ltr)],
      ['Keterangan asal', r.keterangan_asal], ['Catatan', r.remarks],
    ],
    transfer: [
      ['Jenis', r.transfer_type], ['Silo asal', r.silo_asal_nama],
      ['Tujuan', r.silo_tujuan_nama || r.tank_name],
      ['Waktu transfer', r.trf_time, 'waktu'], ['Volume (L)', num(r.vol_ltr)],
      ['Volume silo saat itu (L)', num(r.vol_akt_silo_ltr)], ['Batch', r.batch],
      ['Tujuan CMD', r.cmd_destination],
      ['Standing time (menit)', r.standing_time_menit === null ? null : Number(r.standing_time_menit)],
      ['Menggantung', r.is_gantung ? 'Ya - belum lengkap' : 'Tidak'],
      ['Kapasitas tujuan', r.melampaui_kapasitas ? 'Melebihi batas keras silo tujuan' : null],
    ],
    monitoring: [
      ['Silo', r.silo_name], ['Waktu cek', r.time_check, 'waktu'],
      ['pH', num(r.ph_check, 2)], ['Suhu (°C)', num(r.temp_check, 1)],
      ['Jarak dari cek sebelumnya', r.jam_sejak_cek_sebelumnya == null ? null : `${num(r.jam_sejak_cek_sebelumnya, 2)} jam (ambang ${r.monitoring_interval_jam} jam)`],
      ['Jadwal', r.lewat_jadwal ? 'Lewat jadwal — melebihi ambang interval silo' : null],
    ],
  }[modul];

  const field = (arr) => arr
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([label, nilai, tipe]) => ({ label, nilai, tipe: tipe ?? 'teks' }));

  const hasil = {
    modul, id, kode: r.kode, status: r.status_approval,
    operatorNama: r.operator_nama,
    dibuat: r.created_at, diperbarui: r.updated_at,
    komentarPenolakan: r.rejection_comment ?? null,
    field: field(F),
  };

  if (modul === 'transfer') {
    const [alokasi] = await pool.query(
      `SELECT p.kode AS prepast_kode, sup.supplier_name, ta.qty_allocated, ta.urutan_fifo
         FROM transfer_allocation ta
         JOIN prepast_record p ON p.id = ta.prepast_id
         LEFT JOIN supplier sup ON sup.id = ta.supplier_id
        WHERE ta.transfer_id = ?
        ORDER BY ta.urutan_fifo`,
      [id],
    );
    hasil.alokasi = alokasi.map((a) => ({
      prepastKode: a.prepast_kode,
      supplierName: a.supplier_name ?? 'Tidak diketahui',
      qtyAllocated: Number(a.qty_allocated),
      urutanFifo: a.urutan_fifo,
    }));
  }

  return hasil;
}

/** Jumlah per status, untuk lencana filter. */
export async function ringkasanStatus(modul) {
  const def = MODUL[modul];
  if (!def) throw new BusinessError('VALIDATION_ERROR', `Modul tidak dikenal: ${modul}`);
  const where = def.where?.length ? `WHERE ${def.where.join(' AND ')}` : '';

  const [baris] = await pool.query(
    `SELECT status_approval, COUNT(*) n
       FROM (${def.sql} ${where}) x
      GROUP BY status_approval`,
  );
  return Object.fromEntries(baris.map((b) => [b.status_approval, b.n]));
}
