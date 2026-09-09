/**
 * Layanan Pengembalian - BR-25, FR-31
 *
 * Susu yang sudah ditransfer keluar dikembalikan ke silo. Komposisi
 * suppliernya tidak diketahui: di tank maupun jalur pipa, susu dari beberapa
 * supplier sudah tercampur dan tidak dapat dipisahkan lagi.
 *
 * Peristiwa ini memutus rantai telusur, dan sistem memperlakukan pemutusan
 * itu sebagai fakta yang harus terlihat, bukan sebagai lubang yang ditambal
 * dengan tebakan.
 */

import { pool, withTransaction } from '../db/pool.js';
import { terbitkanId } from './idGenerator.js';
import { catatAudit } from './audit.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';

/**
 * Transfer keluar yang belum lama, sebagai pilihan asal pengembalian.
 *
 * Menautkan pengembalian ke transfer asalnya TIDAK memulihkan komposisi
 * supplier: yang kembali adalah campuran, dan memecahnya kembali secara
 * proporsional hanya akan menghasilkan angka yang tampak pasti padahal
 * tebakan. Tautan ini berguna untuk hal lain: ia memberi tahu KAPAN susu
 * itu meninggalkan silo, yang menentukan usianya.
 */
export async function transferTerkini(siloId, { hari = 3 } = {}) {
  const [baris] = await pool.query(
    `SELECT t.id, t.kode, t.transfer_type, t.vol_ltr, t.batch, t.trf_time,
            COALESCE(st.silo_name, tk.tank_name) AS tujuan
       FROM transfer t
       LEFT JOIN silo st        ON st.id = t.silo_tujuan_id
       LEFT JOIN tank_master tk ON tk.id = t.tank_id
      WHERE t.silo_asal_id = ?
        AND t.trf_time IS NOT NULL
        AND t.trf_time >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)
        AND t.status_approval NOT IN ('Rejected','REVISED','VOIDED')
      ORDER BY t.trf_time DESC
      LIMIT 20`,
    [siloId, hari],
  );
  return baris;
}

/**
 * Konteks form: silo tujuan, dengan yang KOSONG didahulukan.
 *
 * Praktik di lapangan adalah memasukkan susu kembali ke silo kosong, supaya
 * ia tidak bercampur dengan susu yang ketertelusurannya masih utuh. Susu
 * tersebut kemudian dipakai langsung atau dibuang lewat pengosongan silo.
 *
 * Urutan daftar mengikuti praktik itu: silo kosong di atas. Silo yang sudah
 * berisi tetap boleh dipilih, tetapi disertai peringatan, karena memasukkan
 * volume tak tertelusuri ke sana akan menular ke seluruh isinya.
 */
export async function konteksForm() {
  const [silos] = await pool.query(
    `SELECT silo_id, kode, silo_name, vol_aktual_ltr, vol_tersedia_ltr,
            vol_tersedia_toleransi_ltr, vol_tak_dikenal_ltr, standing_time_anchor,
            vol_aktual_ltr = 0 AS kosong
       FROM v_silo_volume
      WHERE is_buffer = FALSE
      ORDER BY (vol_aktual_ltr = 0) DESC, urutan`,
  );
  return { silos };
}

/**
 * Mencatat pengembalian ke silo.
 *
 * @param {object} p
 * @param {number} p.siloId
 * @param {number} p.volumeLtr
 * @param {Date}   p.waktuKembali
 * @param {Date}   [p.waktuKeluar]    kapan susu ini meninggalkan silo
 * @param {number} [p.transferAsalId] transfer yang dikembalikan, bila diketahui
 * @param {string} [p.keteranganAsal] dari mana, bila tidak ada tautan transfer
 * @param {string} p.alasan           wajib: pengembalian adalah kejadian luar biasa
 */
