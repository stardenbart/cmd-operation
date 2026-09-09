/**
 * Permintaan koreksi - FR-15, WF-3
 *
 * Operator tidak dapat menyunting record yang sudah disetujui, jadi ia
 * mengajukan permintaan. Yang berbeda dari alur Power Apps: perubahan yang
 * diusulkan MENYERTAI permintaannya.
 *
 * Alur lama menempuh empat perjalanan bolak-balik:
 *
 *   1. Operator meminta izin edit   -> status Approved menjadi Edit Requested
 *   2. SPV menyetujui permintaan    -> status menjadi Pending Approval
 *   3. Operator menyunting          -> record lama REVISED, record baru dibuat
 *   4. SPV menyetujui record baru   -> status menjadi Approved
 *
 * Di antara langkah 2 dan 3 record menggantung: sudah bukan Approved, tetapi
 * belum diperbaiki. Karena `Edit Requested` dikecualikan dari export (D-12),
 * record yang sah MENGHILANG dari laporan selama jendela itu, dan bila
 * operator lupa melanjutkan, ia hilang tanpa ada yang tahu.
 *
 * Di sini dua langkah, dan record asli TETAP Approved sampai penggantinya
 * benar-benar siap:
 *
 *   1. Operator mengajukan beserta nilai barunya -> record asli tak tersentuh
 *   2. SPV melihat perbandingan lalu memutuskan  -> koreksi dijalankan server
 */

