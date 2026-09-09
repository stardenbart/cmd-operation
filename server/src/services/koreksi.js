/**
 * Koreksi record - FR-14, BR-12, keputusan D-3
 *
 * Bercabang menurut status:
 *
 *   Pending Approval / Rejected -> SUNTING DI TEMPAT + audit before/after.
 *     Sah karena record belum pernah disetujui siapa pun, dan jejaknya utuh
 *     di audit_log (syarat A-2). Power Apps memaksa reversal penuh bahkan
 *     untuk salah ketik lima menit setelah submit, sehingga satu koreksi
 *     kecil meninggalkan dua baris permanen.
 *
 *   Approved -> REVERSAL + record baru (BR-12).
 *     Record yang sudah dirilis penggantiannya harus terlihat di dalam data
 *     itu sendiri: auditor yang membaca daftar transaksi harus dapat melihat
 *     bahwa suatu record digantikan tanpa perlu membuka jejak audit.
 *
 * Seluruh koreksi tunduk pada BR-15: record yang punya turunan aktif tidak
 * dapat diubah, karena turunannya dihitung dari nilai yang lama.
 */

import { withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { periksa } from './dependensi.js';
import { terbitkanId } from './idGenerator.js';
import { deteksiRollover } from './waktu.js';
import { prepastPerluDilengkapi } from './prepastGantung.js';
import { bentukBatch } from './batch.js';
import { hitungQtyLtr } from './konversi.js';
import { BusinessError, NotFoundError, ForbiddenError } from '../middleware/errors.js';

const PRA_APPROVAL = ['Pending Approval', 'Rejected'];

const TABEL = {
  receiving: 'receiving',
  prepast: 'prepast_record',
  pengembalian: 'prepast_record',
  transfer: 'transfer',
  monitoring: 'monitoring',
};

async function ambil(conn, modul, id, { kunci = false } = {}) {
  const tabel = TABEL[modul];
  if (!tabel) throw new BusinessError('VALIDATION_ERROR', `Modul tidak dikenal: ${modul}`);
  const [baris] = await conn.query(
    `SELECT * FROM ${tabel} WHERE id = ?${kunci ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!baris[0]) throw new NotFoundError('Record');
  return baris[0];
}

/**
 * Penjagaan yang berlaku untuk seluruh modul.
 * @returns {'ditempat'|'reversal'} cara koreksi yang berlaku
 */
async function periksaKelayakan(conn, modul, id, lama, aktor, { volumeBerubah = true } = {}) {
  let cara;
  if (PRA_APPROVAL.includes(lama.status_approval)) {
    cara = 'ditempat';
  } else if (lama.status_approval === 'Approved') {
    // BR-19 - hanya SPV yang boleh menyentuh record yang sudah disetujui
    if (aktor.role !== 'SPV') {
      throw new ForbiddenError(
        'Hanya SPV yang dapat mengoreksi record yang sudah disetujui. ' +
          'Ajukan permintaan koreksi.',
      );
    }
    cara = 'reversal';
  } else {
    throw new BusinessError(
      'BR-19',
      `${lama.kode} berstatus ${lama.status_approval} dan tidak dapat dikoreksi`,
    );
  }

  /*
   * BR-15 - turunan aktif hanya MENGHALANGI bila koreksinya benar-benar
   * mengubah yang menjadi dasar hitungan turunan.
   *
   * Turunan (alokasi transfer, prepast anak pindah silo) dihitung dari VOLUME,
   * bukan dari flowrate, suhu, atau waktu. Jadi mengubah flowrate/temp/waktu
   * tidak menggeser apa pun pada turunannya dan tidak perlu menyentuhnya
   * (permintaan pengguna). Yang tetap dijaga: perubahan VOLUME - itu mengubah
   * sisa induk dan besaran alokasi - dan jalur REVERSAL, karena record lama
   * diganti sehingga turunannya kehilangan induk yang dirujuknya.
   */
  if (volumeBerubah || cara === 'reversal') {
    const dep = await periksa(modul, id, { conn });
    if (!dep.boleh) {
      throw new BusinessError(
        'BR-15',
        `${lama.kode} tidak dapat dikoreksi karena ada ${dep.jumlah} record turunan yang masih aktif. ` +
          'Tangani turunannya lebih dulu.',
        { pohon: dep.pohon, jumlah: dep.jumlah },
      );
    }
  }

  return cara;
}

/**
 * Apakah koreksi ini menggerakkan VOLUME - satu-satunya besaran yang menjadi
 * dasar hitungan turunan. Hanya bermakna untuk prepast/pengembalian; modul lain
 * mempertahankan penjagaan lama (dianggap selalu berpengaruh).
 */
function volumeKoreksiBerubah(modul, ubah, lama) {
  if (modul === 'prepast' || modul === 'pengembalian') {
    return ubah.volumeLtr !== undefined
      && Number(ubah.volumeLtr) !== Number(lama.vol_prepast_ltr);
  }
  return true;
}

/** Mengembalikan selisih volume ke batch penerimaan induk. */
async function sesuaikanInduk(conn, prepast, volumeBaru) {
  if (!prepast.receiving_id) return null;

  const selisih = Number(prepast.vol_prepast_ltr) - Number(volumeBaru);
  if (selisih === 0) return null;

  const [barisInduk] = await conn.query(
    'SELECT * FROM receiving WHERE id = ? FOR UPDATE',
    [prepast.receiving_id],
  );
  const induk = barisInduk[0];
  if (!induk) return null;

  const sisaBaru = Number(induk.qty_remaining_ltr) + selisih;
  if (sisaBaru < 0) {
    throw new BusinessError(
      'BR-06',
      `Volume ${volumeBaru} L melebihi sisa batch induk ${induk.kode}. ` +
        `Tersedia ${Number(induk.qty_remaining_ltr) + Number(prepast.vol_prepast_ltr)} L.`,
    );
  }

  const habis = sisaBaru >= Number(induk.qty_ltr);
  await conn.query(
    `UPDATE receiving
        SET qty_remaining_ltr = ?, buffer_status = ?, status_fifo = ?
      WHERE id = ?`,
    [
      sisaBaru,
      habis ? 'IN_BUFFER' : (sisaBaru > 0 ? 'IN_PREPAST' : 'COMPLETED'),
      sisaBaru > 0 ? 'ACTIVE' : 'CLOSED',
      induk.id,
    ],
  );

  return { kode: induk.kode, sisaBaruLtr: sisaBaru, selisihLtr: selisih };
}

/** Koreksi prepast: variabel proses dan volume. */
async function koreksiPrepast(conn, id, ubah, cara, alasan, aktor, ip) {
  const lama = await ambil(conn, 'prepast', id, { kunci: true });

  const mulai = ubah.prepastStart ?? lama.prepast_start;
  const selesaiAwal = ubah.prepastFinish ?? lama.prepast_finish;
  let selesai = selesaiAwal;

  /**
   * BR-11 - rollover HANYA berlaku untuk batch PREPAST.
   *
   * Pada PENGEMBALIAN, prepast_finish adalah kunci urutan FIFO, yaitu kapan
   * susu MENINGGALKAN silo. Nilai itu memang lebih awal daripada
   * prepast_start (waktu kembali), dan itu benar. Menerapkan rollover di sini
   * akan menggeser kunci FIFO satu hari ke depan secara diam-diam, sehingga
   * susu yang kembali dipakai lebih lambat daripada seharusnya.
   */
  const perluCekRollover = lama.jenis_batch === 'PREPAST';

  if (perluCekRollover && mulai && selesaiAwal) {
    const roll = deteksiRollover(new Date(mulai), new Date(selesaiAwal));
    if (roll.perluRollover) {
      if (!ubah.konfirmasiRollover) {
        throw new BusinessError(
          'BR-11',
          'Waktu selesai lebih awal daripada waktu mulai. Apakah prosesnya melewati tengah malam?',
          { saranSelesai: roll.saranSelesai, konfirmasiDiperlukan: 'konfirmasiRollover' },
        );
      }
      selesai = roll.saranSelesai;
    }
  }

  const volumeBaru = ubah.volumeLtr ?? Number(lama.vol_prepast_ltr);
  // Apakah volume BENAR-BENAR berubah. Bila tidak, sisa & status FIFO record
  // TIDAK boleh diganggu - turunan (transfer) yang sudah menguras batch ini
  // tetap berlaku, jadi sisanya harus tetap seperti apa adanya. Menyetel ulang
  // sisa ke volume penuh membuat susu yang sudah habis "muncul lagi" di silo.
  const volumeBerubah = ubah.volumeLtr !== undefined
    && Number(ubah.volumeLtr) !== Number(lama.vol_prepast_ltr);

  const indukDisesuaikan = await sesuaikanInduk(conn, lama, volumeBaru);

  const flowrateBaru = ubah.flowrate ?? lama.flowrate_pst;
  const tahBaru = ubah.tempAfterHeater ?? lama.temp_after_heater;
  const toutBaru = ubah.tempOutput ?? lama.temp_output_prd;

  const nilai = {
    vol_prepast_ltr: volumeBaru,
    // Volume berubah hanya diizinkan saat TIDAK ada turunan (guard BR-15),
    // jadi menyetel sisa = volume baru aman. Bila volume tidak berubah, sisa
    // dipertahankan apa adanya - termasuk 0 bila batch sudah habis terpakai.
    qty_remaining_ltr: volumeBerubah ? volumeBaru : Number(lama.qty_remaining_ltr),
    prepast_start: mulai,
    prepast_finish: selesai,
    flowrate_pst: flowrateBaru,
    temp_after_heater: tahBaru,
    temp_output_prd: toutBaru,
    remarks: ubah.remarks ?? lama.remarks,
    // Prepast menggantung bila waktu selesai / flowrate / suhu belum lengkap
    // (satu aturan di prepastGantung.js). Pengembalian tidak berkonsep draft.
    is_gantung: perluCekRollover
      ? prepastPerluDilengkapi({
        prepastFinish: selesai, flowrate: flowrateBaru,
        tempAfterHeater: tahBaru, tempOutput: toutBaru,
      })
      : false,
    // Volume berubah membuka kembali FIFO (batch diisi ulang); tanpa perubahan
    // volume, status FIFO dipertahankan supaya batch yang sudah CLOSED tidak
    // terbuka lagi dan volumenya tidak kembali muncul di silo.
    status_fifo: volumeBerubah ? 'ACTIVE' : lama.status_fifo,
  };

  if (cara === 'ditempat') {
    await conn.query(
      `UPDATE prepast_record
          SET vol_prepast_ltr = ?, qty_remaining_ltr = ?, prepast_start = ?,
              prepast_finish = ?, flowrate_pst = ?, temp_after_heater = ?,
              temp_output_prd = ?, remarks = ?, is_gantung = ?, status_fifo = ?
        WHERE id = ?`,
      [...Object.values(nilai), id],
    );
    return { id, kode: lama.kode, indukDisesuaikan };
  }

  // Reversal: record lama menjadi REVISED, record baru menggantikannya
  await conn.query(
    `UPDATE prepast_record
        SET status_approval = 'REVISED', status_fifo = 'CLOSED', qty_remaining_ltr = 0
      WHERE id = ?`,
    [id],
  );

  const kodeBaru = await terbitkanId(conn, 'PST');
  const [hasil] = await conn.query(
    `INSERT INTO prepast_record
       (kode, jenis_batch, receiving_id, supplier_id, silo_tujuan_id,
        vol_prepast_ltr, qty_remaining_ltr, prepast_start, prepast_finish,
        flowrate_pst, temp_after_heater, temp_output_prd, nilai_ts,
        operator_id, status_approval, status_fifo, cmd_source,
        is_gantung, remarks, correction_ref_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'Pending Approval', 'ACTIVE', ?, ?, ?, ?)`,
    [
      kodeBaru, lama.jenis_batch, lama.receiving_id, lama.supplier_id,
      lama.silo_tujuan_id, volumeBaru, volumeBaru, mulai, selesai,
      nilai.flowrate_pst, nilai.temp_after_heater, nilai.temp_output_prd,
      lama.nilai_ts, aktor.id, lama.cmd_source, nilai.is_gantung,
      nilai.remarks, id,
    ],
  );

  return { id: hasil.insertId, kode: kodeBaru, kodeDigantikan: lama.kode, indukDisesuaikan };
}

/**
 * Koreksi transfer.
 *
 * Volume TIDAK dapat diubah di sini: mengubahnya berarti menghitung ulang
 * alokasi FIFO ke batch yang berbeda dengan jumlah yang berbeda, yang secara
 * hakikat adalah pembatalan dan pemasukan ulang. Menyembunyikannya di balik
 * kata "koreksi" akan membuat perubahan sebesar itu tampak sepele.
 * Untuk mengubah volume: batalkan transfernya, lalu buat yang baru.
 */
async function koreksiTransfer(conn, id, ubah, cara, alasan, aktor, ip) {
  const lama = await ambil(conn, 'transfer', id, { kunci: true });

  if (ubah.volumeLtr !== undefined && Number(ubah.volumeLtr) !== Number(lama.vol_ltr)) {
    throw new BusinessError(
      'BR-05',
      'Volume transfer tidak dapat dikoreksi karena alokasi FIFO harus dihitung ulang. ' +
        'Batalkan transfer ini lalu buat yang baru.',
    );
  }

  if (cara === 'reversal') {
    throw new BusinessError(
      'BR-12',
      'Transfer yang sudah disetujui tidak dapat dikoreksi. ' +
        'Batalkan transfer ini lalu buat yang baru.',
    );
  }

  const batchBaru = ubah.batchPrefix
    ? bentukBatch(ubah.batchPrefix, ubah.batchNomor)
    : lama.batch;

  await conn.query(
    `UPDATE transfer
        SET trf_time = ?, batch = ?, tank_id = ?, is_gantung = ?
      WHERE id = ?`,
    [
      ubah.trfTime ?? lama.trf_time,
      batchBaru,
      ubah.tankId ?? lama.tank_id,
      !(ubah.trfTime ?? lama.trf_time),
      id,
    ],
  );

  return { id, kode: lama.kode, batch: batchBaru };
}

/** Koreksi monitoring: pH, suhu, waktu cek. Tidak menyentuh volume. */
async function koreksiMonitoring(conn, id, ubah, cara, alasan, aktor, ip) {
  const lama = await ambil(conn, 'monitoring', id, { kunci: true });

  if (cara === 'ditempat') {
    await conn.query(
      `UPDATE monitoring SET ph_check = ?, temp_check = ?, time_check = ? WHERE id = ?`,
      [
        ubah.ph ?? lama.ph_check,
        ubah.temp ?? lama.temp_check,
        ubah.timeCheck ?? lama.time_check,
        id,
      ],
    );
    return { id, kode: lama.kode };
  }

  await conn.query(
    "UPDATE monitoring SET status_approval = 'REVISED' WHERE id = ?", [id],
  );
  const kodeBaru = await terbitkanId(conn, 'MTR');
  const [hasil] = await conn.query(
    `INSERT INTO monitoring
       (kode, silo_id, ph_check, temp_check, time_check, supplier_list,
        val_aktual_snapshot_ltr, operator_id, status_approval, correction_ref_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending Approval', ?)`,
    [
      kodeBaru, lama.silo_id,
      ubah.ph ?? lama.ph_check,
      ubah.temp ?? lama.temp_check,
      ubah.timeCheck ?? lama.time_check,
      lama.supplier_list, lama.val_aktual_snapshot_ltr, aktor.id, id,
    ],
  );
  return { id: hasil.insertId, kode: kodeBaru, kodeDigantikan: lama.kode };
}

/**
 * Koreksi penerimaan.
 *
 * Dipindahkan ke sini dari receiving.js supaya seluruh modul memakai SATU
 * jalur koreksi: satu guard BR-15, satu bentuk audit, satu percabangan
 * status. Logika bercabang yang disalin di dua tempat pasti menyimpang.
 */
async function koreksiReceiving(conn, id, ubah, cara, alasan, aktor, ip) {
  const [barisLama] = await conn.query(
    'SELECT * FROM receiving WHERE id = ? FOR UPDATE', [id],
  );
  const lama = barisLama[0];
  if (!lama) throw new NotFoundError('Penerimaan');

  const qtyKg = ubah.qtyKg ?? Number(lama.qty_kg);
  const beratJenis = ubah.beratJenis ?? Number(lama.berat_jenis);
  const qtyLtr = hitungQtyLtr(qtyKg, beratJenis);

  const nilai = {
    supplier_id: ubah.supplierId ?? lama.supplier_id,
    qty_kg: qtyKg,
    berat_jenis: beratJenis,
    qty_ltr: qtyLtr,
    nilai_ts: ubah.nilaiTs ?? lama.nilai_ts,
    finish_time: ubah.finishTime ?? lama.finish_time,
    remarks: ubah.remarks ?? lama.remarks,
  };

  if (cara === 'ditempat') {
    await conn.query(
      `UPDATE receiving
          SET supplier_id = ?, qty_kg = ?, berat_jenis = ?, qty_ltr = ?,
              qty_remaining_ltr = ?, nilai_ts = ?, finish_time = ?, remarks = ?
        WHERE id = ?`,
      [
        nilai.supplier_id, qtyKg, beratJenis, qtyLtr, qtyLtr,
        nilai.nilai_ts, nilai.finish_time, nilai.remarks, id,
      ],
    );
    return { id, kode: lama.kode };
  }

  await conn.query(
    `UPDATE receiving
        SET status_approval = 'REVISED', status_fifo = 'CLOSED', qty_remaining_ltr = 0
      WHERE id = ?`,
    [id],
  );

  const kodeBaru = await terbitkanId(conn, 'RCV');
  const [hasil] = await conn.query(
    `INSERT INTO receiving
       (kode, supplier_id, silo_id, qty_kg, berat_jenis, qty_ltr, qty_remaining_ltr,
        nilai_ts, finish_time, operator_id, status_approval, status_fifo,
        buffer_status, cmd_source, correction_ref_id, remarks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             'Pending Approval', 'ACTIVE', 'IN_BUFFER', ?, ?, ?)`,
    [
      kodeBaru, nilai.supplier_id, lama.silo_id, qtyKg, beratJenis, qtyLtr, qtyLtr,
      nilai.nilai_ts, nilai.finish_time, aktor.id, lama.cmd_source, id, nilai.remarks,
    ],
  );

  return { id: hasil.insertId, kode: kodeBaru, kodeDigantikan: lama.kode };
}

const PENANGAN = {
  receiving: koreksiReceiving,
  prepast: koreksiPrepast,
  pengembalian: koreksiPrepast,
  transfer: koreksiTransfer,
  monitoring: koreksiMonitoring,
};

/**
 * Mengoreksi satu record.
 *
 * @param {string} modul
 * @param {number} id
 * @param {object} ubah   field yang diubah; yang tidak disebut tetap seperti semula
 * @param {string} alasan wajib (syarat A-5)
 */
export async function koreksi(modul, id, ubah, alasan, aktor, ip) {
  if (!alasan || alasan.trim().length < 3) {
    throw new BusinessError('FR-14.1', 'Alasan koreksi wajib diisi');
  }

  const penangan = PENANGAN[modul];
  if (!penangan) {
    throw new BusinessError('VALIDATION_ERROR', `Modul tidak dapat dikoreksi: ${modul}`);
  }

  return withTransaction(async (conn) => {
    const lama = await ambil(conn, modul, id);
    const volumeBerubah = volumeKoreksiBerubah(modul, ubah, lama);
    const cara = await periksaKelayakan(conn, modul, id, lama, aktor, { volumeBerubah });

    const hasil = await penangan(conn, id, ubah, cara, alasan, aktor, ip);
    const baru = await ambil(conn, modul, hasil.id);

    await catatAudit(conn, {
      entity: modul, entityId: id, action: 'CORRECT',
      actorId: aktor.id, before: lama, after: baru, reason: alasan, ip,
    });

    return { ...hasil, cara };
  });
}
