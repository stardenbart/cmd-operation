/**
 * Layanan Transfer — FR-6
 *
 * Bagian paling berisiko di seluruh sistem (jalur kritis E.9). Di sinilah
 * alokasi FIFO benar-benar terpakai, dan di sinilah dua kelemahan terbesar
 * Power Apps diperbaiki:
 *
 *   M-1  Tidak ada transaksi. Submit transfer di sana adalah 1 insert +
 *        N update berurutan; gagal di tengah meninggalkan stok salah permanen.
 *   M-5  Tidak ada penguncian. Dua operator yang menyubmit transfer dari silo
 *        yang sama tidak saling melihat, sehingga volume yang sama dapat
 *        dialokasikan dua kali.
 *
 * Keduanya ditutup oleh satu transaksi dengan SELECT ... FOR UPDATE.
 */

import { pool, withTransaction } from '../db/pool.js';
import { allocateFifo } from './fifo.js';
import { terbitkanId } from './idGenerator.js';
import { catatAudit } from './audit.js';
import { putuskanAnchor } from './anchorTransfer.js';
import { batchUntukTank, batchPindahSilo } from './batch.js';
import { selisihMenit } from './waktu.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';

const STATUS_DIABAIKAN = ['Rejected', 'REVISED', 'VOIDED'];

/**
 * Membaca batch prepast aktif di suatu silo, urut FIFO.
 *
 * @param {*} conn koneksi; berikan transaksi + kunci=true saat akan menulis
 * @param {boolean} kunci pasang SELECT ... FOR UPDATE
 */
async function batchFifo(conn, siloId, { kunci = false } = {}) {
  const [baris] = await conn.query(
    `SELECT p.id, p.kode, p.supplier_id, p.qty_remaining_ltr, p.prepast_finish,
            p.jenis_batch, sup.supplier_name
       FROM prepast_record p
       LEFT JOIN supplier sup ON sup.id = p.supplier_id
      WHERE p.silo_tujuan_id = ?
        AND p.status_fifo = 'ACTIVE'
        AND p.qty_remaining_ltr > 0
        AND p.status_approval NOT IN (?, ?, ?)
      ORDER BY p.prepast_finish ASC, p.id ASC
      ${kunci ? 'FOR UPDATE' : ''}`,
    [siloId, ...STATUS_DIABAIKAN],
  );

  return baris.map((b) => ({
    id: b.id,
    kode: b.kode,
    supplierId: b.supplier_id,
    // NULL berarti asal tidak diketahui (pengembalian, BR-25).
    // Diteruskan apa adanya; lapis tampilan yang memberinya label.
    supplierName: b.supplier_name,
    jenisBatch: b.jenis_batch,
    qtyRemainingLtr: Number(b.qty_remaining_ltr),
    prepastFinish: b.prepast_finish,
  }));
}

/**
 * Pratinjau alokasi FIFO — FR-6.3.
 *
 * Hanya membaca; tidak mengunci apa pun. Pratinjau memang boleh sedikit
 * usang — yang penting alokasi SESUNGGUHNYA dihitung ulang di dalam
 * transaksi bersama kunci baris saat submit.
 */
export async function pratinjauFifo(siloId, volumeLtr) {
  const batches = await batchFifo(pool, siloId);
  const volAktual = batches.reduce((s, b) => s + b.qtyRemainingLtr, 0);

  if (!volumeLtr) {
    return { volAktualLtr: volAktual, batches, alokasi: null };
  }

  const hasil = allocateFifo(batches, volumeLtr);
  return {
    volAktualLtr: volAktual,
    batches,
    alokasi: hasil.allocations,
    totalTeralokasi: hasil.totalAllocated,
    takTeralokasi: hasil.unallocated,
    lengkap: hasil.isFullyAllocated,
  };
}

/** Daftar tank aktif - untuk filter Data Transfer dan pemilih tujuan. */
export async function daftarTank() {
  const [tanks] = await pool.query(
    'SELECT id, tank_name FROM tank_master WHERE is_active = TRUE ORDER BY urutan',
  );
  return tanks;
}

