/**
 * Model data form GMP untuk satu hari - F3-3, FR-12, FR-28
 *
 * Menghasilkan satu objek yang mewakili isi form, tanpa tahu apa pun soal
 * Excel maupun HTML. Penyaji Excel dan penyaji pratinjau sama-sama memakannya,
 * sehingga keduanya tidak mungkin menampilkan data yang berbeda.
 *
 * ATURAN TANGGAL PATOKAN (ditegaskan pemilik proses, 25 Ags 2026):
 *
 *   Satu baris halaman 1 adalah satu BATCH PENERIMAAN, dan hari terbitnya
 *   ditentukan oleh `finish_time` batch itu. Prepast mengikuti batch induknya,
 *   bukan hari prepastnya sendiri.
 *
 * Jadi penerimaan yang selesai 10 Agustus 23.30 lalu diprepast 11 Agustus
 * 01.00 terbit di form 10 Agustus, dengan jam prepast 01.00 pada kolomnya.
 * Prepast karena itu TIDAK difilter tanggal sama sekali; ia diambil sebagai
 * anak lewat foreign key.
 *
 * Flow lama memprefilter prepast tiga hari lalu mencocokkan `id_receiving`.
 * Prefilter itu punya celah: prepast yang dikerjakan lebih dari sehari setelah
 * penerimaannya luput, dan baris formnya terbit dengan kolom prepast kosong
 * (B-29). Di sini celah itu tidak ada.
 *
 * Monitoring dan transfer tetap per hari kalendernya sendiri, sebab keduanya
 * tidak terikat batch penerimaan mana pun.
 */

import { pool } from '../db/pool.js';
import { batasTanggal } from './waktu.js';
import {
  tataLetakUntuk,
  kapasitasTransferPerSilo,
  URUTAN_SILO_FORM,
} from './formLayout.js';

/**
 * Status yang ikut terbit - D-12.
 *
 * `Pending Approval` sengaja masuk: form terbit mengikuti realita operasional
 * harian, tidak menunggu SPV. Yang dikecualikan adalah status yang berarti
 * recordnya tidak berlaku.
 */
export const STATUS_TERBIT = ['Approved', 'Pending Approval'];

/** Jam:menit setempat dari DATETIME UTC, atau null. */
function keJam(nilai) {
  if (!nilai) return null;
  const d = nilai instanceof Date ? nilai : new Date(nilai);
  if (Number.isNaN(d.getTime())) return null;
  return { jam: d.getHours(), menit: d.getMinutes(), iso: d.toISOString() };
}

const keAngka = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Menggabungkan prepast satu batch penerimaan menjadi SATU baris form.
 *
 * Satu baris form hanya punya satu kolom untuk waktu, flowrate, dan suhu,
 * sementara satu batch dapat diprepast ke beberapa silo. Aturan penggabungan
 * mengikuti flow lama karena itu yang tercetak di form selama ini:
 *
 *  - volume DIJUMLAHKAN
 *  - waktu, flowrate, dan suhu: nilai PERTAMA yang tidak kosong
 *  - daftar silo disambung dengan '/'
 *
 * Satu hal yang DIPERBAIKI: silo yang sama tidak ditulis dua kali. Flow lama
 * menyambung tanpa dedupe, sehingga satu batch yang diprepast dua kali ke
 * SILO25A tercetak sebagai `SILO25A/25A` (B-24).
 */
