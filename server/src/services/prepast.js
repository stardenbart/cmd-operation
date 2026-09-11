/**
 * Layanan Prepast — FR-5, FR-29
 *
 * Memindahkan susu dari buffer ke silo penyimpanan. Satu penerimaan dapat
 * dipecah ke beberapa silo dalam SATU kali input (FR-29): variabel prosesnya
 * identik, hanya silo dan volumenya berbeda (D-11).
 *
 * Power Apps memaksa operator mengisi form yang sama berulang kali, mengetik
 * ulang jam, flowrate, dan kedua suhu di tiap pengulangan — sumber anomali
 * SILO25A/25A (B-18) dan sumber risiko nilai tidak konsisten antar pecahan.
 */

import { pool, withTransaction } from '../db/pool.js';
import { terbitkanId } from './idGenerator.js';
import { catatAudit } from './audit.js';
import { validasiPecahan } from './pecahanSilo.js';
import { deteksiRollover } from './waktu.js';
import { kontinu as adalahKontinu, menit, recordTerakhir } from './kontinuitasPrepast.js';
import { statusKelengkapanPrepast } from './prepastGantung.js';
import { BusinessError, NotFoundError, ForbiddenError } from '../middleware/errors.js';

const STATUS_DIABAIKAN = ['Rejected', 'REVISED', 'VOIDED'];

/** Ambang OPRP dari catatan kaki form GMP: min 81 °C (FR-5.10). */
const OPRP_TEMP_MIN = 81;

function normalisasiWaktuSelesai(prepastStart, prepastFinish, konfirmasiRollover) {
  if (!prepastFinish) return null;
  const roll = deteksiRollover(prepastStart, prepastFinish);
  if (roll.perluRollover) {
    if (!konfirmasiRollover) {
      throw new BusinessError(
        'BR-11',
        'Waktu selesai lebih awal daripada waktu mulai. Apakah prosesnya melewati tengah malam?',
        { saranSelesai: roll.saranSelesai, konfirmasiDiperlukan: 'konfirmasiRollover' },
      );
    }
    return roll.saranSelesai;
  }
  if (roll.alasan) {
    throw new BusinessError('BR-11', `Waktu selesai tidak wajar: ${roll.alasan}`);
  }
  return prepastFinish;
}

function validasiOprp(tempAfterHeater, konfirmasiOprp) {
  if (tempAfterHeater != null && tempAfterHeater < OPRP_TEMP_MIN && !konfirmasiOprp) {
    throw new BusinessError(
      'FR-5.10',
      `Temp After Heater ${tempAfterHeater} °C di bawah ambang OPRP ${OPRP_TEMP_MIN} °C`,
      { ambang: OPRP_TEMP_MIN, konfirmasiDiperlukan: 'konfirmasiOprp' },
    );
  }
}

/**
 * Antrean buffer siap prepast — FR-5.1.
 * Urut FIFO menaik: yang paling lama diterima, diprepast duluan (BR-04).
 */
export async function antreanBuffer() {
  const [baris] = await pool.query('SELECT * FROM v_buffer_queue');
  return baris;
}

/** Silo tujuan yang sah beserta kapasitas tersisanya (FR-29.7). */
export async function siloTujuan() {
  const [baris] = await pool.query(
    `SELECT silo_id, kode, silo_name, kapasitas_maks_ltr,
            vol_aktual_ltr, vol_tersedia_ltr, standing_time_anchor
       FROM v_silo_volume
      WHERE is_buffer = FALSE
      ORDER BY urutan`,
  );
  return baris;
}

/** Konteks form: batch induk + silo tujuan yang tersedia. */
export async function konteksForm(receivingId) {
  const [induk] = await pool.query(
    `SELECT r.id, r.kode, r.qty_remaining_ltr, r.nilai_ts, r.finish_time,
            sup.supplier_name
       FROM receiving r
       JOIN supplier sup ON sup.id = r.supplier_id
      WHERE r.id = ?`,
    [receivingId],
  );
  if (!induk[0]) throw new NotFoundError('Batch penerimaan');
  return { induk: induk[0], siloTujuan: await siloTujuan() };
}

export async function konteksKontinuitas() {
  const sebelumnya = await recordTerakhir(null);
  return {
    sebelumnya,
    saranStart: sebelumnya?.finish ?? null,
    presisi: 'menit',
    aturan: 'Jika dipilih kontinu, Finish record Prepast terakhir di plant menjadi Start record berikutnya.',
  };
}

/**
 * Membuat prepast — satu atau beberapa silo tujuan, satu transaksi (FR-29.6).
 *
 * Bila satu baris gagal, tidak ada baris yang tersimpan.
 */
