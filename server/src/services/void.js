/**
 * Pembatalan record (void) - BR-13, BR-14, FR-17
 *
 * Void memutar balik volume ke hulu, bukan sekadar mengubah status. Karena
 * itu ia harus transaksional: gagal di tengah meninggalkan volume yang sudah
 * dikembalikan sebagian, yaitu keadaan yang tidak dapat dijelaskan dari data.
 *
 * Wewenang SPV semata (BR-22, D-7). Cascade void berjalan DAUN LEBIH DULU:
 * membatalkan induk sebelum turunannya akan meninggalkan volume yang berasal
 * dari sesuatu yang sudah dinyatakan tidak sah.
 */

import { withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { pohonDependensi, ratakanDaunDuluan, hitungTurunan } from './dependensi.js';
import { BusinessError, NotFoundError, ForbiddenError } from '../middleware/errors.js';
import { pastikanBerwenang, can, AKSI } from '../auth/permissions.js';

const TABEL = {
  receiving: 'receiving',
  prepast: 'prepast_record',
  pengembalian: 'prepast_record',
  transfer: 'transfer',
  monitoring: 'monitoring',
};

const BOLEH_DIVOID = ['Pending Approval', 'Approved', 'Rejected', 'Edit Requested'];

/**
 * Status yang masih boleh dibatalkan operator SENDIRI.
 *
 * Hanya yang belum pernah diputuskan siapa pun. `Approved` sengaja TIDAK ada
 * di sini: membatalkannya berarti menghapus keputusan mutu yang diambil orang
 * lain. `Rejected` juga tidak - ia sudah dinilai, dan jalur perbaikannya
 * adalah koreksi, bukan penghapusan.
 */
const BOLEH_DIVOID_SENDIRI = ['Pending Approval'];

/**
 * Menegakkan wewenang void, termasuk yang bersyarat.
 *
 * Diperiksa DI SINI, bukan hanya di middleware rute: syaratnya bergantung pada
 * ISI barisnya - siapa pemiliknya dan apa statusnya - dan middleware tidak
 * membaca baris. Pelajaran yang sama sudah pernah terjadi di modul ini: penjaga
 * yang hanya ada di satu lapis melindungi hanya pemanggil yang melewati lapis
 * itu.
 */
async function pastikanBolehVoid(conn, modul, id, aktor) {
  // Wewenang penuh: tidak perlu pemeriksaan tambahan.
  if (can(aktor?.role, AKSI.RECORD_VOID)) return;

  pastikanBerwenang(aktor, AKSI.RECORD_VOID_SENDIRI);

  const baris = await ambil(conn, modul, id);

  /*
   * Kepemilikan TIDAK lagi membatasi pembatalan.
   *
   * Keputusan governance yang dikonfirmasi pengguna: pembatalan boleh dilakukan
   * user mana pun, milik siapa pun, selama tercatat di audit (setiap void wajib
   * beralasan dan meninggalkan jejak). Yang MASIH dijaga hanya STATUS - record
   * yang sudah disetujui tetap urusan SPV, sebab membatalkannya menghapus
   * keputusan mutu yang sudah diambil, bukan sekadar memperbaiki salah ketik.
   */
  if (!BOLEH_DIVOID_SENDIRI.includes(baris.status_approval)) {
    throw new BusinessError(
      'BR-13',
      `${baris.kode} berstatus ${baris.status_approval} dan hanya dapat `
      + 'dibatalkan SPV. Yang sudah diputuskan tidak dibatalkan sendiri.',
    );
  }
}

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
 * Mengembalikan volume prepast ke batch penerimaan induknya - BR-13.
 *
 * Status induk dihitung ulang, bukan ditebak: batch yang tadinya COMPLETED
 * bisa kembali menjadi IN_PREPAST, dan yang sudah CLOSED kembali ACTIVE.
 */
async function pulihkanInduk(conn, prepast) {
  if (!prepast.receiving_id) return null;

  const [barisInduk] = await conn.query(
    'SELECT * FROM receiving WHERE id = ? FOR UPDATE',
    [prepast.receiving_id],
  );
  const induk = barisInduk[0];
  if (!induk) return null;

  const sisaBaru = Number(induk.qty_remaining_ltr) + Number(prepast.vol_prepast_ltr);
  const habis = sisaBaru >= Number(induk.qty_ltr);

  await conn.query(
    `UPDATE receiving
        SET qty_remaining_ltr = ?,
            buffer_status = ?,
            status_fifo = 'ACTIVE'
      WHERE id = ?`,
    [sisaBaru, habis ? 'IN_BUFFER' : 'IN_PREPAST', induk.id],
  );

  return { kode: induk.kode, sisaBaruLtr: sisaBaru };
}

/**
 * Mengembalikan alokasi transfer ke tiap batch prepast sumbernya - BR-13.
 *
 * Sumbernya tabel `transfer_allocation`, bukan JSON. Di Power Apps pemulihan
 * ini memakai `ParseJSON(varCorrectionSource.supplier_fifo)`, sehingga
 * bergantung pada teks yang bentuknya bisa berubah.
 */
async function pulihkanAlokasi(conn, transferId) {
  const [alokasi] = await conn.query(
    `SELECT ta.prepast_id, ta.qty_allocated, p.kode, p.vol_prepast_ltr
       FROM transfer_allocation ta
       JOIN prepast_record p ON p.id = ta.prepast_id
      WHERE ta.transfer_id = ?
      ORDER BY ta.urutan_fifo`,
    [transferId],
  );

  const dipulihkan = [];
  for (const a of alokasi) {
    await conn.query(
      `UPDATE prepast_record
          SET qty_remaining_ltr = LEAST(qty_remaining_ltr + ?, vol_prepast_ltr),
              status_fifo = 'ACTIVE'
        WHERE id = ?`,
      [a.qty_allocated, a.prepast_id],
    );
    dipulihkan.push({ kode: a.kode, kembaliLtr: Number(a.qty_allocated) });
  }
  return dipulihkan;
}

/**
 * Memulihkan anchor standing time yang disentuh transfer - BR-09.
 *
 * Nilai lamanya diambil dari kolom yang direkam saat transfer dibuat, bukan
 * dihitung ulang dari batch tertua: pada pindah silo, anchor DIWARISI dan
 * lebih tua daripada prepast_finish anak yang lahir dari transfer itu.
 */
async function pulihkanAnchor(conn, transfer) {
  const jejak = [];

  if (transfer.anchor_asal_sebelum) {
    await conn.query('UPDATE silo SET standing_time_anchor = ? WHERE id = ?', [
      transfer.anchor_asal_sebelum, transfer.silo_asal_id,
    ]);
    jejak.push({ siloId: transfer.silo_asal_id, anchor: transfer.anchor_asal_sebelum });
  }

  if (transfer.anchor_tujuan_diset && transfer.silo_tujuan_id) {
    await conn.query('UPDATE silo SET standing_time_anchor = NULL WHERE id = ?', [
      transfer.silo_tujuan_id,
    ]);
    jejak.push({ siloId: transfer.silo_tujuan_id, anchor: null });
  }

  return jejak;
}

/** Menandai record sebagai VOIDED dan menutup sisanya. */
async function tandaiVoid(conn, modul, id) {
  const tabel = TABEL[modul];
  const punyaFifo = modul !== 'monitoring' && modul !== 'transfer';

  await conn.query(
    `UPDATE ${tabel}
        SET status_approval = 'VOIDED'
            ${punyaFifo ? ", status_fifo = 'CLOSED', qty_remaining_ltr = 0" : ''}
      WHERE id = ?`,
    [id],
  );
}

/** Membatalkan satu record beserta pemulihan volumenya ke hulu. */
async function voidSatu(conn, modul, id, alasan, aktor, ip) {
  const lama = await ambil(conn, modul, id, { kunci: true });

  if (lama.status_approval === 'VOIDED') {
    return { modul, id, kode: lama.kode, dilewati: 'sudah VOIDED' };
  }
  if (!BOLEH_DIVOID.includes(lama.status_approval)) {
    throw new BusinessError(
      'BR-13',
      `${lama.kode} berstatus ${lama.status_approval} dan tidak dapat dibatalkan`,
    );
  }

  const pemulihan = {};

  if (modul === 'prepast') {
    pemulihan.induk = await pulihkanInduk(conn, lama);
  } else if (modul === 'transfer') {
    pemulihan.alokasi = await pulihkanAlokasi(conn, id);
    pemulihan.anchor = await pulihkanAnchor(conn, lama);
  }
  // receiving: tidak ada hulu. pengembalian: pemasukan, tidak ada hulu.
  // monitoring: tidak menyentuh volume sama sekali.

  await tandaiVoid(conn, modul, id);

  const baru = await ambil(conn, modul, id);
  await catatAudit(conn, {
    entity: modul, entityId: id, action: 'VOID',
    actorId: aktor.id, before: lama, after: { ...baru, pemulihan },
    reason: alasan, ip,
  });

  return {
    modul, id, kode: lama.kode,
    volumeLtr: Number(lama.vol_prepast_ltr ?? lama.vol_ltr ?? lama.qty_ltr ?? 0),
    pemulihan,
  };
}

/**
 * Menegakkan wewenang void untuk SELURUH rantai yang akan terbatalkan.
 *
 * Dipakai pembatalan berjenjang. Bedanya dengan `pastikanBolehVoid()` bukan
 * sekadar jumlah baris yang diperiksa: yang diperiksa di sini adalah setiap
 * record yang AKAN IKUT terbatalkan, termasuk turunan yang tidak terlihat di
 * layar saat tombolnya ditekan.
 *
 * Ditolak SELURUHNYA bila satu saja tidak lolos - bukan dibatalkan sebagian.
 * Pembatalan sebagian meninggalkan rantai yang setengah hidup, dan itu keadaan
 * yang lebih sulit diperbaiki daripada kesalahan yang hendak diperbaikinya.
 */
async function pastikanBolehVoidRantai(conn, modul, id, pohon, aktor) {
  if (can(aktor?.role, AKSI.RECORD_VOID)) return;

  const seluruh = [{ modul, id }, ...ratakanDaunDuluan(pohon)];
  const bermasalah = [];

  for (const s of seluruh) {
    const baris = await ambil(conn, s.modul, s.id);

    // Kepemilikan tidak lagi dijaga; hanya STATUS. Rantai yang menyentuh record
    // yang sudah disetujui tetap ditolak seluruhnya - itu urusan SPV.
    if (!BOLEH_DIVOID_SENDIRI.includes(baris.status_approval)) {
      bermasalah.push(`${baris.kode} berstatus ${baris.status_approval}`);
    }
  }

  if (bermasalah.length > 0) {
    throw new ForbiddenError(
      'Pembatalan berjenjang ini menyentuh record yang sudah disetujui: '
      + `${bermasalah.join('; ')}. Mintakan ke SPV.`,
    );
  }
}

/**
 * Membatalkan satu record. Menolak bila masih punya turunan aktif (BR-15).
 */
export async function batalkan(modul, id, alasan, aktor, ip) {
  if (!alasan || alasan.trim().length < 3) {
    throw new BusinessError('BR-13', 'Alasan pembatalan wajib diisi');
  }

  return withTransaction(async (conn) => {
    // BR-22 - SPV boleh membatalkan apa pun; Operator boleh membatalkan record
    // siapa pun yang belum disetujui. Pembatalan selalu tercatat di audit.
    await pastikanBolehVoid(conn, modul, id, aktor);
    const pohon = await pohonDependensi(modul, id, { conn });
    const jumlah = hitungTurunan(pohon);

    if (jumlah > 0) {
      throw new BusinessError(
        'BR-15',
        `Record ini tidak dapat dibatalkan karena ada ${jumlah} record turunan yang masih aktif. ` +
          'Batalkan turunannya lebih dulu, atau pakai pembatalan berjenjang.',
        { pohon, jumlah },
      );
    }

    return voidSatu(conn, modul, id, alasan, aktor, ip);
  });
}

/**
 * Pembatalan berjenjang - FR-17.2, BR-14.
 *
 * Seluruh turunan dibatalkan lebih dulu (daun ke akar), lalu recordnya
 * sendiri. Semuanya dalam SATU transaksi: pembatalan separuh jalan akan
 * meninggalkan volume yang berasal dari record yang sudah tidak sah.
 *
 * Pada transfer PINDAH SILO, prepast anak di silo tujuan ikut terjaring
 * lewat pohon dependensi (BR-14), sehingga tidak perlu penanganan khusus.
 */
export async function batalkanBerjenjang(modul, id, alasan, aktor, ip) {
  /*
   * Berjenjang terbuka untuk Operator, dengan syarat yang berlaku ke SELURUH
   * rantai - bukan hanya ke record yang diklik.
   *
   * Salah input kerap sudah punya turunan saat kesalahannya disadari:
   * penerimaan yang salah volume sudah diprepast, prepastnya sudah ditransfer.
   * Tanpa berjenjang, operator harus membatalkan dari daun ke atas satu per
   * satu, dan selama proses itu stok di sistem tidak sama dengan stok di silo.
   *
   * Yang dijaga bukan siapa yang menekan tombolnya, melainkan APA yang ikut
   * terbatalkan: bila satu saja record di rantai itu sudah disetujui, seluruh
   * pembatalan ditolak. Memeriksa hanya record teratas akan membuat batasan
   * "hanya yang belum disetujui" dapat dilewati hanya dengan memilih induknya.
   */
  pastikanBerwenang(aktor, AKSI.RECORD_VOID_SENDIRI);
  if (!alasan || alasan.trim().length < 3) {
    throw new BusinessError('BR-13', 'Alasan pembatalan wajib diisi');
  }

  return withTransaction(async (conn) => {
    const pohon = await pohonDependensi(modul, id, { conn });
    await pastikanBolehVoidRantai(conn, modul, id, pohon, aktor);
    const urutan = ratakanDaunDuluan(pohon);

    const hasil = [];
    for (const s of urutan) {
      hasil.push(await voidSatu(conn, s.modul, s.id, alasan, aktor, ip));
    }
    hasil.push(await voidSatu(conn, modul, id, alasan, aktor, ip));

    return {
      dibatalkan: hasil,
      jumlah: hasil.length,
      totalVolumeLtr: Number(
        hasil.reduce((n, h) => n + (h.volumeLtr ?? 0), 0).toFixed(2),
      ),
    };
  });
}

/**
 * Pratinjau dampak pembatalan berjenjang, untuk dialog konfirmasi (FR-17.2).
 * Tidak mengubah apa pun.
 */
export async function pratinjauBerjenjang(modul, id) {
  const pohon = await pohonDependensi(modul, id);
  const urutan = ratakanDaunDuluan(pohon);
  return {
    pohon,
    urutanPembatalan: urutan,
    jumlah: urutan.length + 1,
    totalVolumeLtr: Number(
      urutan.reduce((n, s) => n + (s.volumeLtr ?? 0), 0).toFixed(2),
    ),
  };
}