export function gabungPrepast(daftar) {
  if (daftar.length === 0) {
    return {
      volumeLtr: null, prepastMulai: null, prepastSelesai: null,
      flowrate: null, tempAfterHeater: null, tempOutput: null,
      silo: null, jumlahPecahan: 0,
    };
  }

  const pertamaAda = (ambil) => {
    for (const p of daftar) {
      const v = ambil(p);
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
  };

  const kodeSilo = [];
  for (const p of daftar) {
    if (p.silo_kode && !kodeSilo.includes(p.silo_kode)) kodeSilo.push(p.silo_kode);
  }

  return {
    volumeLtr: daftar.reduce((s, p) => s + Number(p.vol_prepast_ltr ?? 0), 0),
    prepastMulai: keJam(pertamaAda((p) => p.prepast_start)),
    prepastSelesai: keJam(pertamaAda((p) => p.prepast_finish)),
    flowrate: keAngka(pertamaAda((p) => p.flowrate_pst)),
    tempAfterHeater: keAngka(pertamaAda((p) => p.temp_after_heater)),
    tempOutput: keAngka(pertamaAda((p) => p.temp_output_prd)),
    silo: kodeSilo.length ? `SILO${kodeSilo.join('/')}` : null,
    jumlahPecahan: daftar.length,
    siloKode: kodeSilo,
  };
}

/**
 * Menyusun model form untuk satu tanggal setempat.
 *
 * @param {string} tanggalIso  'YYYY-MM-DD', hari setempat
 */
export async function modelForm(tanggalIso) {
  const dari = batasTanggal(tanggalIso, 'mulai');
  const sampai = batasTanggal(tanggalIso, 'akhir');
  const tataLetak = tataLetakUntuk(tanggalIso);

  const tanda = STATUS_TERBIT.map(() => '?').join(',');

  // ---- Halaman 1: penerimaan, dijaring menurut finish_time ----
  const [barisReceiving] = await pool.query(
    `SELECT r.id, r.kode, r.qty_kg, r.berat_jenis, r.nilai_ts, r.qty_ltr,
            r.finish_time, r.status_approval, r.remarks,
            sup.supplier_name, o.nama_lengkap AS operator_nama
       FROM receiving r
       JOIN supplier sup ON sup.id = r.supplier_id
       JOIN operator o   ON o.id = r.operator_id
      WHERE r.finish_time BETWEEN ? AND ?
        AND r.status_approval IN (${tanda})
      ORDER BY r.finish_time, r.id`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  // ---- Prepast: anak dari penerimaan di atas, TANPA filter tanggal ----
  const idReceiving = barisReceiving.map((r) => r.id);
  let prepastPerReceiving = new Map();

  if (idReceiving.length > 0) {
    const isi = idReceiving.map(() => '?').join(',');
    const [barisPrepast] = await pool.query(
      `SELECT p.id, p.receiving_id, p.vol_prepast_ltr, p.prepast_start,
              p.prepast_finish, p.flowrate_pst, p.temp_after_heater,
              p.temp_output_prd, p.status_approval, s.kode AS silo_kode
         FROM prepast_record p
         JOIN silo s ON s.id = p.silo_tujuan_id
        WHERE p.receiving_id IN (${isi})
          AND p.jenis_batch = 'PREPAST'
          AND p.status_approval IN (${tanda})
        ORDER BY p.prepast_start IS NULL, p.prepast_start, p.id`,
      [...idReceiving, ...STATUS_TERBIT],
    );

    prepastPerReceiving = barisPrepast.reduce((peta, p) => {
      const daftar = peta.get(p.receiving_id) ?? [];
      daftar.push(p);
      peta.set(p.receiving_id, daftar);
      return peta;
    }, new Map());
  }

  const halaman1 = barisReceiving.map((r, i) => {
    const gabungan = gabungPrepast(prepastPerReceiving.get(r.id) ?? []);
    return {
      nomor: i + 1,
      receivingId: r.id,
      kode: r.kode,
      statusApproval: r.status_approval,
      supplier: r.supplier_name,
      terimaSelesai: keJam(r.finish_time),
      qtyKg: keAngka(r.qty_kg),
      beratJenis: keAngka(r.berat_jenis),
      nilaiTs: keAngka(r.nilai_ts),
      qtyLtr: keAngka(r.qty_ltr),
      operator: r.operator_nama,
      remarks: r.remarks,
      ...gabungan,
    };
  });

  // ---- Halaman 2: monitoring per hari kalendernya sendiri ----
  const [barisMonitoring] = await pool.query(
    `SELECT m.id, m.kode, m.ph_check, m.temp_check, m.time_check,
            m.status_approval, s.kode AS silo_kode, o.nama_lengkap AS operator_nama
       FROM monitoring m
       JOIN silo s     ON s.id = m.silo_id
       JOIN operator o ON o.id = m.operator_id
      WHERE m.time_check BETWEEN ? AND ?
        AND m.status_approval IN (${tanda})
      ORDER BY m.time_check, m.id`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  /**
   * Transfer: HANYA pemakaian produksi.
   *
   * Flow lama menulis `transfer_type eq 'PEMAKAIAN PRODUKSI' and status eq
   * 'Approved' or status eq 'Pending Approval'`. Karena `and` mengikat lebih
   * kuat daripada `or`, artinya menjadi "(pemakaian dan approved) atau (pending
   * apa pun)", sehingga PINDAH SILO yang masih pending ikut terbit sebagai
   * pemakaian. Akibatnya total pemakaian pada form kelebihan sebesar setiap
   * pindah silo, dan itu terlihat di berkas 6 Agustus: batch `TF TO SILO6`
   * 2.844 L keluar dari Silo 1, lalu 2.844 L yang sama keluar lagi dari Silo 6
   * sebagai CMD2 (B-23).
   *
   * Pindah silo dan pengembalian memang tidak masuk blok pemakaian; keduanya
   * dilaporkan sebagai catatan di bawah form (D-16).
   */
  const [barisTransfer] = await pool.query(
    `SELECT t.id, t.kode, t.batch, t.vol_ltr, t.vol_akt_silo_ltr, t.trf_time,
            t.status_approval, sa.kode AS silo_asal_kode,
            o.nama_lengkap AS operator_nama
       FROM transfer t
       JOIN silo sa    ON sa.id = t.silo_asal_id
       JOIN operator o ON o.id = t.operator_id
      WHERE t.trf_time BETWEEN ? AND ?
        AND t.transfer_type = 'PEMAKAIAN PRODUKSI'
        AND t.status_approval IN (${tanda})
      ORDER BY t.trf_time, t.id`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  /** Catatan bawah form: pindah silo dan pengembalian (D-16). */
  const [barisPindah] = await pool.query(
    `SELECT t.kode, t.vol_ltr, t.trf_time, sa.kode AS asal, st.kode AS tujuan
       FROM transfer t
       JOIN silo sa      ON sa.id = t.silo_asal_id
       LEFT JOIN silo st ON st.id = t.silo_tujuan_id
      WHERE t.trf_time BETWEEN ? AND ?
        AND t.transfer_type = 'PINDAH SILO'
        AND t.status_approval IN (${tanda})
      ORDER BY t.trf_time`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  const [barisKembali] = await pool.query(
    `SELECT p.kode, p.vol_prepast_ltr, p.prepast_start, s.kode AS silo_kode,
            p.keterangan_asal
       FROM prepast_record p
       JOIN silo s ON s.id = p.silo_tujuan_id
      WHERE p.prepast_start BETWEEN ? AND ?
        AND p.jenis_batch = 'PENGEMBALIAN'
        AND p.status_approval IN (${tanda})
      ORDER BY p.prepast_start`,
    [dari, sampai, ...STATUS_TERBIT],
  );

  // Dikelompokkan menurut urutan silo pada FORM, bukan urutan basis data
  const monitoringPerSilo = new Map(URUTAN_SILO_FORM.map((k) => [k, []]));
  const operatorPerSilo = new Map();
  for (const m of barisMonitoring) {
    if (!monitoringPerSilo.has(m.silo_kode)) continue;
    monitoringPerSilo.get(m.silo_kode).push({
      id: m.id,
      kode: m.kode,
      jam: keJam(m.time_check),
      suhu: keAngka(m.temp_check),
      ph: keAngka(m.ph_check),
      statusApproval: m.status_approval,
    });
    if (!operatorPerSilo.has(m.silo_kode)) operatorPerSilo.set(m.silo_kode, m.operator_nama);
  }

  const transferPerSilo = new Map(URUTAN_SILO_FORM.map((k) => [k, []]));
  for (const t of barisTransfer) {
    if (!transferPerSilo.has(t.silo_asal_kode)) continue;
    const daftar = transferPerSilo.get(t.silo_asal_kode);

    daftar.push({
      id: t.id,
      kode: t.kode,
      jam: keJam(t.trf_time),
      batch: t.batch,
      volume: keAngka(t.vol_ltr),
      statusApproval: t.status_approval,
      penanda: null,
    });

    /**
     * PENANDA SILO KOSONG.
     *
     * Pada form, satu slot berisi `0 / 0 / 0` bukan berarti slot kosong; ia
     * MENANDAI bahwa silo mencapai posisi kosong pada transfer sebelumnya.
     * Ditegaskan pemilik proses, 25 Ags 2026.
     *
     * Buktinya terbaca di berkas 6 Agustus, Silo 25B: empat transfer, lalu
     * penanda pada pukul 03.00, lalu silonya diisi lagi dan dipakai lagi dari
     * 15.10. Penandanya duduk di TENGAH urutan, bukan di ujung, jadi ia tidak
     * mungkin sekadar sisa slot yang belum terpakai. Sebaliknya Silo 25A
     * dengan sembilan transfer pada hari yang sama tidak punya penanda sama
     * sekali, sebab ia tidak pernah kosong.
     *
     * Ini datum yang penting, bukan derau: penanda itu batas ketiadaan
     * carry-over. Susu setelah penanda adalah susu baru, dan itulah yang
     * ditanyakan saat penelusuran.
     *
     * `vol_akt_silo_ltr` adalah snapshot volume SEBELUM transfer, jadi sisanya
     * dihitung dengan menguranginya. Perbandingannya dalam ratusan-bulat agar
     * tidak ada silo yang tampak "hampir kosong" karena sisa pecahan sen.
     */
    const sebelum = Math.round(Number(t.vol_akt_silo_ltr ?? 0) * 100);
    const keluar = Math.round(Number(t.vol_ltr ?? 0) * 100);
    if (sebelum > 0 && sebelum - keluar === 0) {
      daftar.push({
        id: `kosong-${t.id}`,
        penanda: 'KOSONG',
        jam: null,
        batch: null,
        volume: null,
        setelahKode: t.kode,
        statusApproval: t.status_approval,
      });
    }
  }

  return {
    tanggal: tanggalIso,
    tataLetak,
    halaman1,
    halaman2: {
      monitoring: URUTAN_SILO_FORM.map((kode) => ({
        siloKode: kode,
        operator: operatorPerSilo.get(kode) ?? null,
        slot: monitoringPerSilo.get(kode),
      })),
      transfer: URUTAN_SILO_FORM.map((kode) => ({
        siloKode: kode,
        slot: transferPerSilo.get(kode),
      })),
    },
    catatan: {
      pindahSilo: barisPindah.map((t) => ({
        kode: t.kode,
        jam: keJam(t.trf_time),
        volumeLtr: keAngka(t.vol_ltr),
        asal: t.asal,
        tujuan: t.tujuan,
      })),
      pengembalian: barisKembali.map((p) => ({
        kode: p.kode,
        jam: keJam(p.prepast_start),
        volumeLtr: keAngka(p.vol_prepast_ltr),
        silo: p.silo_kode,
        keteranganAsal: p.keterangan_asal,
      })),
    },
    /** Hari tanpa data apa pun. Bukan berarti tanpa penerimaan saja (B-27). */
    kosong:
      halaman1.length === 0 && barisMonitoring.length === 0 && barisTransfer.length === 0,
  };
}

/**
 * Temuan validasi pra-export - FR-28.3, FR-28.5.
 *
 * Pemblokir adalah hal yang membuat formnya tidak dapat terbit utuh; sisanya
 * peringatan. Perbedaannya penting: memblokir export karena satu record masih
 * pending akan menghentikan form harian tanpa alasan yang sepadan.
 */
export async function validasiForm(model) {
  const temuan = [];
  const h1 = model.tataLetak.halaman1;
  const h2 = model.tataLetak.halaman2;

  // --- Pemblokir: melampaui kapasitas halaman ---
  if (model.halaman1.length > h1.kapasitasBaris) {
    temuan.push({
      jenis: 'pemblokir',
      kode: 'FR-28.5',
      pesan:
        `${model.halaman1.length} batch penerimaan, sedangkan halaman 1 hanya ` +
        `menampung ${h1.kapasitasBaris} baris. Sisanya tidak akan terbit.`,
      tautan: null,
    });
  }

  const kapasitasTransfer = kapasitasTransferPerSilo(h2.transfer);
  for (const s of model.halaman2.transfer) {
    if (s.slot.length > kapasitasTransfer) {
      temuan.push({
        jenis: 'pemblokir',
        kode: 'FR-28.5',
        pesan:
          `SILO${s.siloKode} memiliki ${s.slot.length} transfer, sedangkan form ` +
          `menampung ${kapasitasTransfer} per silo.`,
        siloKode: s.siloKode,
      });
    }
  }

  for (const s of model.halaman2.monitoring) {
    if (s.slot.length > h2.monitoring.kapasitasSlot) {
      temuan.push({
        jenis: 'pemblokir',
        kode: 'FR-28.5',
        pesan:
          `SILO${s.siloKode} memiliki ${s.slot.length} pengecekan, sedangkan form ` +
          `menampung ${h2.monitoring.kapasitasSlot} slot.`,
        siloKode: s.siloKode,
      });
    }
  }

  // --- Peringatan ---
  for (const b of model.halaman1) {
    if (b.statusApproval !== 'Approved') {
      temuan.push({
        jenis: 'peringatan',
        kode: 'D-12',
        pesan: `${b.kode} masih ${b.statusApproval} dan tetap terbit di form.`,
        baris: b.nomor,
        modul: 'receiving',
        entityId: b.receivingId,
      });
    }

    if (b.jumlahPecahan === 0) {
      temuan.push({
        jenis: 'peringatan',
        kode: 'FR-28.3',
        pesan: `${b.kode} belum diprepast, jadi kolom prepasteurisasinya kosong.`,
        baris: b.nomor,
        modul: 'receiving',
        entityId: b.receivingId,
      });
    }

    if (b.tempAfterHeater !== null && b.tempAfterHeater < h1.oprpTempMin) {
      temuan.push({
        jenis: 'peringatan',
        kode: 'OPRP',
        pesan:
          `${b.kode}: Temp After Heater ${b.tempAfterHeater} C di bawah ambang ` +
          `OPRP ${h1.oprpTempMin} C.`,
        baris: b.nomor,
        modul: 'receiving',
        entityId: b.receivingId,
      });
    }

    if (!b.prepastMulai && b.jumlahPecahan > 0) {
      temuan.push({
        jenis: 'peringatan',
        kode: 'BR-23',
        pesan: `${b.kode} memiliki prepast draft tanpa waktu, jadi jamnya kosong.`,
        baris: b.nomor,
        modul: 'receiving',
        entityId: b.receivingId,
      });
    }
  }

  // Permintaan koreksi yang masih menunggu - D-18
  if (model.halaman1.length > 0) {
    const isi = model.halaman1.map(() => '?').join(',');
    const [pending] = await pool.query(
      `SELECT cr.id, cr.entity_id, r.kode
         FROM correction_request cr
         JOIN receiving r ON r.id = cr.entity_id
        WHERE cr.status = 'PENDING' AND cr.entity = 'receiving'
          AND cr.entity_id IN (${isi})`,
      model.halaman1.map((b) => b.receivingId),
    );
    for (const p of pending) {
      temuan.push({
        jenis: 'peringatan',
        kode: 'D-18',
        pesan:
          `${p.kode} memiliki permintaan koreksi yang masih menunggu. Form akan ` +
          'terbit dengan nilai lamanya.',
        modul: 'permintaan-koreksi',
        entityId: p.id,
      });
    }
  }

  if (model.kosong) {
    temuan.push({
      jenis: 'peringatan',
      kode: 'B-27',
      pesan: 'Tidak ada data pada tanggal ini, jadi tidak ada yang dapat diterbitkan.',
    });
  }

  return {
    temuan,
    adaPemblokir: temuan.some((t) => t.jenis === 'pemblokir'),
    jumlahPemblokir: temuan.filter((t) => t.jenis === 'pemblokir').length,
    jumlahPeringatan: temuan.filter((t) => t.jenis === 'peringatan').length,
  };
}