export async function buat(masukan, aktor, ip) {
  const {
    receivingId,
    pecahan,
    prepastStart,
    prepastFinish,
    flowrate,
    tempAfterHeater,
    tempOutput,
    remarks,
    konfirmasiRollover = false,
    konfirmasiOprp = false,
    kontinu = false,
    continuityPreviousId,
  } = masukan;

  // Waktu Mulai selalu wajib. Empat data proses lain boleh menyusul dan masing-
  // masing disimpan apa adanya; satu field kosong membuat record menggantung.
  if (!prepastStart) {
    throw new BusinessError('PREPAST_START_REQUIRED', 'Waktu Mulai wajib diisi.');
  }
  const finishFinal = normalisasiWaktuSelesai(
    prepastStart, prepastFinish ?? null, konfirmasiRollover,
  );
  validasiOprp(tempAfterHeater, konfirmasiOprp);
  return withTransaction(async (conn) => {
    // Kunci batch induk: dua operator tidak boleh memprepast sisa yang sama
    const [barisInduk] = await conn.query(
      `SELECT r.*, sup.id AS sup_id
         FROM receiving r JOIN supplier sup ON sup.id = r.supplier_id
        WHERE r.id = ? FOR UPDATE`,
      [receivingId],
    );
    const induk = barisInduk[0];
    if (!induk) throw new NotFoundError('Batch penerimaan');

    if (STATUS_DIABAIKAN.includes(induk.status_approval)) {
      throw new BusinessError(
        'BR-01',
        `Batch berstatus ${induk.status_approval} tidak dapat diprepast`,
      );
    }

    // Kunci silo tujuan dalam urutan tetap. Tanpa ini, dua receiving berbeda
    // dapat membaca kapasitas lama silo yang sama dan keduanya lolos validasi.
    const siloIds = [...new Set(pecahan
      .filter((p) => p.siloId != null)
      .map((p) => Number(p.siloId)))].sort((a, b) => a - b);
    const tempat = siloIds.map(() => '?').join(', ');
    if (siloIds.length) {
      await conn.query(`SELECT id FROM silo WHERE id IN (${tempat}) ORDER BY id FOR UPDATE`, siloIds);
    }

    // Kapasitas tersisa per silo, dibaca di dalam transaksi
    const [siloBaris] = await conn.query(
      `SELECT silo_id, silo_name, vol_tersedia_ltr,
              vol_tersedia_toleransi_ltr, standing_time_anchor
         FROM v_silo_volume WHERE is_buffer = FALSE`,
    );
    const kapasitas = new Map(
      siloBaris.map((s) => [s.silo_id, Number(s.vol_tersedia_ltr)]),
    );
    // BR-24 — sisa sampai BATAS KERAS (kapasitas + toleransi), dibaca
    // langsung dari VIEW. Jangan dijumlahkan dari sisa nominal: nilai itu
    // di-clamp ke 0, sehingga toleransi akan terhitung dua kali pada silo
    // yang sudah melampaui nominal.
    const batasKeras = new Map(
      siloBaris.map((s) => [s.silo_id, Number(s.vol_tersedia_toleransi_ltr)]),
    );
    const infoSilo = new Map(siloBaris.map((s) => [s.silo_id, s]));

    // `qty_remaining_ltr` bernilai NULL selama Receiving induk belum punya
    // Berat Jenis — volume liternya memang belum bisa dihitung sama sekali,
    // beda dari batch yang sungguh sudah habis. `Number(null)` akan diam-diam
    // menjadi 0 dan disalahartikan sebagai "habis", jadi NULL harus tetap
    // NULL sampai ke validasiPecahan.
    const sisaIndukLtr = induk.qty_remaining_ltr === null
      ? null
      : Number(induk.qty_remaining_ltr);

    let hasilValidasi;
    try {
      hasilValidasi = validasiPecahan(
        pecahan,
        sisaIndukLtr,
        kapasitas,
        batasKeras,
      );
    } catch (err) {
      // Teruskan kode aturan yang sesungguhnya dilanggar — bukan memaksa
      // semuanya menjadi BR-06.
      throw new BusinessError(err.kode ?? 'VALIDATION_ERROR', err.message, {
        ...(err.detail ?? {}),
        sisaBatchLtr: sisaIndukLtr,
      });
    }

    const dibuat = [];
    let kontinuitas = { sebelumnya: null, tersambung: false };
    // Kontinuitas bergantung pada Waktu Mulai, bukan pada lengkapnya hasil ukur.
    // Karena itu record parsial tetap tidak boleh overlap dengan proses terakhir.
    {
      const sebelumnya = await recordTerakhir(conn, { kunci: true });
      const mulaiMenit = menit(prepastStart);
      const finishMenit = menit(sebelumnya?.finish);
      // Tarikan co-temporal - Waktu Mulai persis sama dengan record terakhir -
      // adalah beberapa tarikan pada jam yang sama, satu sesi. Itu sah dan
      // dikelompokkan sebagai satu sesi di analitik; hanya mundur ke sebelum
      // finish record lain yang benar-benar dilarang.
      const coTemporal = sebelumnya && mulaiMenit === menit(sebelumnya.start);
      if (sebelumnya && !coTemporal && mulaiMenit < finishMenit) {
        throw new BusinessError(
          'PREPAST_START_OVERLAP',
          `Waktu Mulai tidak boleh lebih awal dari Finish Prepast terakhir ${sebelumnya.kode}.`,
          { sebelumnya, saranStart: sebelumnya.finish },
        );
      }
      if (kontinu && !sebelumnya) {
        throw new BusinessError('PREPAST_CONTINUITY_UNAVAILABLE', 'Belum ada record Prepast sebelumnya untuk disambungkan.');
      }
      if (kontinu && Number(continuityPreviousId) !== Number(sebelumnya?.id)) {
        throw new BusinessError(
          'PREPAST_CONTINUITY_STALE',
          'Record Prepast terakhir berubah. Muat ulang saran kontinuitas sebelum submit.',
          { sebelumnya, saranStart: sebelumnya?.finish ?? null },
        );
      }
      const tersambung = adalahKontinu(sebelumnya, { start: prepastStart });
      if (kontinu && !tersambung) {
        throw new BusinessError(
          'PREPAST_NOT_CONTINUOUS',
          'Waktu Mulai kontinu harus sama dengan Finish record Prepast terakhir.',
          { sebelumnya, saranStart: sebelumnya?.finish ?? null },
        );
      }
      kontinuitas = { sebelumnya, tersambung: Boolean(kontinu && tersambung) };
    }

    for (const p of hasilValidasi.pecahan) {
      const kelengkapanBaris = statusKelengkapanPrepast({
        siloId: p.siloId,
        volumeLtr: p.volumeLtr,
        prepastStart,
        prepastFinish: finishFinal,
        flowrate,
        tempAfterHeater,
        tempOutput,
      });
      const gantungBaris = kelengkapanBaris.isGantung;
      const kode = await terbitkanId(conn, 'PST');
      const [hasil] = await conn.query(
        `INSERT INTO prepast_record
           (kode, receiving_id, supplier_id, silo_tujuan_id,
            vol_prepast_ltr, qty_remaining_ltr,
            prepast_start, prepast_finish, continuity_previous_id,
            continuity_override, continuity_override_reason, flowrate_pst,
            temp_after_heater, temp_output_prd, nilai_ts,
            operator_id, status_approval, status_fifo, cmd_source,
            is_gantung, remarks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'Pending Approval', 'ACTIVE', 'CMD1', ?, ?)`,
        [
          kode, receivingId, induk.sup_id, p.siloId,
          p.volumeLtr, p.volumeLtr,
          prepastStart,
          finishFinal,
          kontinuitas.tersambung ? kontinuitas.sebelumnya?.id ?? null : null,
          false,
          null,
          flowrate ?? null, tempAfterHeater ?? null, tempOutput ?? null,
          induk.nilai_ts,
          aktor.id, gantungBaris, remarks ?? null,
        ],
      );

      // Anchor bergantung pada waktu susu selesai masuk silo, bukan pada
      // lengkapnya flowrate/suhu. Data ukur lain boleh tetap menggantung.
      if (p.siloId != null && p.volumeLtr != null
        && finishFinal && !infoSilo.get(p.siloId).standing_time_anchor) {
        await conn.query(
          'UPDATE silo SET standing_time_anchor = ? WHERE id = ? AND standing_time_anchor IS NULL',
          [finishFinal, p.siloId],
        );
      }

      dibuat.push({
        id: hasil.insertId, kode, siloId: p.siloId, volumeLtr: p.volumeLtr,
        gantung: gantungBaris,
        fieldKosong: kelengkapanBaris.fieldKosong,
        kontinu: kontinuitas.tersambung,
        continuityPreviousId: kontinuitas.tersambung ? kontinuitas.sebelumnya?.id ?? null : null,
        continuityOverride: false,
      });
    }

    // FR-5.6 — kurangi sisa batch induk; tutup bila habis (BR-08).
    // Dilewati sepenuhnya bila sisanya belum diketahui: totalLtr pasti 0
    // (validasiPecahan menolak volume apa pun saat itu), dan Receiving harus
    // tetap gantung apa adanya sampai Berat Jenis-nya dilengkapi — bukan
    // ditutup seolah-olah habis.
    const sisaBaru = sisaIndukLtr === null
      ? null
      : sisaIndukLtr - hasilValidasi.totalLtr;
    if (sisaBaru !== null) {
      await conn.query(
        `UPDATE receiving
            SET qty_remaining_ltr = ?,
                buffer_status = ?,
                status_fifo = ?
          WHERE id = ?`,
        [
          sisaBaru,
          sisaBaru <= 0 ? 'COMPLETED' : 'IN_PREPAST',
          sisaBaru <= 0 ? 'CLOSED' : 'ACTIVE',
          receivingId,
        ],
      );
    }

    const gantung = dibuat.some((d) => d.gantung);
    const fieldKosong = [...new Map(
      dibuat.flatMap((d) => d.fieldKosong).map((f) => [f.key, f]),
    ).values()];

    for (const d of dibuat) {
      await catatAudit(conn, {
        entity: 'prepast', entityId: d.id, action: 'CREATE',
        actorId: aktor.id,
        after: { ...d, receivingId },
        ip,
      });
    }

    return {
      dibuat,
      totalLtr: hasilValidasi.totalLtr,
      sisaBatchIndukLtr: sisaBaru,
      // `draft` dipertahankan sebagai nama lama; kini artinya "menggantung".
      draft: gantung,
      gantung,
      fieldKosong,
      // BR-24 — baris yang melampaui kapasitas nominal namun masih sah
      melampauiNominal: hasilValidasi.melampauiNominal,
      rolloverDiterapkan: finishFinal?.getTime?.() !== prepastFinish?.getTime?.(),
    };
  });
}