export async function buat(
  {
    siloId, volumeLtr, waktuKembali, waktuKeluar = null,
    transferAsalId = null, keteranganAsal = null, alasan,
  },
  aktor,
  ip,
) {
  if (!alasan || !alasan.trim()) {
    throw new BusinessError(
      'BR-25',
      'Alasan pengembalian wajib diisi. Pengembalian adalah kejadian luar biasa yang harus dapat dipertanggungjawabkan.',
    );
  }

  return withTransaction(async (conn) => {
    const [siloBaris] = await conn.query(
      `SELECT id, kode, silo_name, is_buffer, standing_time_anchor
         FROM silo WHERE id = ? AND is_active = TRUE FOR UPDATE`,
      [siloId],
    );
    const silo = siloBaris[0];
    if (!silo) throw new NotFoundError('Silo tujuan');
    if (silo.is_buffer) {
      throw new BusinessError(
        'BR-02',
        'Pengembalian tidak dapat masuk ke buffer. Buffer hanya menerima penerimaan dari supplier.',
      );
    }

    // BR-24 - kapasitas diperiksa terhadap batas keras, sama seperti prepast
    const [volBaris] = await conn.query(
      `SELECT vol_aktual_ltr, vol_tersedia_ltr, vol_tersedia_toleransi_ltr
         FROM v_silo_volume WHERE silo_id = ?`,
      [siloId],
    );
    const sisaNominal = Number(volBaris[0] ? volBaris[0].vol_tersedia_ltr : 0);
    const sisaBatasKeras = Number(volBaris[0] ? volBaris[0].vol_tersedia_toleransi_ltr : 0);
    const volSebelum = Number(volBaris[0] ? volBaris[0].vol_aktual_ltr : 0);

    if (volumeLtr > sisaBatasKeras) {
      throw new BusinessError(
        'FR-29.7',
        `Volume ${volumeLtr} L melebihi kapasitas silo ${silo.silo_name} ` +
          `(sisa nominal ${sisaNominal} L, batas keras ${sisaBatasKeras} L)`,
        { sisaNominalLtr: sisaNominal, batasKerasLtr: sisaBatasKeras },
      );
    }

    // Transfer asal, bila ditautkan. Yang diambil BUKAN komposisi
    // suppliernya, melainkan waktunya: kapan susu ini meninggalkan silo.
    let transferAsal = null;
    if (transferAsalId) {
      const [t] = await conn.query(
        `SELECT id, kode, batch, trf_time, vol_ltr, silo_asal_id
           FROM transfer WHERE id = ?`,
        [transferAsalId],
      );
      transferAsal = t[0] || null;
      if (!transferAsal) throw new NotFoundError('Transfer asal');

      if (Number(volumeLtr) > Number(transferAsal.vol_ltr)) {
        throw new BusinessError(
          'BR-25',
          `Volume kembali ${volumeLtr} L melebihi volume transfer asalnya ` +
            `${transferAsal.vol_ltr} L`,
        );
      }
    }

    /**
     * Kunci urutan FIFO.
     *
     * Susu yang kembali BUKAN susu baru. Ia sudah dipasteurisasi lebih dulu,
     * keluar dari silo, dan berada di luar penyimpanan terkendali. Memberinya
     * waktu "sekarang" akan menempatkannya di BELAKANG antrean, sehingga ia
     * justru dipakai paling akhir: kebalikan dari yang benar, dan berbahaya
     * karena ia justru susu yang paling berisiko.
     *
     * Urutan sumber, dari yang paling dapat dipercaya:
     *   1. waktu transfer aslinya, bila transfernya ditautkan
     *   2. waktu keluar yang diisi operator; ia tahu kapan susu itu keluar
     *      meski tidak tahu suppliernya
     *   3. waktu kembali, sebagai upaya terakhir
     *
     * Sumber yang dipakai ikut dikembalikan supaya ketidakpastiannya
     * terlihat, bukan terkubur di dalam satu angka.
     */
    let kunciFifo;
    let sumberKunciFifo;
    if (transferAsal) {
      kunciFifo = transferAsal.trf_time;
      sumberKunciFifo = 'transfer_asal';
    } else if (waktuKeluar) {
      kunciFifo = waktuKeluar;
      sumberKunciFifo = 'waktu_keluar';
    } else {
      kunciFifo = waktuKembali;
      sumberKunciFifo = 'waktu_kembali';
    }

    const kode = await terbitkanId(conn, 'RTN');

    const [hasil] = await conn.query(
      `INSERT INTO prepast_record
         (kode, jenis_batch, receiving_id, supplier_id, silo_tujuan_id,
          vol_prepast_ltr, qty_remaining_ltr,
          prepast_start, prepast_finish,
          operator_id, status_approval, status_fifo, cmd_source,
          transfer_ref_id, alasan_kembali, keterangan_asal)
       VALUES (?, 'PENGEMBALIAN', NULL, NULL, ?, ?, ?, ?, ?, ?,
               'Pending Approval', 'ACTIVE', 'CMD1', ?, ?, ?)`,
      [
        kode, siloId, volumeLtr, volumeLtr,
        waktuKembali, kunciFifo,
        aktor.id, transferAsal ? transferAsal.id : null, alasan,
        keteranganAsal || (transferAsal ? `${transferAsal.kode} batch ${transferAsal.batch}` : null),
      ],
    );

    /**
     * Standing time (BR-09).
     *
     * Bila silo kosong, anchor diambil dari waktu transfer asal, BUKAN waktu
     * kembali. Susu ini sudah berdiri sejak ia meninggalkan silo; memakai
     * waktu kembali akan menampilkan "2 jam" untuk susu yang sesungguhnya
     * sudah sepuluh jam di luar. Standing time adalah indikator mutu, dan
     * indikator yang terlalu optimistis lebih berbahaya daripada tidak ada
     * indikator sama sekali.
     */
    const anchorBaru = kunciFifo;
    const anchorKosong = !silo.standing_time_anchor;
    if (anchorKosong) {
      await conn.query(
        'UPDATE silo SET standing_time_anchor = ? WHERE id = ? AND standing_time_anchor IS NULL',
        [anchorBaru, siloId],
      );
    }

    await catatAudit(conn, {
      entity: 'pengembalian',
      entityId: hasil.insertId,
      action: 'CREATE',
      actorId: aktor.id,
      after: {
        kode, siloId, siloName: silo.silo_name, volumeLtr,
        waktuKembali, kunciFifo,
        transferAsal: transferAsal ? transferAsal.kode : null,
        sumberKunciFifo,
        supplierDiketahui: false,
      },
      reason: alasan,
      ip,
    });

    return {
      id: hasil.insertId,
      kode,
      siloName: silo.silo_name,
      volumeLtr,
      kunciFifo,
      sumberKunciFifo,
      transferAsal: transferAsal
        ? { kode: transferAsal.kode, batch: transferAsal.batch, trfTime: transferAsal.trf_time }
        : null,
      anchorDiset: anchorKosong ? anchorBaru : null,
      // Tidak memblokir: silo terisi kadang memang satu-satunya pilihan.
      // Yang penting akibatnya disebutkan, bukan dibiarkan lewat diam-diam.
      siloSudahBerisi: volSebelum > 0
        ? { volSebelumLtr: volSebelum }
        : null,
      melampauiNominal: volumeLtr > sisaNominal
        ? { sisaNominalLtr: sisaNominal, kelebihanLtr: Number((volumeLtr - sisaNominal).toFixed(2)) }
        : null,
    };
  });
}