import { pool, withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { koreksi } from './koreksi.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';
import { skemaPerubahanKoreksi } from '../schemas/koreksi.js';
import { pastikanBerwenang, AKSI } from '../auth/permissions.js';

const TABEL = {
  receiving: 'receiving',
  prepast: 'prepast_record',
  pengembalian: 'prepast_record',
  transfer: 'transfer',
  monitoring: 'monitoring',
};

/**
 * Peta field yang dapat diusulkan: nama di permintaan -> kolom & labelnya.
 *
 * Dipakai untuk menyusun perbandingan lama/baru. Tanpa peta ini SPV hanya
 * melihat JSON mentah, dan menyetujui sesuatu yang tidak dapat dibaca bukan
 * persetujuan.
 */
const FIELD = {
  receiving: {
    qtyKg: { kolom: 'qty_kg', label: 'Kuantitas (kg)' },
    beratJenis: { kolom: 'berat_jenis', label: 'Berat jenis' },
    nilaiTs: { kolom: 'nilai_ts', label: 'Total solid' },
    finishTime: { kolom: 'finish_time', label: 'Waktu selesai' },
    supplierId: { kolom: 'supplier_id', label: 'Supplier' },
    remarks: { kolom: 'remarks', label: 'Catatan' },
  },
  prepast: {
    volumeLtr: { kolom: 'vol_prepast_ltr', label: 'Volume (L)' },
    prepastStart: { kolom: 'prepast_start', label: 'Mulai' },
    prepastFinish: { kolom: 'prepast_finish', label: 'Selesai' },
    flowrate: { kolom: 'flowrate_pst', label: 'Flowrate' },
    tempAfterHeater: { kolom: 'temp_after_heater', label: 'Temp after heater' },
    tempOutput: { kolom: 'temp_output_prd', label: 'Temp output' },
    remarks: { kolom: 'remarks', label: 'Catatan' },
  },
  pengembalian: {
    volumeLtr: { kolom: 'vol_prepast_ltr', label: 'Volume (L)' },
    prepastStart: { kolom: 'prepast_start', label: 'Waktu kembali' },
    prepastFinish: { kolom: 'prepast_finish', label: 'Waktu keluar silo' },
  },
  transfer: {
    trfTime: { kolom: 'trf_time', label: 'Waktu transfer' },
    tankId: { kolom: 'tank_id', label: 'Tank tujuan' },
    batchPrefix: { kolom: null, label: 'Prefiks batch' },
    batchNomor: { kolom: null, label: 'Nomor batch' },
  },
  monitoring: {
    ph: { kolom: 'ph_check', label: 'pH' },
    temp: { kolom: 'temp_check', label: 'Suhu (C)' },
    timeCheck: { kolom: 'time_check', label: 'Waktu cek' },
  },
};

/**
 * Membakukan usulan lewat skema yang sama dengan koreksi langsung.
 *
 * Dipanggil DUA kali dan itu memang disengaja:
 *
 *  - saat diajukan, supaya usulan yang tidak sah ditolak di depan pemohon
 *    yang masih memegang konteksnya, bukan di depan SPV yang tidak dapat
 *    memperbaikinya;
 *  - saat disetujui, karena yang tersimpan di payload_json adalah teks apa
 *    adanya (agar tetap terbaca di jejak audit dan tidak bergeser zona
 *    waktu), sedangkan service koreksi menuntut angka dan Date.
 */
function bakukan(usulan) {
  const hasil = skemaPerubahanKoreksi.safeParse(usulan);
  if (!hasil.success) {
    const galat = hasil.error.issues[0];
    throw new BusinessError(
      'VALIDATION_ERROR',
      `Usulan tidak sah pada ${galat.path.join('.') || 'nilai'}: ${galat.message}`,
    );
  }
  return Object.fromEntries(
    Object.entries(hasil.data).filter(([, v]) => v !== undefined),
  );
}

async function ambilRecord(conn, modul, id) {
  const tabel = TABEL[modul];
  if (!tabel) throw new BusinessError('VALIDATION_ERROR', `Modul tidak dikenal: ${modul}`);
  const [baris] = await conn.query(`SELECT * FROM ${tabel} WHERE id = ?`, [id]);
  if (!baris[0]) throw new NotFoundError('Record');
  return baris[0];
}

/** Menyusun perbandingan nilai lama dan yang diusulkan. */
function susunPerbandingan(modul, record, usulan) {
  const peta = FIELD[modul] ?? {};
  const hasil = [];

  for (const [kunci, nilaiBaru] of Object.entries(usulan)) {
    const def = peta[kunci];
    if (!def || nilaiBaru === undefined || nilaiBaru === null || nilaiBaru === '') continue;

    const nilaiLama = def.kolom ? record[def.kolom] : null;
    const berubah = def.kolom
      ? String(nilaiLama ?? '') !== String(nilaiBaru)
      : true;

    hasil.push({
      field: kunci,
      label: def.label,
      lama: nilaiLama,
      baru: nilaiBaru,
      berubah,
    });
  }

  return hasil;
}

/**
 * Mengajukan permintaan koreksi. Record asli TIDAK diubah sama sekali.
 */
export async function ajukan({ modul, entityId, usulan, alasan }, aktor, ip) {
  // BR-22 - Operator mengusulkan; SPV mengoreksi langsung, tidak mengajukan
  pastikanBerwenang(aktor, AKSI.KOREKSI_AJUKAN);
  if (!alasan || alasan.trim().length < 3) {
    throw new BusinessError('FR-15.1', 'Alasan permintaan koreksi wajib diisi');
  }

  const bersih = Object.fromEntries(
    Object.entries(usulan ?? {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    ),
  );
  if (Object.keys(bersih).length === 0) {
    throw new BusinessError(
      'FR-15.1',
      'Isi minimal satu nilai yang diusulkan. Permintaan tanpa usulan tidak dapat ditinjau.',
    );
  }

  // Ditolak di sini, bukan nanti saat SPV menyetujui
  bakukan(bersih);

  return withTransaction(async (conn) => {
    const record = await ambilRecord(conn, modul, entityId);

    if (record.status_approval !== 'Approved') {
      throw new BusinessError(
        'BR-19',
        `${record.kode} berstatus ${record.status_approval}. ` +
          'Permintaan koreksi hanya untuk record yang sudah disetujui; ' +
          'record lain dapat langsung dikoreksi.',
      );
    }

    // Satu permintaan terbuka per record. Dua permintaan bersamaan atas
    // record yang sama akan membuat SPV menyetujui perubahan yang saling
    // menimpa tanpa menyadarinya.
    const [adaPending] = await conn.query(
      `SELECT id FROM correction_request
        WHERE entity = ? AND entity_id = ? AND status = 'PENDING'`,
      [modul, entityId],
    );
    if (adaPending[0]) {
      throw new BusinessError(
        'FR-15.1',
        `Sudah ada permintaan koreksi yang menunggu untuk ${record.kode}.`,
        { permintaanId: adaPending[0].id },
      );
    }

    const perbandingan = susunPerbandingan(modul, record, bersih);
    if (!perbandingan.some((p) => p.berubah)) {
      throw new BusinessError(
        'FR-15.1',
        'Nilai yang diusulkan sama dengan nilai sekarang. Tidak ada yang perlu dikoreksi.',
      );
    }

    const [hasil] = await conn.query(
      `INSERT INTO correction_request
         (entity, entity_id, requested_by, reason, payload_json, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [modul, entityId, aktor.id, alasan, JSON.stringify(bersih)],
    );

    await catatAudit(conn, {
      entity: modul,
      entityId,
      action: 'REQUEST_EDIT',
      actorId: aktor.id,
      // Record tidak diubah, jadi tidak ada before/after; yang dicatat
      // adalah usulannya.
      after: { permintaanId: hasil.insertId, usulan: bersih },
      reason: alasan,
      ip,
    });

    return {
      id: hasil.insertId,
      kode: record.kode,
      perbandingan,
      // Ditegaskan dalam respons: statusnya memang tidak berubah
      statusRecord: record.status_approval,
    };
  });
}

/** Daftar permintaan, lengkap dengan perbandingannya. */
export async function daftar({ status = 'PENDING', modul } = {}) {
  const syarat = ['cr.status = ?'];
  const nilai = [status];
  if (modul) { syarat.push('cr.entity = ?'); nilai.push(modul); }

  const [baris] = await pool.query(
    `SELECT cr.*, o.nama_lengkap AS pemohon_nama,
            r.nama_lengkap AS peninjau_nama,
            TIMESTAMPDIFF(MINUTE, cr.created_at, UTC_TIMESTAMP()) AS usia_menit
       FROM correction_request cr
       JOIN operator o      ON o.id = cr.requested_by
       LEFT JOIN operator r ON r.id = cr.reviewed_by
      WHERE ${syarat.join(' AND ')}
      ORDER BY cr.created_at ASC`,
    nilai,
  );

  const data = [];
  for (const b of baris) {
    const usulan = typeof b.payload_json === 'string'
      ? JSON.parse(b.payload_json)
      : b.payload_json;

    let record = null;
    try {
      record = await ambilRecord(pool, b.entity, b.entity_id);
    } catch {
      // Record dapat sudah di-void setelah permintaan diajukan
    }

    data.push({
      id: b.id,
      modul: b.entity,
      entityId: b.entity_id,
      kode: record?.kode ?? '(record tidak ditemukan)',
      statusRecord: record?.status_approval ?? null,
      alasan: b.reason,
      pemohon: b.pemohon_nama,
      peninjau: b.peninjau_nama,
      catatanPeninjau: b.review_note,
      status: b.status,
      usiaMenit: b.usia_menit,
      dibuat: b.created_at,
      perbandingan: record ? susunPerbandingan(b.entity, record, usulan) : [],
      // Permintaan hanya dapat dijalankan bila recordnya masih Approved
      dapatDijalankan: record?.status_approval === 'Approved',
    });
  }

  return { data, total: data.length };
}

/**
 * Menyetujui permintaan: koreksi dijalankan SERVER, bukan diserahkan kembali
 * ke operator. Inilah yang memotong dua langkah dari alur lama.
 */
export async function setujui(id, catatan, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.KOREKSI_TINJAU);
  const [baris] = await pool.query(
    "SELECT * FROM correction_request WHERE id = ? AND status = 'PENDING'",
    [id],
  );
  const minta = baris[0];
  if (!minta) throw new NotFoundError('Permintaan koreksi yang menunggu');

  const usulan = typeof minta.payload_json === 'string'
    ? JSON.parse(minta.payload_json)
    : minta.payload_json;

  const alasanGabungan =
    `Permintaan koreksi #${id} oleh pemohon: ${minta.reason}` +
    (catatan ? ` | Catatan SPV: ${catatan}` : '');

  /**
   * Koreksi dijalankan lebih dulu, di transaksinya sendiri.
   *
   * Bila ia gagal (misalnya turunan aktif muncul setelah permintaan diajukan),
   * permintaan tetap PENDING dan galatnya sampai ke SPV. Menandai permintaan
   * selesai sebelum koreksinya berhasil akan membuat SPV mengira perubahan
   * sudah diterapkan.
   */
  const hasilKoreksi = await koreksi(
    minta.entity,
    minta.entity_id,
    // Persetujuan SPV berlaku sebagai konfirmasi rollover: perbandingan yang
    // ia tinjau memuat waktu mulai dan selesai, jadi pergantian hari terlihat
    // di sana, bukan tersembunyi.
    { ...bakukan(usulan), konfirmasiRollover: true },
    alasanGabungan,
    aktor,
    ip,
  );

  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE correction_request
          SET status = 'APPROVED', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(),
              review_note = ?
        WHERE id = ?`,
      [aktor.id, catatan ?? null, id],
    );

    await catatAudit(conn, {
      entity: minta.entity,
      entityId: minta.entity_id,
      action: 'GRANT_EDIT',
      actorId: aktor.id,
      after: { permintaanId: id, hasilKoreksi },
      reason: alasanGabungan,
      ip,
    });
  });

  return { permintaanId: id, ...hasilKoreksi };
}

/** Menolak permintaan. Record asli tidak tersentuh sama sekali. */
export async function tolak(id, catatan, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.KOREKSI_TINJAU);
  if (!catatan || catatan.trim().length < 3) {
    throw new BusinessError('FR-15.2', 'Alasan penolakan permintaan wajib diisi');
  }

  return withTransaction(async (conn) => {
    const [baris] = await conn.query(
      "SELECT * FROM correction_request WHERE id = ? AND status = 'PENDING' FOR UPDATE",
      [id],
    );
    const minta = baris[0];
    if (!minta) throw new NotFoundError('Permintaan koreksi yang menunggu');

    await conn.query(
      `UPDATE correction_request
          SET status = 'REJECTED', reviewed_by = ?, reviewed_at = UTC_TIMESTAMP(),
              review_note = ?
        WHERE id = ?`,
      [aktor.id, catatan, id],
    );

    await catatAudit(conn, {
      entity: minta.entity,
      entityId: minta.entity_id,
      action: 'DENY_EDIT',
      actorId: aktor.id,
      after: { permintaanId: id, ditolak: true },
      reason: catatan,
      ip,
    });

    return { permintaanId: id, status: 'REJECTED' };
  });
}

/** Field yang dapat diusulkan untuk suatu modul, untuk membangun form. */
export function fieldTersedia(modul) {
  const peta = FIELD[modul];
  if (!peta) return [];
  return Object.entries(peta).map(([k, v]) => ({ field: k, label: v.label }));
}
