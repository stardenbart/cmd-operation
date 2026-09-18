/**
 * Tautan publik "siapa yang menyetujui" - sel Diperiksa Oleh, Halaman 2.
 *
 * Dulu juga menaungi kolom Paraf Halaman 1 (QR per-Receiving); itu bagian
 * DIHAPUS - Paraf sekarang memakai gambar tanda tangan operator sendiri
 * (services/signature.js), tidak lagi tautan. Yang tersisa di sini murni
 * untuk Halaman 2, yang memang tetap QR (satu tanda tangan review untuk
 * banyak record sekaligus, tidak mungkin diwakili satu gambar tanda tangan
 * per baris).
 *
 * Tokennya ditandatangani (HMAC), bukan disimpan di tabel - dihitung ulang
 * saat diverifikasi, tidak perlu migrasi basis data, dan tidak bisa
 * "kedaluwarsa tanpa sengaja" karena baris terhapus.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { batasTanggal } from './waktu.js';
import { STATUS_TERBIT } from './formData.js';

/** HMAC atas namespace+nilai, dipotong ke 20 karakter base64url - cukup
 * panjang untuk tidak ditebak, cukup pendek supaya QR-nya tidak terlalu
 * padat. */
function tandaTangan(namespace, nilai) {
  return createHmac('sha256', config.auth.jwtSecret)
    .update(`approval-share:${namespace}:${nilai}`)
    .digest('base64url')
    .slice(0, 20);
}

/**
 * Mengurai kembali snapshot supplier_list (mis. "PT ABC (1.234,5 L), PT XYZ
 * (50 L)") jadi array terstruktur. Formatnya dikontrol kode kita sendiri
 * (monitoring.js, via toLocaleString('id-ID')) - dipecah per ', ', bukan
 * disimpan ulang sebagai JSON, supaya baris LAMA yang sudah tersimpan
 * sebagai string tetap terbaca tanpa migrasi data.
 */
function uraiSupplierList(str) {
  if (!str) return [];
  return str.split(', ').map((bagian) => {
    const cocok = /^(.*) \(([\d.,]+) L\)$/.exec(bagian.trim());
    if (!cocok) return null;
    const [, nama, angka] = cocok;
    return { nama, alokasiLiter: Number(angka.replace(/\./g, '').replace(',', '.')) };
  }).filter(Boolean);
}