export async function daftar({ halaman = 1, perHalaman = 25, siloId }) {
  const syarat = ["p.jenis_batch = 'PENGEMBALIAN'"];
  const nilai = [];
  if (siloId) { syarat.push('p.silo_tujuan_id = ?'); nilai.push(siloId); }
  const where = `WHERE ${syarat.join(' AND ')}`;
  const offset = (halaman - 1) * perHalaman;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) total FROM prepast_record p ${where}`, nilai,
  );
  const [baris] = await pool.query(
    `SELECT p.id, p.kode, p.vol_prepast_ltr, p.qty_remaining_ltr,
            p.prepast_start AS waktu_kembali, p.prepast_finish AS kunci_fifo,
            p.status_approval, p.status_fifo, p.alasan_kembali, p.keterangan_asal,
            s.silo_name, t.kode AS transfer_asal_kode,
            o.nama_lengkap AS operator_nama
       FROM prepast_record p
       JOIN silo s          ON s.id = p.silo_tujuan_id
       LEFT JOIN transfer t ON t.id = p.transfer_ref_id
       JOIN operator o      ON o.id = p.operator_id
       ${where}
      ORDER BY p.prepast_start DESC, p.id DESC
      LIMIT ? OFFSET ?`,
    [...nilai, perHalaman, offset],
  );
  return { data: baris, total, halaman, perHalaman };
}