/** Konteks form transfer: silo asal, batch FIFO, tank & silo tujuan. */
export async function konteksForm(siloAsalId) {
  const [asal] = await pool.query(
    'SELECT * FROM v_silo_volume WHERE silo_id = ?', [siloAsalId],
  );
  if (!asal[0]) throw new NotFoundError('Silo asal');

  const [tanks] = await pool.query(
    `SELECT id, tank_name, qr_value, cmd_destination, aturan_batch
       FROM tank_master WHERE is_active = TRUE ORDER BY urutan`,
  );
  const [siloTujuan] = await pool.query(
    `SELECT silo_id, kode, silo_name, vol_tersedia_ltr, vol_tersedia_toleransi_ltr
       FROM v_silo_volume
      WHERE is_buffer = FALSE AND silo_id <> ?
      ORDER BY urutan`,
    [siloAsalId],
  );
  const [prefiks] = await pool.query(
    'SELECT kode, label, is_standar FROM batch_prefix WHERE is_active = TRUE ORDER BY urutan',
  );

  return {
    siloAsal: asal[0],
    fifo: await batchFifo(pool, siloAsalId),
    tanks,
    siloTujuan,
    prefiksBatch: prefiks,
  };
}

/**
 * Menyubmit transfer.
 *
 * Seluruhnya satu transaksi: kunci batch → hitung FIFO → simpan transfer →
 * simpan alokasi → kurangi tiap batch → urus anchor → (PINDAH SILO) buat
 * prepast anak. Gagal di titik mana pun berarti tidak ada yang tersimpan.
 */
export async function buat(masukan, aktor, ip) {
  return withTransaction((conn) => buatDalam(conn, masukan, aktor, ip));
}

/**
 * Beberapa transfer dalam SATU transaksi - FR-6 multi-baris.
 *
 * Operator kerap memindahkan susu ke beberapa MT dari silo yang berbeda.
 * Mode SAMA memakai satu waktu bersama, sedangkan mode MANUAL menyimpan waktu
 * masing-masing baris. Semua baris disimpan atomik - gagal satu baris berarti
 * tidak ada yang tersimpan (M-1). Karena satu transaksi, kunci FOR UPDATE tetap
 * terpegang sehingga baris berikutnya membaca sisa FIFO yang sudah dikurangi
 * baris sebelumnya bila kebetulan menyentuh silo yang sama.
 */
export async function buatBanyak({
  trfTime,
  isDraft = false,
  modeBatch = 'MANUAL',
  batchBersama,
  baris,
}, aktor, ip) {
  if (!Array.isArray(baris) || baris.length === 0) {
    throw new BusinessError('FR-6', 'Minimal satu baris transfer harus diisi');
  }
  if (!['SAMA', 'MANUAL'].includes(modeBatch)) {
    throw new BusinessError('VALIDATION_ERROR', `Mode batch tidak dikenal: ${modeBatch}`);
  }

  const punyaWaktu = (nilai) => nilai !== undefined && nilai !== null && nilai !== '';
  const adaWaktuPerBaris = modeBatch === 'MANUAL' && baris.some((b) => punyaWaktu(b.trfTime));
  const waktuEfektif = baris.map((b, index) => {
    // Fallback ke waktu request mempertahankan kontrak klien lama yang belum
    // mengirim modeBatch maupun trfTime pada tiap baris.
    const nilai = modeBatch === 'SAMA' || !adaWaktuPerBaris ? trfTime : b.trfTime;
    if (!punyaWaktu(nilai) && !isDraft) {
      throw new BusinessError(
        'TRANSFER_TIME_REQUIRED',
        `Waktu transfer wajib diisi pada Transfer ${index + 1}`,
        { baris: index + 1 },
      );
    }
    if (punyaWaktu(nilai) && Number.isNaN(new Date(nilai).getTime())) {
      throw new BusinessError(
        'VALIDATION_ERROR',
        `Waktu transfer pada Transfer ${index + 1} tidak valid`,
        { baris: index + 1 },
      );
    }
    return nilai;
  });

  // Untuk silo yang sama, urutan input juga merupakan urutan alokasi FIFO dan
  // perubahan anchor. Karena itu waktunya tidak boleh mundur antarbaris.
  const waktuTerakhirPerSilo = new Map();
  baris.forEach((b, index) => {
    if (!punyaWaktu(waktuEfektif[index])) return;
    const saatIni = new Date(waktuEfektif[index]).getTime();
    const sebelumnya = waktuTerakhirPerSilo.get(b.siloAsalId);
    if (sebelumnya !== undefined && saatIni < sebelumnya) {
      throw new BusinessError(
        'TRANSFER_TIME_ORDER',
        `Waktu Transfer ${index + 1} tidak boleh lebih awal dari transfer sebelumnya pada silo yang sama`,
        { baris: index + 1, siloAsalId: b.siloAsalId },
      );
    }
    waktuTerakhirPerSilo.set(b.siloAsalId, saatIni);
  });

  return withTransaction(async (conn) => {
    const transfers = [];
    for (const [index, b] of baris.entries()) {
      // Mode SAMA ditegakkan kembali di server agar seluruh tank beraturan
      // PILIH benar-benar memakai sumber batch yang sama. Tank CMD2,
      // TANPA_BATCH, dan PINDAH SILO tetap mengabaikan nilai ini di buatDalam.
      const nilaiBatch = modeBatch === 'SAMA'
        ? {
          batchPrefix: batchBersama?.batchPrefix,
          batchNomor: batchBersama?.batchNomor,
        }
        : {
          batchPrefix: b.batchPrefix,
          batchNomor: b.batchNomor,
        };

      transfers.push(await buatDalam(
        conn,
        { ...b, ...nilaiBatch, trfTime: waktuEfektif[index], isDraft },
        aktor,
        ip,
      ));
    }
    return { transfers };
  });
}