/** Perbandingan waktu-konstan - token ini publik, hindari celah timing attack. */
function samaAman(diharapkan, diberikan) {
  if (!diberikan || typeof diberikan !== 'string') return false;
  const a = Buffer.from(diharapkan);
  const b = Buffer.from(diberikan);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buatTokenHarian(tanggalIso) {
  return tandaTangan('harian', tanggalIso);
}

export function verifikasiTokenHarian(tanggalIso, token) {
  return samaAman(tandaTangan('harian', tanggalIso), token);
}

/** Tautan lengkap yang dipetakan ke QR "Diperiksa Oleh", Halaman 2. */
export function tautanApprovalHarian(tanggalIso) {
  return `${config.appUrl}/publik/approval-harian/${tanggalIso}/${buatTokenHarian(tanggalIso)}`;
}

/**
 * Ringkasan untuk sel "Diperiksa Oleh", Halaman 2 - BUKAN riwayat audit
 * penuh. Satu hari kerja bisa memuat puluhan record; dump audit_log penuh
 * untuk semuanya akan terlalu panjang untuk dipindai dari HP. Cukup satu
 * baris ringkas per record: siapa mengerjakan, siapa memeriksa
 * (approved_by_id), kapan - sama seperti yang sudah tersimpan di tabelnya
 * sendiri, tidak perlu menelusuri audit_log.
 *
 * Mencakup KEEMPAT modul yang punya alur approval SPV sendiri - Receiving
 * & Prepast (Halaman 1), Monitoring & Transfer/PEMAKAIAN PRODUKSI
 * (Halaman 2) - bukan hanya yang tercetak di Halaman 2. QR-nya memang
 * dicetak di Halaman 2, tapi tujuannya menunjukkan SELURUH approval SPV
 * hari itu, bukan cuma yang tercetak di sel tempat QR itu berada.
 */
export async function riwayatApprovalHarian(tanggalIso) {
  const dari = batasTanggal(tanggalIso, 'mulai');
  const sampai = batasTanggal(tanggalIso, 'akhir');
  const tanda = STATUS_TERBIT.map(() => '?').join(',');

  const [monitoring] = await pool.query(
    `SELECT m.kode, s.silo_name, m.time_check AS waktu, m.status_approval, m.approved_at,
            m.ph_check, m.temp_check, m.val_aktual_snapshot_ltr, m.supplier_list,
            o.nama_lengkap AS operator_nama, sp.nama_lengkap AS approver_nama
       FROM monitoring m
       JOIN silo s     ON s.id = m.silo_id
       JOIN operator o ON o.id = m.operator_id
       LEFT JOIN operator sp ON sp.id = m.approved_by_id
      WHERE m.time_check BETWEEN ? AND ? AND m.status_approval IN (${tanda})
      ORDER BY m.time_check, m.id`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  const [receiving] = await pool.query(
    `SELECT r.kode, s.silo_name, r.finish_time AS waktu, r.status_approval, r.approved_at,
            r.qty_kg, r.berat_jenis, r.qty_ltr, r.nilai_ts, sup.supplier_name,
            o.nama_lengkap AS operator_nama, sp.nama_lengkap AS approver_nama
       FROM receiving r
       JOIN silo s        ON s.id = r.silo_id
       JOIN supplier sup  ON sup.id = r.supplier_id
       JOIN operator o    ON o.id = r.operator_id
       LEFT JOIN operator sp ON sp.id = r.approved_by_id
      WHERE r.finish_time BETWEEN ? AND ? AND r.status_approval IN (${tanda})
      ORDER BY r.finish_time, r.id`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  const [prepast] = await pool.query(
    `SELECT p.kode, s.silo_name, p.prepast_finish AS waktu, p.status_approval, p.approved_at,
            p.jenis_batch, p.vol_prepast_ltr, p.flowrate_pst, p.temp_after_heater,
            p.temp_output_prd, p.nilai_ts, sup.supplier_name, rc.kode AS receiving_kode,
            o.nama_lengkap AS operator_nama, sp.nama_lengkap AS approver_nama
       FROM prepast_record p
       JOIN silo s            ON s.id = p.silo_tujuan_id
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
       LEFT JOIN receiving rc ON rc.id = p.receiving_id
       JOIN operator o        ON o.id = p.operator_id
       LEFT JOIN operator sp  ON sp.id = p.approved_by_id
      WHERE p.prepast_finish BETWEEN ? AND ? AND p.status_approval IN (${tanda})
      ORDER BY p.prepast_finish, p.id`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  const [transfer] = await pool.query(
    `SELECT t.kode, sa.silo_name, t.trf_time AS waktu, t.status_approval, t.approved_at,
            t.transfer_type, t.tank_id, t.batch, t.vol_ltr, tk.tank_name,
            o.nama_lengkap AS operator_nama, sp.nama_lengkap AS approver_nama
       FROM transfer t
       JOIN silo sa    ON sa.id = t.silo_asal_id
       JOIN operator o ON o.id = t.operator_id
       LEFT JOIN operator sp ON sp.id = t.approved_by_id
       LEFT JOIN tank_master tk ON tk.id = t.tank_id
      WHERE t.trf_time BETWEEN ? AND ? AND t.transfer_type = 'PEMAKAIAN PRODUKSI'
        AND t.status_approval IN (${tanda})
      ORDER BY t.trf_time, t.id`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  const petakanMonitoring = (baris) => baris.map((b) => ({
    jenis: 'Monitoring',
    kode: b.kode,
    silo: b.silo_name,
    waktu: b.waktu,
    dikerjakanOleh: b.operator_nama,
    diperiksaOleh: b.approver_nama,
    disetujuiPada: b.approved_at,
    status: b.status_approval,
    detail: {
      ph: Number(b.ph_check),
      suhu: Number(b.temp_check),
      volume: Number(b.val_aktual_snapshot_ltr),
      supplier: uraiSupplierList(b.supplier_list),
    },
  }));

  /*
   * "Batch bersama" (transfer.js buatBanyak modeBatch SAMA) tidak disimpan
   * sebagai penanda eksplisit per baris - dikenali di sini dengan
   * membandingkan tank+batch+waktu antar baris yang SUDAH terambil pada hari
   * yang sama. Cukup: baris "saudara" selalu punya trf_time identik (dikirim
   * dalam satu submit yang sama), jadi selalu berada dalam rentang tanggal
   * yang sama juga - tidak perlu query tambahan lintas hari.
   */
  const petakanTransfer = (baris) => baris.map((b) => ({
    jenis: 'Transfer',
    kode: b.kode,
    silo: b.silo_name,
    waktu: b.waktu,
    dikerjakanOleh: b.operator_nama,
    diperiksaOleh: b.approver_nama,
    disetujuiPada: b.approved_at,
    status: b.status_approval,
    detail: {
      jenis: b.transfer_type,
      siloAsal: b.silo_name,
      tankTujuan: b.tank_name,
      batch: b.batch,
      volume: Number(b.vol_ltr),
    },
  }));

  const petakanReceiving = (baris) => baris.map((b) => ({
    jenis: 'Receiving',
    kode: b.kode,
    silo: b.silo_name,
    waktu: b.waktu,
    dikerjakanOleh: b.operator_nama,
    diperiksaOleh: b.approver_nama,
    disetujuiPada: b.approved_at,
    status: b.status_approval,
    detail: {
      supplier: b.supplier_name,
      qtyKg: Number(b.qty_kg),
      beratJenis: Number(b.berat_jenis),
      qtyLtr: Number(b.qty_ltr),
      nilaiTs: Number(b.nilai_ts),
    },
  }));

  const petakanPrepast = (baris) => baris.map((b) => ({
    jenis: 'Prepast',
    kode: b.kode,
    silo: b.silo_name,
    waktu: b.waktu,
    dikerjakanOleh: b.operator_nama,
    diperiksaOleh: b.approver_nama,
    disetujuiPada: b.approved_at,
    status: b.status_approval,
    detail: {
      jenisBatch: b.jenis_batch,
      supplier: b.supplier_name,
      volume: Number(b.vol_prepast_ltr),
      flowrate: Number(b.flowrate_pst),
      tempAfterHeater: Number(b.temp_after_heater),
      tempOutput: Number(b.temp_output_prd),
      nilaiTs: Number(b.nilai_ts),
      receivingKode: b.receiving_kode,
    },
  }));

  const riwayat = [
    ...petakanReceiving(receiving),
    ...petakanPrepast(prepast),
    ...petakanMonitoring(monitoring),
    ...petakanTransfer(transfer),
  ].sort((a, b) => new Date(a.waktu) - new Date(b.waktu));

  /*
   * Breakdown per approver - record yang belum disetujui (diperiksaOleh
   * kosong) tidak ikut, sama seperti daftar nama diperiksaOleh di bawah.
   * Dikelompokkan per nama DULU (sebelum menggabung batch bersama), supaya
   * baris yang kebetulan disetujui orang berbeda tidak pernah tergabung.
   */
  const perApprover = new Map();
  for (const r of riwayat) {
    if (!r.diperiksaOleh) continue;
    if (!perApprover.has(r.diperiksaOleh)) perApprover.set(r.diperiksaOleh, []);
    perApprover.get(r.diperiksaOleh).push(r);
  }

  /*
   * Transfer yang berbagi tank+batch+waktu (batch bersama) digabung jadi
   * SATU kartu, bukan satu kartu per baris yang saling menyebut satu sama
   * lain - diminta langsung karena dua kartu silang-referensi seperti itu
   * membingungkan dibaca (2026-09-18).
   */
  function gabungkanBatchBersama(itemSatuApprover) {
    const lainnya = itemSatuApprover.filter((r) => r.jenis !== 'Transfer');
    const transferSaja = itemSatuApprover.filter((r) => r.jenis === 'Transfer');

    const kunciBatch = (t) => `${t.detail.tankTujuan}|${t.detail.batch}|${new Date(t.waktu).getTime()}`;
    const kelompok = new Map();
    for (const t of transferSaja) {
      const k = kunciBatch(t);
      if (!kelompok.has(k)) kelompok.set(k, []);
      kelompok.get(k).push(t);
    }

    const transferGabungan = [...kelompok.values()].map((grup) => {
      const [pertama] = grup;
      const disetujuiPadaTerakhir = [...grup]
        .sort((a, b) => new Date(b.disetujuiPada) - new Date(a.disetujuiPada))[0].disetujuiPada;
      return {
        kode: grup.map((g) => g.kode).join(', '),
        jenis: 'Transfer',
        silo: [...new Set(grup.map((g) => g.silo))].join(', '),
        waktu: pertama.waktu,
        disetujuiPada: disetujuiPadaTerakhir,
        detail: {
          jenis: pertama.detail.jenis,
          tankTujuan: pertama.detail.tankTujuan,
          batch: pertama.detail.batch,
          caraPengisian: grup.length > 1 ? 'Batch bersama' : 'Manual',
          volume: grup.reduce((jumlah, g) => jumlah + g.detail.volume, 0),
          baris: grup.map((g) => ({ kode: g.kode, siloAsal: g.detail.siloAsal, volume: g.detail.volume })),
        },
      };
    });

    return [...lainnya, ...transferGabungan]
      .sort((a, b) => new Date(a.disetujuiPada) - new Date(b.disetujuiPada));
  }

  const breakdownApproval = [...perApprover.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([nama, itemMentah]) => {
      const item = gabungkanBatchBersama(itemMentah);
      return { nama, jumlah: item.length, item };
    });

  return {
    tanggal: tanggalIso,
    diperiksaOleh: [...new Set(riwayat.map((r) => r.diperiksaOleh).filter(Boolean))].sort(),
    breakdownApproval,
    riwayat,
  };
}