/** Turunan aktif: apakah prepast ini sudah dipakai transfer? — BR-15 */
export async function dependensi(id) {
  const [baris] = await pool.query(
    `SELECT t.id, t.kode, t.transfer_type, t.vol_ltr, t.status_approval,
            ta.qty_allocated
       FROM transfer_allocation ta
       JOIN transfer t ON t.id = ta.transfer_id
      WHERE ta.prepast_id = ?
        AND t.status_approval NOT IN (?, ?, ?)
      ORDER BY t.trf_time ASC, t.id ASC`,
    [id, ...STATUS_DIABAIKAN],
  );
  return baris;
}

function pastikanBolehLengkapi(lama, aktor) {
  if (lama.jenis_batch !== 'PREPAST') {
    throw new BusinessError('VALIDATION_ERROR', 'Record ini bukan Prepast.');
  }
  if (!lama.is_gantung) {
    throw new BusinessError('BUKAN_DRAFT', 'Record ini sudah lengkap. Gunakan koreksi biasa.');
  }
  if (!['Pending Approval', 'Rejected'].includes(lama.status_approval)) {
    throw new BusinessError(
      'BR-19',
      `${lama.kode} berstatus ${lama.status_approval} dan tidak dapat dilengkapi`,
    );
  }
  const milikSendiri = Number(lama.operator_id) === Number(aktor.id);
  if (aktor.role !== 'SPV' && !milikSendiri) {
    throw new ForbiddenError('Operator hanya dapat melengkapi record Prepast miliknya sendiri.');
  }
}

