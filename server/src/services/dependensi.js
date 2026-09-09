/**
 * Guard dependensi - BR-15
 *
 * Record yang punya turunan aktif tidak dapat diedit, di-void, maupun
 * direject. Turunannya harus ditangani lebih dulu.
 *
 * Di Power Apps guard ini memakai pencocokan substring pada JSON
 * (`Title in supplier_fifo`), sehingga PST-20260825-001 dianggap cocok
 * dengan PST-20260825-0011 (B-13). Di sini seluruhnya foreign key.
 *
 * Yang dikembalikan bukan sekadar "boleh atau tidak", melainkan POHON
 * turunannya: dialog peringatan di Power Apps hanya menampilkan daftar rata
 * dengan satu tombol Close, sehingga operator harus mencari sendiri tiap
 * record dan mem-void-nya satu per satu (WF-5).
 */

import { pool } from '../db/pool.js';

const DIABAIKAN = ['Rejected', 'REVISED', 'VOIDED'];

/**
 * Prepast turunan dari suatu penerimaan.
 * Pengembalian tidak pernah punya induk penerimaan, jadi tidak ikut terjaring.
 */
async function anakReceiving(conn, id) {
  const [baris] = await conn.query(
    `SELECT p.id, p.kode, p.vol_prepast_ltr AS volume_ltr, p.status_approval,
            p.jenis_batch, s.silo_name AS lokasi
       FROM prepast_record p
       JOIN silo s ON s.id = p.silo_tujuan_id
      WHERE p.receiving_id = ?
        AND p.status_approval NOT IN (?, ?, ?)
      ORDER BY p.prepast_finish ASC, p.id ASC`,
    [id, ...DIABAIKAN],
  );
  return baris;
}

/**
 * Transfer yang mengambil dari suatu batch prepast.
 *
 * Lewat tabel `transfer_allocation`, bukan substring JSON. Selain benar,
 * ia juga membawa berapa liter yang diambil, sehingga dampaknya terlihat.
 */
async function anakPrepast(conn, id) {
  const [baris] = await conn.query(
    `SELECT t.id, t.kode, ta.qty_allocated AS volume_ltr, t.status_approval,
            t.transfer_type AS jenis_batch, t.batch AS batch,
            COALESCE(st.silo_name, tk.tank_name) AS lokasi
       FROM transfer_allocation ta
       JOIN transfer t          ON t.id = ta.transfer_id
       LEFT JOIN silo st        ON st.id = t.silo_tujuan_id
       LEFT JOIN tank_master tk ON tk.id = t.tank_id
      WHERE ta.prepast_id = ?
        AND t.status_approval NOT IN (?, ?, ?)
      ORDER BY t.trf_time ASC, t.id ASC`,
    [id, ...DIABAIKAN],
  );
  return baris;
}

/** Prepast anak yang lahir dari transfer PINDAH SILO (BR-14). */
async function anakTransfer(conn, id) {
  const [baris] = await conn.query(
    `SELECT p.id, p.kode, p.vol_prepast_ltr AS volume_ltr, p.status_approval,
            p.jenis_batch, s.silo_name AS lokasi
       FROM prepast_record p
       JOIN silo s ON s.id = p.silo_tujuan_id
      WHERE p.transfer_ref_id = ?
        AND p.jenis_batch = 'PREPAST'
        AND p.status_approval NOT IN (?, ?, ?)
      ORDER BY p.id ASC`,
    [id, ...DIABAIKAN],
  );
  return baris;
}

const PENELUSUR = {
  receiving: { anak: anakReceiving, modulAnak: 'prepast' },
  prepast: { anak: anakPrepast, modulAnak: 'transfer' },
  pengembalian: { anak: anakPrepast, modulAnak: 'transfer' },
  transfer: { anak: anakTransfer, modulAnak: 'prepast' },
  monitoring: { anak: async () => [], modulAnak: null },
};

/**
 * Menelusuri seluruh turunan sebagai POHON, bukan daftar rata.
 *
 * Kedalaman dibatasi agar rantai melingkar akibat data rusak tidak membuat
 * penelusuran berputar tanpa henti.
 *
 * @returns {Promise<Array>} simpul turunan, tiap simpul berisi `anak`
 */
export async function pohonDependensi(modul, id, { conn = pool, kedalaman = 0 } = {}) {
  if (kedalaman > 5) return [];

  const penelusur = PENELUSUR[modul];
  if (!penelusur) return [];

  const anak = await penelusur.anak(conn, id);

  return Promise.all(
    anak.map(async (a) => ({
      modul: penelusur.modulAnak,
      id: a.id,
      kode: a.kode,
      volumeLtr: Number(a.volume_ltr),
      statusApproval: a.status_approval,
      jenis: a.jenis_batch,
      lokasi: a.lokasi,
      batch: a.batch ?? null,
      anak: await pohonDependensi(penelusur.modulAnak, a.id, {
        conn,
        kedalaman: kedalaman + 1,
      }),
    })),
  );
}

/** Meratakan pohon menjadi urutan DAUN LEBIH DULU, siap untuk cascade void. */
export function ratakanDaunDuluan(pohon) {
  const hasil = [];
  const jelajah = (simpul) => {
    for (const s of simpul) {
      jelajah(s.anak);
      hasil.push({ modul: s.modul, id: s.id, kode: s.kode, volumeLtr: s.volumeLtr });
    }
  };
  jelajah(pohon);
  return hasil;
}

/** Jumlah seluruh turunan pada pohon. */
export function hitungTurunan(pohon) {
  return pohon.reduce((n, s) => n + 1 + hitungTurunan(s.anak), 0);
}

/**
 * Memeriksa apakah suatu record boleh disentuh.
 *
 * @returns {Promise<{boleh: boolean, pohon: Array, jumlah: number}>}
 */
export async function periksa(modul, id, { conn = pool } = {}) {
  const pohon = await pohonDependensi(modul, id, { conn });
  const jumlah = hitungTurunan(pohon);
  return { boleh: jumlah === 0, pohon, jumlah };
}