async function buatDalam(conn, masukan, aktor, ip) {
  const {
    siloAsalId, jenis, volumeLtr, trfTime,
    tankId, siloTujuanId,
    batchPrefix, batchNomor,
    isDraft = false,
  } = masukan;

  const draft = isDraft || !trfTime;

  {
    // ---- Silo asal, dikunci ----
    const [asalBaris] = await conn.query(
      'SELECT id, kode, silo_name, is_buffer, standing_time_anchor FROM silo WHERE id = ? FOR UPDATE',
      [siloAsalId],
    );
    const asal = asalBaris[0];
    if (!asal) throw new NotFoundError('Silo asal');

    // ---- Tujuan ----
    let tank = null;
    let siloTujuan = null;

    if (jenis === 'PEMAKAIAN PRODUKSI') {
      const [t] = await conn.query(
        `SELECT id, tank_name, cmd_destination, aturan_batch
           FROM tank_master WHERE id = ? AND is_active = TRUE`,
        [tankId],
      );
      tank = t[0];
      if (!tank) throw new NotFoundError('Tank tujuan');
    } else {
      // Kunci BARIS SILO, bukan view.
      //
      // Mengunci v_silo_volume ditolak MySQL ("SELECT with locking clause
      // command denied ... for table 'v_silo_volume'") dan memang tidak
      // bermakna: view adalah hasil agregasi, bukan baris yang dapat dikunci.
      // Kunci pada baris silo sudah cukup — ia yang menyerialkan transfer
      // bersamaan menuju silo yang sama.
      const [s] = await conn.query(
        `SELECT id, kode, silo_name, is_buffer, standing_time_anchor, toleransi_ltr, toleransi_aktif
           FROM silo WHERE id = ? FOR UPDATE`,
        [siloTujuanId],
      );
      siloTujuan = s[0];
      if (!siloTujuan) throw new NotFoundError('Silo tujuan');

      // Volume tersisa dibaca terpisah, tanpa kunci — konsistensinya sudah
      // dijamin oleh kunci baris silo di atas dan kunci baris prepast di bawah.
      const [v] = await conn.query(
        `SELECT vol_tersedia_ltr, vol_tersedia_toleransi_ltr
           FROM v_silo_volume WHERE silo_id = ?`,
        [siloTujuanId],
      );
      siloTujuan.vol_tersedia_ltr = v[0]?.vol_tersedia_ltr ?? 0;
      siloTujuan.vol_tersedia_toleransi_ltr = v[0]?.vol_tersedia_toleransi_ltr ?? 0;

      // BR-17 — dua penjagaan yang di Power Apps hanya ada di layar pemindai,
      // sehingga jalur non-pemindai melewatinya.
      if (siloTujuan.id === asal.id) {
        throw new BusinessError('BR-17', 'Silo tujuan tidak boleh sama dengan silo asal');
      }
      if (siloTujuan.is_buffer) {
        throw new BusinessError('BR-17', 'Tidak dapat transfer ke buffer');
      }
    }

    let melampauiNominalTujuan = null;

    // ---- Alokasi FIFO, atas baris yang DIKUNCI (M-5) ----
    const batches = await batchFifo(conn, siloAsalId, { kunci: true });
    const volAktual = batches.reduce((s, b) => s + b.qtyRemainingLtr, 0);

    if (volAktual <= 0) {
      throw new BusinessError('BR-07', `Silo ${asal.silo_name} kosong, tidak ada yang dapat ditransfer`);
    }

    let alokasi;
    try {
      alokasi = allocateFifo(batches, volumeLtr);
    } catch (err) {
      throw new BusinessError('BR-07', err.message);
    }

    // BR-05 — alokasi harus tuntas
    if (!alokasi.isFullyAllocated) {
      throw new BusinessError(
        'BR-05',
        `Volume transfer ${volumeLtr} L melebihi volume aktual silo ${volAktual} L`,
        { volAktualLtr: volAktual, takTeralokasi: alokasi.unallocated },
      );
    }

    // ---- Kapasitas silo TUJUAN pada PINDAH SILO (FR-29.7, BR-24) ----
    //
    // Celah yang tidak ditutup Power Apps: PINDAH SILO menambah volume ke silo
    // tujuan, tetapi kapasitas tujuan tidak pernah diperiksa — sehingga silo
    // dapat terisi melampaui kapasitas fisiknya tanpa peringatan apa pun.
    //
    // KEPUTUSAN OPERASIONAL (dikonfirmasi pengguna, September 2026): batas
    // keras (kapasitas + toleransi) TIDAK LAGI memblokir Pindah Silo. Silo
    // produksi kadang perlu menampung lebih dari angka nominalnya, dan
    // penolakan keras di titik ini pernah membuat operator terhambat mencatat
    // susu yang secara fisik sudah ada di silo. Kapasitas nominal sekarang
    // murni informasi/peringatan — bukan pembatas input — untuk Pindah Silo.
    // Prepast (pecahanSilo.js) TIDAK ikut berubah; batas kerasnya tetap
    // ditegakkan di sana.
    if (jenis === 'PINDAH SILO') {
      const sisaNominal = Number(siloTujuan.vol_tersedia_ltr ?? 0);
      const sisaBatasKeras = Number(siloTujuan.vol_tersedia_toleransi_ltr ?? 0);
      if (volumeLtr > sisaNominal) {
        melampauiNominalTujuan = {
          siloName: siloTujuan.silo_name,
          sisaNominalLtr: sisaNominal,
          kelebihanLtr: Number((volumeLtr - sisaNominal).toFixed(2)),
          // Beda dari sekadar "lewat nominal, masih dalam toleransi" (kondisi
          // lama yang sudah sah) — ini sungguh melampaui bahkan batas keras.
          melebihiBatasKeras: volumeLtr > sisaBatasKeras,
          batasKerasLtr: sisaBatasKeras,
        };
      }
    }

    // ---- Batch (BR-21) ----
    //
    // Aturannya datang dari TANGKINYA, bukan dari yang dikirim klien. Kalau
    // aturannya menuntut prefiks dan prefiksnya tidak ada, yang muncul harus
    // BusinessError yang menyebut sebabnya - bukan TypeError yang berubah
    // menjadi galat 500 di hadapan operator.
    let batch;
    if (jenis === 'PINDAH SILO') {
      batch = batchPindahSilo(siloTujuan.silo_name);
    } else {
      try {
        batch = batchUntukTank(tank.aturan_batch, batchPrefix, batchNomor);
      } catch (err) {
        throw new BusinessError('BR-21', `${err.message} (tangki ${tank.tank_name})`);
      }
    }

    // ---- Anchor standing time (BR-09) ----
    const keputusan = putuskanAnchor({
      jenis,
      volAktualAsal: volAktual,
      volTransfer: volumeLtr,
      anchorAsal: asal.standing_time_anchor ?? null,
      anchorTujuan: siloTujuan?.standing_time_anchor ?? null,
      waktuTransfer: draft ? new Date() : trfTime,
    });

    const standingMenit = draft
      ? null
      : selisihMenit(asal.standing_time_anchor ?? null, trfTime);

    // ---- Simpan transfer ----
    const kode = await terbitkanId(conn, 'TRF');
    const [hasilTrf] = await conn.query(
      `INSERT INTO transfer
         (kode, transfer_type, silo_asal_id, tank_id, silo_tujuan_id,
          vol_ltr, vol_akt_silo_ltr, melampaui_kapasitas, batch, trf_time,
          standing_time_menit,
          anchor_asal_sebelum, anchor_tujuan_diset,
          operator_id, status_approval, cmd_destination, is_gantung)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending Approval', ?, ?)`,
      [
        kode, jenis, siloAsalId,
        tank?.id ?? null, siloTujuan?.id ?? null,
        volumeLtr, volAktual,
        // Dicatat sebagai jejak permanen — lihat migrasi 027 — karena batas
        // keras Pindah Silo tidak lagi memblokir input (keputusan operasional).
        Boolean(melampauiNominalTujuan?.melebihiBatasKeras),
        batch,
        draft ? null : trfTime,
        standingMenit,
        // Anchor lama direkam agar void dapat memulihkannya. Menghitung ulang
        // dari batch tertua akan memuda-kan susu yang anchornya diwarisi
        // lewat pindah silo (lihat 009_anchor_reversal.sql).
        keputusan.resetAnchorAsal ? asal.standing_time_anchor : null,
        Boolean(keputusan.anchorTujuanBaru),
        aktor.id,
        // BR-18 — CMD2 hanya bila tank tujuannya CMD 2
        tank?.cmd_destination ?? 'CMD1',
        draft,
      ],
    );
    const transferId = hasilTrf.insertId;

    // ---- Alokasi ternormalisasi, menggantikan JSON supplier_fifo (M-6) ----
    for (const a of alokasi.allocations) {
      await conn.query(
        `INSERT INTO transfer_allocation
           (transfer_id, prepast_id, supplier_id, qty_available, qty_allocated,
            qty_after, urutan_fifo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [transferId, a.prepastId, a.supplierId, a.qtyAvailable,
          a.qtyAllocated, a.qtyAfter, a.urutanFifo],
      );

      // FR-6.5 — kurangi sisa batch; tutup bila habis (BR-08)
      await conn.query(
        `UPDATE prepast_record
            SET qty_remaining_ltr = ?, status_fifo = ?
          WHERE id = ?`,
        [a.qtyAfter, a.willClose ? 'CLOSED' : 'ACTIVE', a.prepastId],
      );
    }

    // ---- Anchor ----
    if (keputusan.resetAnchorAsal) {
      await conn.query('UPDATE silo SET standing_time_anchor = NULL WHERE id = ?', [asal.id]);
    }
    if (keputusan.anchorTujuanBaru) {
      await conn.query(
        'UPDATE silo SET standing_time_anchor = ? WHERE id = ? AND standing_time_anchor IS NULL',
        [keputusan.anchorTujuanBaru, siloTujuan.id],
      );
    }

    // ---- PINDAH SILO: prepast anak di silo tujuan (BR-10) ----
    const anak = [];
    if (jenis === 'PINDAH SILO') {
      for (const a of alokasi.allocations) {
        const kodeAnak = await terbitkanId(conn, 'PST');
        const [h] = await conn.query(
          `INSERT INTO prepast_record
             (kode, receiving_id, parent_prepast_id, supplier_id, silo_tujuan_id,
              vol_prepast_ltr, qty_remaining_ltr, prepast_start, prepast_finish,
              flowrate_pst, temp_after_heater, temp_output_prd,
              operator_id, status_approval, status_fifo, cmd_source,
              transfer_ref_id)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?,
                   'Pending Approval', 'ACTIVE', 'CMD1', ?)`,
          [
            kodeAnak, a.prepastId, a.supplierId, siloTujuan.id,
            a.qtyAllocated, a.qtyAllocated,
            draft ? null : trfTime, draft ? null : trfTime,
            aktor.id, transferId,
          ],
        );
        anak.push({ id: h.insertId, kode: kodeAnak, supplierId: a.supplierId, volumeLtr: a.qtyAllocated });
      }
    }

    await catatAudit(conn, {
      entity: 'transfer', entityId: transferId, action: 'CREATE',
      actorId: aktor.id,
      after: {
        kode, jenis, batch, volumeLtr,
        volAktualSebelum: volAktual,
        alokasi: alokasi.allocations,
        anchorDireset: keputusan.resetAnchorAsal,
        transferPenuh: keputusan.transferPenuh,
        anakPindahSilo: anak,
        draft,
      },
      ip,
    });

    return {
      id: transferId, kode, jenis, batch,
      volumeLtr, volAktualSebelumLtr: volAktual,
      alokasi: alokasi.allocations,
      standingTimeMenit: standingMenit,
      transferPenuh: keputusan.transferPenuh,
      anchorAsalDireset: keputusan.resetAnchorAsal,
      anchorTujuanDiset: keputusan.anchorTujuanBaru,
      anakPindahSilo: anak,
      melampauiNominalTujuan,
      draft,
    };
  }
}

export async function ambil(id) {
  const [baris] = await pool.query(
    `SELECT t.*, sa.silo_name AS silo_asal_nama, st.silo_name AS silo_tujuan_nama,
            tk.tank_name, o.nama_lengkap AS operator_nama
       FROM transfer t
       JOIN silo sa ON sa.id = t.silo_asal_id
       LEFT JOIN silo st ON st.id = t.silo_tujuan_id
       LEFT JOIN tank_master tk ON tk.id = t.tank_id
       JOIN operator o ON o.id = t.operator_id
      WHERE t.id = ?`,
    [id],
  );
  if (!baris[0]) throw new NotFoundError('Transfer');

  const [alokasi] = await pool.query(
    `SELECT ta.*, p.kode AS prepast_kode, sup.supplier_name
       FROM transfer_allocation ta
       JOIN prepast_record p ON p.id = ta.prepast_id
       LEFT JOIN supplier sup ON sup.id = ta.supplier_id
      WHERE ta.transfer_id = ?
      ORDER BY ta.urutan_fifo`,
    [id],
  );

  return { ...baris[0], alokasi };
}

export async function daftar({ halaman = 1, perHalaman = 25, status, siloAsalId, jenis }) {
  const syarat = [];
  const nilai = [];
  if (status) { syarat.push('t.status_approval = ?'); nilai.push(status); }
  if (siloAsalId) { syarat.push('t.silo_asal_id = ?'); nilai.push(siloAsalId); }
  if (jenis) { syarat.push('t.transfer_type = ?'); nilai.push(jenis); }

  const where = syarat.length ? `WHERE ${syarat.join(' AND ')}` : '';
  const offset = (halaman - 1) * perHalaman;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM transfer t ${where}`, nilai,
  );
  const [baris] = await pool.query(
    `SELECT t.id, t.kode, t.transfer_type, t.vol_ltr, t.batch, t.trf_time,
            t.standing_time_menit, t.status_approval, t.cmd_destination, t.is_gantung,
            sa.silo_name AS silo_asal_nama,
            COALESCE(st.silo_name, tk.tank_name) AS tujuan
       FROM transfer t
       JOIN silo sa ON sa.id = t.silo_asal_id
       LEFT JOIN silo st ON st.id = t.silo_tujuan_id
       LEFT JOIN tank_master tk ON tk.id = t.tank_id
       ${where}
      ORDER BY t.trf_time DESC, t.id DESC
      LIMIT ? OFFSET ?`,
    [...nilai, perHalaman, offset],
  );
  return { data: baris, total, halaman, perHalaman };
}