function bentukKonteksKelengkapan(record) {
  const kelengkapan = statusKelengkapanPrepast({
    siloId: record.silo_tujuan_id,
    volumeLtr: record.vol_prepast_ltr,
    prepastStart: record.prepast_start,
    prepastFinish: record.prepast_finish,
    flowrate: record.flowrate_pst,
    tempAfterHeater: record.temp_after_heater,
    tempOutput: record.temp_output_prd,
  });
  return {
    id: record.id,
    kode: record.kode,
    siloId: record.silo_tujuan_id,
    volumeLtr: record.vol_prepast_ltr,
    prepastStart: record.prepast_start,
    prepastFinish: record.prepast_finish,
    flowrate: record.flowrate_pst,
    tempAfterHeater: record.temp_after_heater,
    tempOutput: record.temp_output_prd,
    kontinu: Boolean(record.continuity_previous_id),
    continuityPreviousId: record.continuity_previous_id,
    isGantung: kelengkapan.isGantung,
    fieldKosong: kelengkapan.fieldKosong,
  };
}

/** Konteks untuk dialog pelengkapan; otorisasi tetap diperiksa di server. */
export async function konteksPelengkapan(id, aktor) {
  const [baris] = await pool.query('SELECT * FROM prepast_record WHERE id = ?', [id]);
  if (!baris[0]) throw new NotFoundError('Prepast');
  pastikanBolehLengkapi(baris[0], aktor);

  // Volume belum dapat dilengkapi selama Receiving induk belum punya Berat
  // Jenis (lihat lengkapiDraft). UI memakai ini untuk menonaktifkan field
  // Volume di muka, bukan menunggu ditolak server.
  const [indukBaris] = await pool.query(
    'SELECT kode, berat_jenis, qty_remaining_ltr FROM receiving WHERE id = ?',
    [baris[0].receiving_id],
  );
  const induk = indukBaris[0] ?? null;

  return {
    ...bentukKonteksKelengkapan(baris[0]),
    siloTujuan: await siloTujuan(),
    bjIndukBelumDiisi: induk != null && induk.berat_jenis == null,
    indukKode: induk?.kode ?? null,
    // Sisa yang masih bisa dialokasikan — dasar UI "Tambah silo" & ringkasan
    // Teralokasi. NULL bila induk belum punya Berat Jenis (belum ada angka
    // untuk dialokasikan sama sekali).
    sisaIndukLtr: induk?.qty_remaining_ltr == null ? null : Number(induk.qty_remaining_ltr),
  };
}

