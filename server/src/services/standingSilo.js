import { pool } from '../db/pool.js';

const keSkala = (nilai) => Math.round(Number(nilai) * 100);

function tanggalSah(nilai) {
  if (!nilai) return null;
  const hasil = nilai instanceof Date ? nilai : new Date(nilai);
  return Number.isNaN(hasil.getTime()) ? null : hasil;
}

/**
 * Merekonstruksi siklus isi silo sampai suatu snapshot.
 *
 * Anchor dimulai ketika silo yang belum memiliki siklus aktif menerima susu.
 * Transfer sebesar volume aktual sebelum transfer menutup siklus silo asal.
 * Pindah silo penuh mewariskan anchor karena susunya sama; pindah sebagian ke
 * silo kosong memulai anchor baru pada waktu transfer.
 *
 * Fungsi ini murni agar aturan tersebut dapat diuji tanpa basis data.
 */
export function rekonstruksiAnchorSilo(kejadian) {
  const anchor = new Map();

  const urut = [...kejadian].sort((a, b) => {
    const selisih = tanggalSah(a.waktu) - tanggalSah(b.waktu);
    if (selisih) return selisih;
    // Transfer diproses lebih dahulu. Jika transfer mengosongkan silo dan
    // Prepast berikutnya dicatat pada detik yang sama, Prepast itulah anchor
    // siklus baru.
    const prioritas = (x) => x.jenis === 'TRANSFER' ? 0 : 1;
    return prioritas(a) - prioritas(b) || Number(a.id ?? 0) - Number(b.id ?? 0);
  });

  for (const item of urut) {
    const waktu = tanggalSah(item.waktu);
    if (!waktu) continue;

    if (item.jenis === 'ISI') {
      const siloId = Number(item.siloId);
      if (!anchor.get(siloId)) {
        anchor.set(siloId, tanggalSah(item.anchor) ?? waktu);
      }
      continue;
    }

    if (item.jenis !== 'TRANSFER') continue;
    const asalId = Number(item.siloAsalId);
    const tujuanId = item.siloTujuanId === null || item.siloTujuanId === undefined
      ? null : Number(item.siloTujuanId);
    const anchorAsal = anchor.get(asalId) ?? tanggalSah(item.anchorAsalSebelum);
    const volumeAktual = Number(item.volumeAktualLtr);
    const volumeTransfer = Number(item.volumeLtr);
    const penuh = Number.isFinite(volumeAktual)
      && Number.isFinite(volumeTransfer)
      && keSkala(volumeAktual) === keSkala(volumeTransfer);

    if (penuh) anchor.delete(asalId);

    if (item.tipeTransfer === 'PINDAH SILO' && tujuanId !== null && !anchor.get(tujuanId)) {
      // Bila penuh, usia isi tidak dimulai ulang hanya karena berpindah silo.
      // Fallback ke waktu transfer menangani data impor lama tanpa jejak anchor.
      anchor.set(tujuanId, penuh && anchorAsal ? anchorAsal : waktu);
    }
  }

  return anchor;
}

/**
 * Membuang batch residu yang berasal dari siklus sebelum silo terakhir kosong.
 * Sisa alokasi impor dapat tidak lengkap, tetapi transfer penuh tetap menjadi
 * batas keras: batch sebelum batas itu tidak mungkin masih berada di silo.
 */
export function batasiBatchPadaSiklus(batch, kosongTerakhir) {
  const batas = new Map(kosongTerakhir.map((b) => [
    Number(b.silo_id ?? b.siloId), tanggalSah(b.saat_kosong ?? b.saatKosong),
  ]));

  return batch.filter((b) => {
    const saatKosong = batas.get(Number(b.silo_id ?? b.siloId));
    if (!saatKosong) return true;
    const masuk = tanggalSah(b.waktu_masuk_silo ?? b.waktuMasukSilo);
    return Boolean(masuk && masuk >= saatKosong);
  });
}

/**
 * Anchor LIVE tiap silo: waktu masuk batch tertua yang masih benar-benar
 * berisi susu menurut mesin FIFO aplikasi (status_fifo ACTIVE, qty_remaining>0).
 *
 * Lebih tahan daripada memutar ulang transfer: batch yang sudah terkuras
 * ditandai CLOSED oleh FIFO walau transfer pengurasnya tidak ikut terekspor
 * saat import, sehingga tidak menyeret anchor ke masa lalu. Ini pasangan hidup
 * dari `ambilAnchorSiloHistoris`, yang hanya dipakai untuk snapshot lampau.
 */
export async function anchorSiloLangsung(executor = pool) {
  const [baris] = await executor.query(
    `SELECT p.silo_tujuan_id AS silo_id,
            MIN(CASE WHEN p.jenis_batch = 'PENGEMBALIAN'
                     THEN p.prepast_start ELSE p.prepast_finish END) AS anchor
       FROM prepast_record p
      WHERE p.status_fifo = 'ACTIVE' AND p.qty_remaining_ltr > 0
        AND p.status_approval NOT IN ('Rejected','REVISED','VOIDED')
      GROUP BY p.silo_tujuan_id`,
  );
  return new Map(baris.map((b) => [Number(b.silo_id), tanggalSah(b.anchor)]));
}

/** Ambil anchor setiap silo sebagaimana keadaannya pada batas snapshot. */
export async function ambilAnchorSiloHistoris(sampai, executor = pool) {
  const [isi] = await executor.query(
    `SELECT p.id, p.silo_tujuan_id AS silo_id, p.jenis_batch,
            CASE WHEN p.jenis_batch = 'PENGEMBALIAN'
                 THEN p.prepast_start ELSE p.prepast_finish END AS waktu,
            p.prepast_finish AS anchor
       FROM prepast_record p
      WHERE p.status_approval IN ('Approved','Pending Approval')
        AND ((p.jenis_batch = 'PREPAST' AND p.transfer_ref_id IS NULL
              AND p.prepast_finish <= ?)
          OR (p.jenis_batch = 'PENGEMBALIAN' AND p.prepast_start <= ?))`,
    [sampai, sampai],
  );
  const [transfer] = await executor.query(
    `SELECT t.id, t.silo_asal_id, t.silo_tujuan_id, t.transfer_type,
            t.vol_ltr, t.vol_akt_silo_ltr, t.trf_time,
            t.anchor_asal_sebelum
       FROM transfer t
      WHERE t.trf_time <= ?
        AND t.status_approval IN ('Approved','Pending Approval')`,
    [sampai],
  );

  return rekonstruksiAnchorSilo([
    ...isi.map((p) => ({
      jenis: 'ISI', id: p.id, siloId: p.silo_id,
      waktu: p.waktu, anchor: p.anchor,
    })),
    ...transfer.map((t) => ({
      jenis: 'TRANSFER', id: t.id, waktu: t.trf_time,
      siloAsalId: t.silo_asal_id, siloTujuanId: t.silo_tujuan_id,
      tipeTransfer: t.transfer_type, volumeLtr: t.vol_ltr,
      volumeAktualLtr: t.vol_akt_silo_ltr,
      anchorAsalSebelum: t.anchor_asal_sebelum,
    })),
  ]);
}
