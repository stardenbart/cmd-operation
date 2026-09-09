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
  const kelengkapan = statusKelengkapanPrepast({
    prepastStart, prepastFinish: finishFinal, flowrate, tempAfterHeater, tempOutput,
  });
  const gantung = kelengkapan.isGantung;

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
    const siloIds = [...new Set(pecahan.map((p) => Number(p.siloId)))].sort((a, b) => a - b);
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

    let hasilValidasi;
    try {
      hasilValidasi = validasiPecahan(
        pecahan,
        Number(induk.qty_remaining_ltr),
        kapasitas,
        batasKeras,
      );
    } catch (err) {
      // Teruskan kode aturan yang sesungguhnya dilanggar — bukan memaksa
      // semuanya menjadi BR-06.
      throw new BusinessError(err.kode ?? 'VALIDATION_ERROR', err.message, {
        ...(err.detail ?? {}),
        sisaBatchLtr: Number(induk.qty_remaining_ltr),
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
          aktor.id, gantung, remarks ?? null,
        ],
      );

      // Anchor bergantung pada waktu susu selesai masuk silo, bukan pada
      // lengkapnya flowrate/suhu. Data ukur lain boleh tetap menggantung.
      if (finishFinal && !infoSilo.get(p.siloId).standing_time_anchor) {
        await conn.query(
          'UPDATE silo SET standing_time_anchor = ? WHERE id = ? AND standing_time_anchor IS NULL',
          [finishFinal, p.siloId],
        );
      }

      dibuat.push({
        id: hasil.insertId, kode, siloId: p.siloId, volumeLtr: p.volumeLtr,
        kontinu: kontinuitas.tersambung,
        continuityPreviousId: kontinuitas.tersambung ? kontinuitas.sebelumnya?.id ?? null : null,
        continuityOverride: false,
      });
    }

    // FR-5.6 — kurangi sisa batch induk; tutup bila habis (BR-08)
    const sisaBaru = Number(induk.qty_remaining_ltr) - hasilValidasi.totalLtr;
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

    for (const d of dibuat) {
      await catatAudit(conn, {
        entity: 'prepast', entityId: d.id, action: 'CREATE',
        actorId: aktor.id,
        after: { ...d, receivingId, gantung },
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
      fieldKosong: kelengkapan.fieldKosong,
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
    prepastStart: record.prepast_start,
    prepastFinish: record.prepast_finish,
    flowrate: record.flowrate_pst,
    tempAfterHeater: record.temp_after_heater,
    tempOutput: record.temp_output_prd,
  });
  return {
    id: record.id,
    kode: record.kode,
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
  return bentukKonteksKelengkapan(baris[0]);
}

/**
 * Melengkapi record secara bertahap — BR-16.
 * Field yang tidak dikirim mempertahankan nilai lama; record baru keluar dari
 * Dashboard setelah keempat data proses terisi.
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

    if (!prepastStart) {
      throw new BusinessError('PREPAST_START_REQUIRED', 'Waktu Mulai wajib diisi.');
    }

    const finishFinal = normalisasiWaktuSelesai(
      prepastStart, finishMasukan, perubahan.konfirmasiRollover ?? false,
    );
    validasiOprp(tempAfterHeater, perubahan.konfirmasiOprp ?? false);

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
      prepastStart, prepastFinish: finishFinal, flowrate, tempAfterHeater, tempOutput,
    });

    await conn.query(
      `UPDATE prepast_record
          SET prepast_start = ?, prepast_finish = ?, flowrate_pst = ?,
              temp_after_heater = ?, temp_output_prd = ?, is_gantung = ?,
              continuity_previous_id = ?, continuity_override = FALSE,
              continuity_override_reason = NULL
        WHERE id = ?`,
      [
        prepastStart, finishFinal, flowrate, tempAfterHeater, tempOutput,
        kelengkapan.isGantung,
        continuityPreviousIdBaru,
        id,
      ],
    );

    if (finishFinal) {
      await conn.query(
        'UPDATE silo SET standing_time_anchor = ? WHERE id = ? AND standing_time_anchor IS NULL',
        [finishFinal, lama.silo_tujuan_id],
      );
    }

    const [baru] = await conn.query('SELECT * FROM prepast_record WHERE id = ?', [id]);
    await catatAudit(conn, {
      entity: 'prepast', entityId: id, action: 'COMPLETE_DRAFT',
      actorId: aktor.id, before: lama, after: baru[0], ip,
    });

    return bentukKonteksKelengkapan(baru[0]);
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
            r.kode AS receiving_kode, sup.supplier_name, s.silo_name
       FROM prepast_record p
       LEFT JOIN receiving r ON r.id = p.receiving_id
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
       JOIN silo s       ON s.id = p.silo_tujuan_id
       ${where}
      ORDER BY p.prepast_finish DESC, p.id DESC
      LIMIT ? OFFSET ?`,
    [...nilai, perHalaman, offset],
  );
  return { data: baris, total, halaman, perHalaman };
}