/**
 * Melengkapi record secara bertahap — BR-16.
 * Field yang tidak dikirim mempertahankan nilai lama; record baru keluar dari
 * Dashboard setelah silo tujuan, volume, dan seluruh data proses terisi.
 */
export async function lengkapiDraft(id, perubahan, aktor, ip) {
  return withTransaction(async (conn) => {
    const [baris] = await conn.query(
      'SELECT * FROM prepast_record WHERE id = ? FOR UPDATE',
      [id],
    );
    const lama = baris[0];
    if (!lama) throw new NotFoundError('Prepast');
    pastikanBolehLengkapi(lama, aktor);

    const prepastStart = perubahan.prepastStart ?? lama.prepast_start;
    const finishMasukan = perubahan.prepastFinish ?? lama.prepast_finish;
    const flowrate = perubahan.flowrate ?? lama.flowrate_pst;
    const tempAfterHeater = perubahan.tempAfterHeater ?? lama.temp_after_heater;
    const tempOutput = perubahan.tempOutput ?? lama.temp_output_prd;
    const siloId = perubahan.siloId ?? lama.silo_tujuan_id;
    const volumeLtr = perubahan.volumeLtr
      ?? (lama.vol_prepast_ltr == null ? null : Number(lama.vol_prepast_ltr));

    if (lama.silo_tujuan_id != null
      && perubahan.siloId !== undefined
      && Number(perubahan.siloId) !== Number(lama.silo_tujuan_id)) {
      throw new BusinessError(
        'SILO_ALREADY_SET',
        'Silo tujuan yang sudah tersimpan tidak dapat diganti lewat pelengkapan. Gunakan koreksi.',
      );
    }

    if (lama.vol_prepast_ltr != null
      && perubahan.volumeLtr !== undefined
      && Number(perubahan.volumeLtr) !== Number(lama.vol_prepast_ltr)) {
      throw new BusinessError(
        'VOLUME_ALREADY_SET',
        'Volume yang sudah tersimpan tidak dapat diganti lewat pelengkapan. Gunakan koreksi.',
      );
    }

    if (!prepastStart) {
      throw new BusinessError('PREPAST_START_REQUIRED', 'Waktu Mulai wajib diisi.');
    }

    const finishFinal = normalisasiWaktuSelesai(
      prepastStart, finishMasukan, perubahan.konfirmasiRollover ?? false,
    );
    validasiOprp(tempAfterHeater, perubahan.konfirmasiOprp ?? false);

    const volumeDitambahkan = lama.vol_prepast_ltr == null && volumeLtr != null;
    const siloDitambahkan = lama.silo_tujuan_id == null && siloId != null;
    let induk = null;

    // Volume yang baru diketahui baru sekarang mengambil stok dari buffer.
    // Receiving dikunci agar dua draft tidak menghabiskan sisa yang sama.
    if (volumeDitambahkan) {
      const [barisInduk] = await conn.query(
        'SELECT id, kode, qty_remaining_ltr FROM receiving WHERE id = ? FOR UPDATE',
        [lama.receiving_id],
      );
      induk = barisInduk[0];
      if (!induk) throw new NotFoundError('Batch penerimaan');

      // Sisa batch induk belum dapat dihitung selama Berat Jenis Receiving-nya
      // belum diisi — tidak ada angka untuk memvalidasi maupun mengurangi
      // Volume Prepast ini terhadapnya. Pesan ini jauh lebih jelas daripada
      // membiarkan Number(null) jatuh menjadi 0 dan disalahartikan sebagai
      // "batch sudah habis" (BR-06).
      if (induk.qty_remaining_ltr === null) {
        throw new BusinessError(
          'RECEIVING_BJ_BELUM_DIISI',
          `Berat Jenis Receiving ${induk.kode} belum diisi. Lengkapi Berat Jenis ` +
            'Receiving tersebut terlebih dahulu sebelum mengisi Volume Prepast ini.',
        );
      }
    }

    // Silo perlu dikunci saat baru dipilih atau ketika volume baru ditambahkan
    // ke silo yang telah dipilih sebelumnya. Kapasitas divalidasi hanya ketika
    // volume sudah tersedia.
    let kapasitas = new Map();
    let batasKeras = new Map();
    if (siloId != null && (siloDitambahkan || volumeDitambahkan)) {
      const [siloBaris] = await conn.query(
        'SELECT id FROM silo WHERE id = ? AND is_buffer = FALSE AND is_active = TRUE FOR UPDATE',
        [siloId],
      );
      if (!siloBaris[0]) {
        throw new BusinessError('SILO_NOT_FOUND', 'Silo tujuan tidak ditemukan atau tidak aktif.');
      }
      const [kapasitasBaris] = await conn.query(
        `SELECT silo_id, vol_tersedia_ltr, vol_tersedia_toleransi_ltr
           FROM v_silo_volume WHERE silo_id = ?`,
        [siloId],
      );
      kapasitas = new Map(kapasitasBaris.map((s) => [s.silo_id, Number(s.vol_tersedia_ltr)]));
      batasKeras = new Map(kapasitasBaris.map((s) => [s.silo_id, Number(s.vol_tersedia_toleransi_ltr)]));
    }

    if (volumeLtr != null && (siloDitambahkan || volumeDitambahkan)) {
      try {
        validasiPecahan(
          [{ siloId: siloId == null ? null : Number(siloId), volumeLtr: Number(volumeLtr) }],
          volumeDitambahkan ? Number(induk.qty_remaining_ltr) : Number(volumeLtr),
          kapasitas,
          batasKeras,
        );
      } catch (err) {
        throw new BusinessError(err.kode ?? 'VALIDATION_ERROR', err.message, err.detail ?? null);
      }
    }

    if (volumeDitambahkan) {
      const sisaBaru = Number(induk.qty_remaining_ltr) - Number(volumeLtr);
      await conn.query(
        `UPDATE receiving
            SET qty_remaining_ltr = ?, buffer_status = ?, status_fifo = ?
          WHERE id = ?`,
        [
          sisaBaru,
          sisaBaru <= 0 ? 'COMPLETED' : 'IN_PREPAST',
          sisaBaru <= 0 ? 'CLOSED' : 'ACTIVE',
          induk.id,
        ],
      );
    }

    /*
     * Melengkapi hasil ukur tidak boleh divalidasi ulang terhadap "record
     * terakhir saat ini". Bisa saja record ini dibuat pukul 07.00, lalu baru
     * diisi flowrate-nya setelah proses pukul 09.00 tercatat. Relasi waktunya
     * sudah sah saat CREATE; mencari record terakhir lagi justru membuat
     * record pukul 07.00 ditolak karena dianggap mundur dari pukul 09.00.
     *
     * Validasi kontinuitas hanya diulang bila Waktu Mulai atau pilihan
     * kontinuitas benar-benar berubah. Waktu selesai dan hasil ukur dapat
     * menyusul tanpa merusak relasi yang sudah tersimpan.
     */
    const startBerubah = menit(prepastStart) !== menit(lama.prepast_start);
    const kontinuitasDiubah = perubahan.kontinu !== undefined
      || perubahan.continuityPreviousId !== undefined;
    let continuityPreviousIdBaru = lama.continuity_previous_id;

    if (startBerubah || kontinuitasDiubah) {
      const sebelumnya = await recordTerakhir(conn, { kunci: true, excludeId: id });
      const coTemporal = sebelumnya && menit(prepastStart) === menit(sebelumnya.start);
      if (sebelumnya && !coTemporal && menit(prepastStart) < menit(sebelumnya.finish)) {
        throw new BusinessError(
          'PREPAST_START_OVERLAP',
          `Waktu Mulai tidak boleh lebih awal dari Finish Prepast terakhir ${sebelumnya.kode}.`,
          { sebelumnya, saranStart: sebelumnya.finish },
        );
      }

      const kontinu = perubahan.kontinu ?? Boolean(lama.continuity_previous_id);
      const continuityPreviousId = perubahan.continuityPreviousId
        ?? lama.continuity_previous_id;
      if (kontinu && !sebelumnya) {
        throw new BusinessError('PREPAST_CONTINUITY_UNAVAILABLE', 'Belum ada record Prepast sebelumnya untuk disambungkan.');
      }
      if (kontinu && Number(continuityPreviousId) !== Number(sebelumnya?.id)) {
        throw new BusinessError(
          'PREPAST_CONTINUITY_STALE',
          'Record Prepast terakhir berubah. Periksa kembali waktu mulai sebelum submit.',
          { sebelumnya, saranStart: sebelumnya?.finish ?? null },
        );
      }
      const tersambung = adalahKontinu(sebelumnya, { start: prepastStart });
      if (kontinu && !tersambung) {
        throw new BusinessError(
          'PREPAST_NOT_CONTINUOUS',
          'Waktu Mulai kontinu harus sama dengan Finish record Prepast terakhir.',
        );
      }
      continuityPreviousIdBaru = kontinu && tersambung ? sebelumnya?.id ?? null : null;
    }

    const kelengkapan = statusKelengkapanPrepast({
      siloId, volumeLtr, prepastStart, prepastFinish: finishFinal,
      flowrate, tempAfterHeater, tempOutput,
    });

    await conn.query(
      `UPDATE prepast_record
          SET silo_tujuan_id = ?, vol_prepast_ltr = ?, qty_remaining_ltr = ?,
              prepast_start = ?, prepast_finish = ?, flowrate_pst = ?,
              temp_after_heater = ?, temp_output_prd = ?, is_gantung = ?,
              continuity_previous_id = ?, continuity_override = FALSE,
              continuity_override_reason = NULL
        WHERE id = ?`,
      [
        siloId,
        volumeLtr,
        volumeDitambahkan ? volumeLtr : lama.qty_remaining_ltr,
        prepastStart, finishFinal, flowrate, tempAfterHeater, tempOutput,
        kelengkapan.isGantung,
        continuityPreviousIdBaru,
        id,
      ],
    );

    if (finishFinal && siloId != null && volumeLtr != null) {
      await conn.query(
        `UPDATE silo
            SET standing_time_anchor = CASE
              WHEN standing_time_anchor IS NULL OR ? < standing_time_anchor THEN ?
              ELSE standing_time_anchor
            END
          WHERE id = ?`,
        [finishFinal, finishFinal, siloId],
      );
    }

    /*
     * Silo tambahan — pecahan batch yang sama ke silo lain, ditemukan
     * operator BELAKANGAN saat melengkapi, bukan saat pengisian awal
     * (D-11: variabel prosesnya identik, hanya silo & volume yang beda).
     * Tiap baris jadi record BARU, mewarisi seluruh data proses record
     * yang sedang dilengkapi ini. Tetap dalam TRANSAKSI YANG SAMA —
     * gagal satu baris berarti tidak ada yang tersimpan, termasuk
     * pelengkapan record utama di atas (M-1).
     */
    const pecahanTambahan = Array.isArray(perubahan.pecahanTambahan)
      ? perubahan.pecahanTambahan : [];
    const dibuatTambahan = [];

    if (pecahanTambahan.length > 0) {
      if (!lama.receiving_id) {
        throw new BusinessError(
          'PECAHAN_TAMBAHAN_TANPA_INDUK',
          'Record ini tidak berasal dari Receiving — tidak dapat menambah silo lain.',
        );
      }

      // Silo yang sama dengan record utama akan lolos pengecekan duplikat
      // FR-29.5 di validasiPecahan (yang hanya melihat DALAM daftar
      // tambahan) karena silo utama tidak ikut daftar itu — dicek terpisah
      // di sini supaya tidak ada dua baris memperebutkan kapasitas silo
      // yang sama tanpa saling tahu.
      if (siloId != null && pecahanTambahan.some((p) => Number(p.siloId) === Number(siloId))) {
        throw new BusinessError(
          'FR-29.5',
          `Silo yang sama dengan record utama tidak boleh diisi lagi di baris tambahan (silo id ${siloId})`,
        );
      }

      // Induk mungkin sudah terkunci di atas (volumeDitambahkan); kalau
      // belum, kunci sekarang — baris tambahan tetap perlu memvalidasi &
      // mengurangi sisa yang sama.
      let indukTambahan = induk;
      if (!indukTambahan) {
        const [barisInduk] = await conn.query(
          'SELECT id, kode, qty_remaining_ltr FROM receiving WHERE id = ? FOR UPDATE',
          [lama.receiving_id],
        );
        indukTambahan = barisInduk[0];
        if (!indukTambahan) throw new NotFoundError('Batch penerimaan');
        if (indukTambahan.qty_remaining_ltr === null) {
          throw new BusinessError(
            'RECEIVING_BJ_BELUM_DIISI',
            `Berat Jenis Receiving ${indukTambahan.kode} belum diisi. Lengkapi Berat Jenis ` +
              'Receiving tersebut terlebih dahulu sebelum menambah silo.',
          );
        }
      }

      // Sisa yang tersedia UNTUK BARIS TAMBAHAN: bila volume record utama
      // baru saja dikurangkan di atas, `induk.qty_remaining_ltr` di memori
      // sudah usang — pakai sisaBaru yang baru dihitung. Kalau tidak, baca
      // ulang dari DB (sudah dikunci FOR UPDATE, aman dari balapan).
      let sisaTersedia;
      if (volumeDitambahkan) {
        sisaTersedia = Number(induk.qty_remaining_ltr) - Number(volumeLtr);
      } else {
        const [[r]] = await conn.query(
          'SELECT qty_remaining_ltr FROM receiving WHERE id = ?', [indukTambahan.id],
        );
        sisaTersedia = Number(r.qty_remaining_ltr);
      }

      const [siloBarisTambahan] = await conn.query(
        `SELECT silo_id, vol_tersedia_ltr, vol_tersedia_toleransi_ltr
           FROM v_silo_volume WHERE is_buffer = FALSE`,
      );
      const kapasitasTambahan = new Map(
        siloBarisTambahan.map((s) => [s.silo_id, Number(s.vol_tersedia_ltr)]),
      );
      const batasKerasTambahan = new Map(
        siloBarisTambahan.map((s) => [s.silo_id, Number(s.vol_tersedia_toleransi_ltr)]),
      );

      let hasilValidasiTambahan;
      try {
        hasilValidasiTambahan = validasiPecahan(
          pecahanTambahan, sisaTersedia, kapasitasTambahan, batasKerasTambahan,
        );
      } catch (err) {
        throw new BusinessError(err.kode ?? 'VALIDATION_ERROR', err.message, err.detail ?? null);
      }

      for (const p of hasilValidasiTambahan.pecahan) {
        const kelengkapanBaris = statusKelengkapanPrepast({
          siloId: p.siloId, volumeLtr: p.volumeLtr, prepastStart, prepastFinish: finishFinal,
          flowrate, tempAfterHeater, tempOutput,
        });
        const kodeBaru = await terbitkanId(conn, 'PST');
        const [hasilInsert] = await conn.query(
          `INSERT INTO prepast_record
             (kode, receiving_id, supplier_id, silo_tujuan_id,
              vol_prepast_ltr, qty_remaining_ltr,
              prepast_start, prepast_finish, continuity_previous_id,
              continuity_override, continuity_override_reason, flowrate_pst,
              temp_after_heater, temp_output_prd, nilai_ts,
              operator_id, status_approval, status_fifo, cmd_source,
              is_gantung, remarks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   'Pending Approval', 'ACTIVE', 'CMD1', ?, ?)`,
          [
            kodeBaru, lama.receiving_id, lama.supplier_id, p.siloId,
            p.volumeLtr, p.volumeLtr,
            prepastStart, finishFinal,
            continuityPreviousIdBaru,
            false, null,
            flowrate ?? null, tempAfterHeater ?? null, tempOutput ?? null,
            lama.nilai_ts,
            aktor.id, kelengkapanBaris.isGantung, lama.remarks,
          ],
        );

        if (p.siloId != null && p.volumeLtr != null && finishFinal) {
          await conn.query(
            `UPDATE silo SET standing_time_anchor = CASE
                WHEN standing_time_anchor IS NULL OR ? < standing_time_anchor THEN ?
                ELSE standing_time_anchor
              END
              WHERE id = ?`,
            [finishFinal, finishFinal, p.siloId],
          );
        }

        const recordBaru = {
          id: hasilInsert.insertId, kode: kodeBaru, siloId: p.siloId, volumeLtr: p.volumeLtr,
          isGantung: kelengkapanBaris.isGantung, fieldKosong: kelengkapanBaris.fieldKosong,
        };
        dibuatTambahan.push(recordBaru);

        await catatAudit(conn, {
          entity: 'prepast', entityId: hasilInsert.insertId, action: 'CREATE',
          actorId: aktor.id,
          after: { ...recordBaru, receivingId: lama.receiving_id, dariPelengkapan: id },
          ip,
        });
      }

      // Sisa induk dikurangi TOTAL baris tambahan — di luar potongan volume
      // record utama, yang (bila ada) sudah ditulis ke DB di atas.
      if (hasilValidasiTambahan.totalLtr > 0) {
        const sisaAkhir = sisaTersedia - hasilValidasiTambahan.totalLtr;
        await conn.query(
          `UPDATE receiving
              SET qty_remaining_ltr = ?, buffer_status = ?, status_fifo = ?
            WHERE id = ?`,
          [
            sisaAkhir,
            sisaAkhir <= 0 ? 'COMPLETED' : 'IN_PREPAST',
            sisaAkhir <= 0 ? 'CLOSED' : 'ACTIVE',
            indukTambahan.id,
          ],
        );
      }
    }

    const [baru] = await conn.query('SELECT * FROM prepast_record WHERE id = ?', [id]);
    await catatAudit(conn, {
      entity: 'prepast', entityId: id, action: 'COMPLETE_DRAFT',
      actorId: aktor.id, before: lama, after: baru[0], ip,
    });

    return { ...bentukKonteksKelengkapan(baru[0]), pecahanTambahan: dibuatTambahan };
  });
}

export async function daftar({ halaman = 1, perHalaman = 25, status, siloId, draftSaja }) {
  const syarat = [];
  const nilai = [];
  if (status) { syarat.push('p.status_approval = ?'); nilai.push(status); }
  if (siloId) { syarat.push('p.silo_tujuan_id = ?'); nilai.push(siloId); }
  if (draftSaja) { syarat.push('p.is_gantung = TRUE'); }

  const where = syarat.length ? `WHERE ${syarat.join(' AND ')}` : '';
  const offset = (halaman - 1) * perHalaman;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM prepast_record p ${where}`, nilai,
  );
  const [baris] = await pool.query(
    `SELECT p.id, p.kode, p.vol_prepast_ltr, p.qty_remaining_ltr,
            p.prepast_start, p.prepast_finish, p.flowrate_pst,
            p.temp_after_heater, p.temp_output_prd,
            p.status_approval, p.status_fifo, p.is_gantung,
            r.kode AS receiving_kode, sup.supplier_name,
            COALESCE(s.silo_name, 'Belum ditentukan') AS silo_name
       FROM prepast_record p
       LEFT JOIN receiving r ON r.id = p.receiving_id
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
       LEFT JOIN silo s  ON s.id = p.silo_tujuan_id
       ${where}
      ORDER BY p.prepast_finish DESC, p.id DESC
      LIMIT ? OFFSET ?`,
    [...nilai, perHalaman, offset],
  );
  return { data: baris, total, halaman, perHalaman };
}
