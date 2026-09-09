/**
 * Pipeline pemuatan migrasi - F4-2 s/d F4-6, Bagian 11.1
 *
 * Urutan pemuatan mengikuti ketergantungan, bukan kenyamanan:
 *
 *   master -> receiving -> prepast -> transfer -> transfer_allocation
 *          -> monitoring -> stock_opname
 *
 * DUA SIFAT YANG MENENTUKAN BENTUK BERKAS INI:
 *
 *  IDEMPOTEN (T-23)  Dijalankan dua kali menghasilkan keadaan yang sama.
 *                    Baris dikenali dari `kode` (eks `Title` SharePoint), dan
 *                    ditulis dengan INSERT ... ON DUPLICATE KEY UPDATE. Migrasi
 *                    yang tidak idempoten hanya boleh dijalankan sekali, dan
 *                    "sekali" adalah jaminan yang tidak dapat ditepati saat
 *                    dry run diulang tiga kali sebelum cutover.
 *
 *  TIDAK MENEBAK     Baris yang tidak dapat diselesaikan MASUK LAPORAN, bukan
 *                    diperkirakan. Migrasi tetap berjalan sampai selesai supaya
 *                    laporannya lengkap dalam satu kali jalan; menghentikan di
 *                    pengecualian pertama berarti menemukan masalah satu per
 *                    satu, berhari-hari.
 */

import { pool, withTransaction } from '../db/pool.js';
import {
  LIST, PETA_STATUS, PETA_FIFO, PETA_BUFFER, PETA_CMD, PETA_JENIS_TRANSFER,
} from './sumberKolom.js';
import { bacaList, periksaKepala } from './bacaSumber.js';
import { parseMenurutJenis, GagalParse } from './parseNilai.js';
import { normalisasiBatch } from '../services/batch.js';
import { bangunProfil, bangunPrefiksHarian, coba, perbaikiBatch } from './perbaikan.js';
import { muatOperator } from './muatOperator.js';
import { catatAudit } from '../services/audit.js';
import { ambilAnchorSiloHistoris } from '../services/standingSilo.js';

/** Kumpulan pengecualian, satu per baris yang tidak dapat dimuat. */
export class Laporan {
  constructor() {
    this.pengecualian = [];
    this.ringkasan = {};
  }

  /**
   * Mencatat satu pengecualian.
   *
   * "ditolak" membedakan baris yang TIDAK JADI DIMUAT dari baris yang tetap
   * dimuat dengan satu nilai hilang. Bedanya bukan kosmetik: V-2 mencocokkan
   * jumlah baris dengan jumlah sumber dikurangi yang ditolak, dan menghitung
   * peringatan sebagai penolakan membuat V-2 menuduh ada data hilang yang
   * sebenarnya tidak pernah hilang. Bawaannya benar - yang tetap dimuat harus
   * menyatakannya sendiri.
   */
  catat(list, baris, sebab, rincian = {}) {
    this.pengecualian.push({ list, barisSumber: baris, sebab, ditolak: true, ...rincian });
  }

  /** Pengecualian yang benar-benar membuat barisnya tidak dimuat. */
  ditolakPerList(list) {
    return this.perList(list).filter((p) => p.ditolak !== false);
  }

  perList(list) {
    return this.pengecualian.filter((p) => p.list === list);
  }

  get jumlah() {
    return this.pengecualian.length;
  }
}

/** Indeks master untuk resolusi relasi teks ke foreign key - F4-3. */
async function muatIndeksMaster() {
  const [silo] = await pool.query('SELECT id, kode, silo_name FROM silo');
  const [supplier] = await pool.query('SELECT id, kode, supplier_name FROM supplier');
  const [operator] = await pool.query('SELECT id, kode, nama_lengkap FROM operator');
  const [tank] = await pool.query('SELECT id, tank_name, qr_value FROM tank_master');

  const peta = (baris, ...kolom) => {
    const m = new Map();
    for (const b of baris) {
      for (const k of kolom) {
        const v = b[k];
        if (v) m.set(String(v).trim().toUpperCase(), b.id);
      }
    }
    return m;
  };

  return {
    silo: peta(silo, 'kode', 'silo_name'),
    supplier: peta(supplier, 'kode', 'supplier_name'),
    operator: peta(operator, 'kode', 'nama_lengkap'),
    tank: peta(tank, 'tank_name', 'qr_value'),
  };
}

/**
 * Mencari id dari nilai teks, mencoba beberapa petunjuk berurutan.
 *
 * Sumbernya menyimpan silo dua kali - sebagai kode dan sebagai nama tampilan -
 * dan keduanya kerap tidak sepakat. Yang manapun yang cocok diterima; bila
 * keduanya gagal, barisnya masuk laporan.
 */
function cariId(indeks, ...petunjuk) {
  for (const p of petunjuk) {
    if (!p) continue;
    const id = indeks.get(String(p).trim().toUpperCase());
    if (id) return id;
  }
  return null;
}

/** Mengubah satu baris sumber menjadi objek bernilai, atau mencatat sebabnya. */
function petakanBaris(def, mentah, laporan, namaList, profil) {
  const hasil = {};
  const gagal = [];
  const diperbaiki = [];
  const dikosongkan = [];

  for (const k of def.kolom) {
    const nilaiMentah = mentah[k.dari];
    try {
      hasil[k.ke] = parseMenurutJenis(k.jenis, nilaiMentah, k.dari);
    } catch (err) {
      if (err instanceof GagalParse) {
        /*
         * Satu kesempatan perbaikan, dengan syarat yang ketat - lihat
         * perbaikan.js. Yang tidak dapat dipastikan tetap ditolak: lapisan ini
         * melonggarkan APA yang dapat diterima, bukan seberapa yakin ia harus
         * merasa sebelum menerimanya.
         */
        const sembuh = coba(err, nilaiMentah, profil);
        if (sembuh) {
          hasil[k.ke] = sembuh.nilai;
          diperbaiki.push({ kolom: k.dari, asal: err.nilai, cara: sembuh.cara });
          continue;
        }

        /*
         * Kolom yang tidak wajib dikosongkan, barisnya TIDAK dibuang.
         *
         * Satu nilai_ts yang tertulis 5131 tidak membatalkan penerimaan yang
         * sungguh terjadi - dan membuangnya bukan sekadar kehilangan satu
         * baris: prepast anaknya ikut kehilangan induk, lalu alokasi FIFO-nya
         * ikut yatim. Nilainya menjadi kosong dan tercatat sebagai kosong,
         * sehingga tidak ada yang salah mengira ia pernah terukur.
         */
        if (!k.wajib) {
          hasil[k.ke] = null;
          dikosongkan.push({ kolom: k.dari, asal: err.nilai, pesan: err.message });
          continue;
        }

        gagal.push({ kolom: k.dari, nilai: err.nilai, pesan: err.message });
        continue;
      }
      throw err;
    }

    if (k.wajib && (hasil[k.ke] === null || hasil[k.ke] === undefined)) {
      gagal.push({ kolom: k.dari, nilai: nilaiMentah, pesan: 'kolom wajib kosong' });
    }
  }

  if (gagal.length > 0) {
    /*
     * Kode diambil dari kolom kunci list ini, bukan dari `Title`.
     *
     * `Title` adalah nama kolom DI DALAM list SharePoint; export menuliskannya
     * sebagai `id_receiving`, `prepast_id`, `trf_id`, atau `checking_id`. Kode
     * yang selalu kosong membuat laporan pengecualian hanya menyebut nomor
     * baris, dan nomor baris tidak dapat dicari di SharePoint.
     */
    const kolomKunci = def.kolom.find((k) => k.ke === 'kode' || k.ke === 'periode');
    laporan.catat(namaList, mentah._barisSumber, 'nilai tidak terbaca', {
      kode: (kolomKunci ? mentah[kolomKunci.dari] : null) || null,
      rincian: gagal,
    });
    return null;
  }

  hasil._barisSumber = mentah._barisSumber;
  hasil._diperbaiki = [...diperbaiki, ...dikosongkan.map((d) => ({ ...d, cara: 'dikosongkan' }))];

  if (dikosongkan.length > 0) {
    const kunciKosong = def.kolom.find((k) => k.ke === 'kode' || k.ke === 'periode');
    laporan.catat(namaList, mentah._barisSumber, 'nilai tidak terbaca, kolom dikosongkan', {
      kode: (kunciKosong ? mentah[kunciKosong.dari] : null) || null,
      ditolak: false,
      rincian: dikosongkan.map((d) => `${d.kolom}: ${d.pesan}`),
    });
  }

  if (diperbaiki.length > 0) {
    const kunciOk = def.kolom.find((k) => k.ke === 'kode' || k.ke === 'periode');
    laporan.catat(namaList, mentah._barisSumber, 'diperbaiki otomatis', {
      kode: (kunciOk ? mentah[kunciOk.dari] : null) || null,
      ditolak: false,
      rincian: diperbaiki.map((d) => `${d.kolom}: "${d.asal}" -> ${d.cara}`),
    });
  }

  return hasil;
}

/**
 * Keterangan perbaikan yang menempel di barisnya sendiri.
 *
 * Laporan pengecualian dibaca sekali saat cutover lalu diarsipkan. Yang membaca
 * catatan mutu ini tiga tahun lagi tidak akan membukanya, jadi keterangannya
 * harus ikut masuk ke basis data (ALCOA+ - original).
 */
function catatanPerbaikan(baris, awal = null) {
  const d = baris?._diperbaiki;
  if (!d?.length) return awal;
  const teks = `MIGRASI - nilai diperbaiki: ${d.map((x) => `${x.kolom} asalnya "${x.asal}"`).join('; ')}`;
  return awal ? `${awal} | ${teks}` : teks;
}

/**
 * Menulis satu baris, MENANGKAP galat basis datanya.
 *
 * Tanpa ini, satu baris yang melanggar kekangan akan menggagalkan seluruh
 * transaksi, dan laporannya berhenti di baris itu. Janji pipeline ini adalah
 * laporan LENGKAP dalam satu kali jalan; menemukan masalah satu per satu
 * berarti berhari-hari bolak-balik ke SharePoint.
 *
 * Tiap baris memakai SAVEPOINT sendiri supaya kegagalannya dapat digulung
 * balik tanpa membatalkan baris yang sudah benar.
 */
let nomorSavepoint = 0;

/**
 * Kunci alami yang sudah terpakai DALAM satu kali jalan.
 *
 * ON DUPLICATE KEY UPDATE ada demi idempotensi (T-23): menjalankan migrasi dua
 * kali harus menghasilkan keadaan yang sama. Tetapi bila berkas sumbernya
 * sendiri memuat satu kode dua kali, klausa itu berubah sifat - baris kedua
 * MENIMPA baris pertama, dan satu catatan mutu lenyap tanpa galat apa pun.
 * Pada export sungguhan hal itu terjadi pada 7 prepast, 13 transfer, dan 1
 * monitoring; tanpa penjaga ini enam catatan hilang diam-diam.
 *
 * Yang PERTAMA dipertahankan dan berikutnya ditolak, bukan sebaliknya: mana
 * yang benar tidak dapat diputuskan dari datanya, jadi keduanya harus sampai
 * ke manusia - satu di basis data, satu di laporan.
 */
const kunciTerpakai = new Set();

/**
 * Kode yang PASTI belum terpakai dalam satu kali jalan ini.
 *
 * Kode ganda di export sungguhan ternyata BUKAN baris kembar: pasangannya
 * berbeda silo, berbeda volume, berbeda jam - dua kejadian nyata yang kebetulan
 * mendapat nomor acak yang sama dari sistem lama. Menolak yang kedua berarti
 * membuang satu penerimaan atau satu transfer yang sungguh terjadi, jadi
 * keduanya dipertahankan dan yang kedua diberi akhiran.
 *
 * Yang PERTAMA mempertahankan kode aslinya. Bila alokasi FIFO menunjuk kode
 * ganda tersebut, supplier di payload FIFO dipakai untuk memilih baris asli
 * atau baris bersuffix; lihat `pilihPrepastUntukAlokasi`.
 */
function kodeUnik(list, kode, laporan, barisSumber) {
  if (!kode) return kode;

  const asli = `${list} ${kode}`;
  if (!kunciTerpakai.has(asli)) {
    kunciTerpakai.add(asli);
    return kode;
  }

  let n = 2;
  while (kunciTerpakai.has(`${list} ${kode}-${n}`)) n += 1;
  const baru = `${kode}-${n}`;
  kunciTerpakai.add(`${list} ${baru}`);

  laporan.catat(list, barisSumber, 'kode ganda di berkas sumber', {
    kode,
    ditolak: false,
    rincian: [
      `kode "${kode}" dipakai lebih dari satu baris pada berkas yang sama dan `
      + `isinya berbeda. Baris ini dimuat sebagai "${baru}" supaya keduanya tetap `
      + 'tersimpan. Alokasi FIFO yang menyebut kode aslinya menempel pada baris '
      + 'yang pertama.',
    ],
  });
  return baru;
}

async function tulisBaris(conn, laporan, konteks, sql, nilai) {
  if (konteks.kunci) {
    const k = konteks.list + '\u0000' + konteks.kunci;
    if (kunciTerpakai.has(k)) {
      laporan.catat(konteks.list, konteks.barisSumber, 'kode ganda di berkas sumber', {
        kode: konteks.kode,
        rincian: [
          'kode ini sudah dipakai baris sebelumnya pada berkas yang sama; baris '
          + 'ini TIDAK dimuat supaya tidak menimpanya. Tentukan mana yang benar.',
        ],
      });
      return false;
    }
    kunciTerpakai.add(k);
  }

  nomorSavepoint += 1;
  const sp = `sp_${nomorSavepoint}`;
  await conn.query(`SAVEPOINT ${sp}`);
  try {
    await conn.query(sql, nilai);
    await conn.query(`RELEASE SAVEPOINT ${sp}`);
    return true;
  } catch (err) {
    await conn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    laporan.catat(konteks.list, konteks.barisSumber, 'ditolak basis data', {
      kode: konteks.kode,
      rincian: [err.sqlMessage ?? err.message],
    });
    return false;
  }
}

/** Status yang tidak dikenal ditolak, bukan diberi nilai bawaan. */
function petakanStatus(nilai, peta, bawaan) {
  if (nilai === null || nilai === undefined) return bawaan;
  return peta[nilai] ?? null;
}

/* ------------------------------------------------------------------ */
/* Pemuatan per tabel                                                  */
/* ------------------------------------------------------------------ */

async function muatReceiving(conn, baris, indeks, laporan) {
  let dimuat = 0;

  for (const b of baris) {
    const supplierId = cariId(indeks.supplier, b._supplier_kode, b._supplier_nama);
    const siloId = cariId(indeks.silo, b._silo_kode, b._silo_nama);
    const operatorId = cariId(indeks.operator, b._operator_nama);
    const status = petakanStatus(b.status_approval, PETA_STATUS, 'Pending Approval');
    const fifo = petakanStatus(b.status_fifo, PETA_FIFO, 'ACTIVE');
    const buffer = petakanStatus(b.buffer_status, PETA_BUFFER, 'IN_BUFFER');
    const cmd = petakanStatus(b.cmd_source, PETA_CMD, 'CMD1');

    const kode = kodeUnik('receiving', b.kode, laporan, b._barisSumber);

    const kurang = [];
    if (!supplierId) kurang.push(`supplier "${b._supplier_kode ?? b._supplier_nama}"`);
    if (!siloId) kurang.push(`silo "${b._silo_kode ?? b._silo_nama}"`);
    if (!operatorId) kurang.push(`operator "${b._operator_nama}"`);
    if (!status) kurang.push(`status approval "${b.status_approval}"`);
    if (!fifo) kurang.push(`status fifo "${b.status_fifo}"`);
    if (!buffer) kurang.push(`buffer status "${b.buffer_status}"`);
    if (!cmd) kurang.push(`cmd source "${b.cmd_source}"`);

    if (kurang.length > 0) {
      laporan.catat('receiving', b._barisSumber, 'relasi tidak ditemukan', {
        kode: b.kode, rincian: kurang,
      });
      continue;
    }

    const ok = await tulisBaris(
      conn, laporan, { list: 'receiving', barisSumber: b._barisSumber, kode: kode },
      `INSERT INTO receiving
         (kode, supplier_id, silo_id, qty_kg, berat_jenis, qty_ltr, qty_remaining_ltr,
          nilai_ts, finish_time, operator_id, status_approval, status_fifo,
          buffer_status, cmd_source, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         supplier_id = VALUES(supplier_id), silo_id = VALUES(silo_id),
         qty_kg = VALUES(qty_kg), berat_jenis = VALUES(berat_jenis),
         qty_ltr = VALUES(qty_ltr), qty_remaining_ltr = VALUES(qty_remaining_ltr),
         nilai_ts = VALUES(nilai_ts), finish_time = VALUES(finish_time),
         operator_id = VALUES(operator_id), status_approval = VALUES(status_approval),
         status_fifo = VALUES(status_fifo), buffer_status = VALUES(buffer_status),
         cmd_source = VALUES(cmd_source), remarks = VALUES(remarks)`,
      [
        kode, supplierId, siloId, b.qty_kg, b.berat_jenis,
        // BR-03 - liter dihitung ulang dari kg dan berat jenis, TIDAK diambil
        // dari sumber. Nilai liter di SharePoint adalah hasil formula yang
        // pembulatannya pernah berbeda-beda; menghitungnya ulang membuat
        // seluruh riwayat mengikuti satu aturan yang sama.
        Math.floor(b.qty_kg / b.berat_jenis),
        b.qty_remaining_ltr ?? Math.floor(b.qty_kg / b.berat_jenis),
        b.nilai_ts, b.finish_time, operatorId, status, fifo, buffer, cmd,
        catatanPerbaikan(b, b.remarks),
      ],
    );
    if (ok) dimuat += 1;
  }

  return dimuat;
}

async function muatPrepast(conn, baris, indeks, laporan) {
  const [rcv] = await conn.query('SELECT id, kode FROM receiving');
  const petaRcv = new Map(rcv.map((r) => [r.kode, r.id]));

  let dimuat = 0;
  const anakPindahSilo = [];

  for (const b of baris) {
    const siloId = cariId(indeks.silo, b._silo_kode, b._silo_nama);
    const operatorId = cariId(indeks.operator, b._operator_nama);
    const supplierId = cariId(indeks.supplier, b._supplier_kode, b._supplier_nama);
    const status = petakanStatus(b.status_approval, PETA_STATUS, 'Pending Approval');
    const fifo = petakanStatus(b.status_fifo, PETA_FIFO, 'ACTIVE');
    const cmd = petakanStatus(b.cmd_source, PETA_CMD, 'CMD1');
    const receivingId = b._receiving_kode ? petaRcv.get(b._receiving_kode) ?? null : null;

    /**
     * Anak PINDAH SILO tidak punya batch penerimaan induk - V-3 memberinya
     * pengecualian. Dikenali dari `transfer_ref`, dan ketiadaan induk pada
     * baris semacam itu BUKAN kesalahan.
     */
    const anakPindah = Boolean(b._transfer_ref);

    const kode = kodeUnik('prepast', b.kode, laporan, b._barisSumber);

    const kurang = [];
    if (!siloId) kurang.push(`silo "${b._silo_kode ?? b._silo_nama}"`);
    if (!operatorId) kurang.push(`operator "${b._operator_nama}"`);
    if (!status) kurang.push(`status approval "${b.status_approval}"`);
    if (!fifo) kurang.push(`status fifo "${b.status_fifo}"`);
    if (!cmd) kurang.push(`cmd source "${b.cmd_source}"`);
    if (!receivingId && !anakPindah) {
      kurang.push(`batch penerimaan "${b._receiving_kode}"`);
    }

    if (kurang.length > 0) {
      laporan.catat('prepast', b._barisSumber, 'relasi tidak ditemukan', {
        kode: b.kode, rincian: kurang,
      });
      continue;
    }

    /*
     * Sisa tidak boleh melampaui volume asalnya - kekangan ck_pst_remaining.
     *
     * Satu baris di export sungguhan melanggarnya. Yang lebih dapat dipercaya
     * adalah vol_prepast_ltr: ia hasil ukur sekali saat prepast selesai,
     * sedangkan qty_remaining_ltr diperbarui berkali-kali setiap ada transfer,
     * jadi ialah yang lebih mungkin tertinggal. Sisanya dijepit ke volume
     * asalnya, bukan barisnya dibuang.
     */
    let sisaPrepast = b.qty_remaining_ltr ?? b.vol_prepast_ltr;
    if (sisaPrepast > b.vol_prepast_ltr) {
      laporan.catat('prepast', b._barisSumber, 'diperbaiki otomatis', {
        kode: b.kode, ditolak: false,
        rincian: [
          `qty_remaining_ltr ${sisaPrepast} L melebihi vol_prepast_ltr `
          + `${b.vol_prepast_ltr} L; sisa dijepit ke volume asalnya`,
        ],
      });
      sisaPrepast = b.vol_prepast_ltr;
    }

    const ok = await tulisBaris(
      conn, laporan, { list: 'prepast', barisSumber: b._barisSumber, kode: kode },
      `INSERT INTO prepast_record
         (kode, jenis_batch, receiving_id, supplier_id, silo_tujuan_id,
          vol_prepast_ltr, qty_remaining_ltr, prepast_start, prepast_finish,
          flowrate_pst, temp_after_heater, temp_output_prd, nilai_ts, operator_id,
          status_approval, status_fifo, cmd_source, is_gantung, remarks)
       VALUES (?, 'PREPAST', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         receiving_id = VALUES(receiving_id), supplier_id = VALUES(supplier_id),
         silo_tujuan_id = VALUES(silo_tujuan_id),
         vol_prepast_ltr = VALUES(vol_prepast_ltr),
         qty_remaining_ltr = VALUES(qty_remaining_ltr),
         prepast_start = VALUES(prepast_start), prepast_finish = VALUES(prepast_finish),
         flowrate_pst = VALUES(flowrate_pst), temp_after_heater = VALUES(temp_after_heater),
         temp_output_prd = VALUES(temp_output_prd), nilai_ts = VALUES(nilai_ts),
         operator_id = VALUES(operator_id),
         status_approval = VALUES(status_approval), status_fifo = VALUES(status_fifo),
         is_gantung = VALUES(is_gantung), remarks = VALUES(remarks)`,
      [
        kode, receivingId, supplierId, siloId,
        b.vol_prepast_ltr, sisaPrepast,
        b.prepast_start, b.prepast_finish,
        b.flowrate_pst, b.temp_after_heater, b.temp_output_prd, b.nilai_ts, operatorId,
        status, fifo, cmd,
        // BR-23 - waktu kosong berarti draft, dan itu keadaan yang sah
        !b.prepast_start || !b.prepast_finish,
        catatanPerbaikan(b, b.remarks),
      ],
    );

    if (!ok) continue;
    if (anakPindah) {
      anakPindahSilo.push({
        kode,
        transferRef: b._transfer_ref,
        volumeLtr: b.vol_prepast_ltr,
        waktu: b.prepast_finish ?? b.prepast_start ?? null,
        barisSumber: b._barisSumber,
      });
    }
    dimuat += 1;
  }

  return { dimuat, anakPindahSilo };
}

async function muatTransfer(conn, baris, indeks, laporan, prefiksHarian) {
  let dimuat = 0;
  const fifoTertunda = [];

  for (const b of baris) {
    const siloAsalId = cariId(indeks.silo, b._silo_asal_kode, b._silo_asal_nama);
    const operatorId = cariId(indeks.operator, b._operator_nama);
    const status = petakanStatus(b.status_approval, PETA_STATUS, 'Pending Approval');
    const jenis = petakanStatus(b.transfer_type, PETA_JENIS_TRANSFER, null);
    const cmd = petakanStatus(b.cmd_destination, PETA_CMD, 'CMD1');

    const pindahSilo = jenis === 'PINDAH SILO';

    /*
     * Pada PINDAH SILO, tujuannya dibaca dari `tank_trf`.
     *
     * Kolom `silo_tujuan` tidak ikut terekspor SharePoint, dan pada baris
     * pindah silo kolom tank justru memuat nama silo tujuannya - terlihat di
     * data: tank_trf 'SILO6' dengan batch 'TF TO SILO6'. Batch-nya dipakai
     * sebagai petunjuk cadangan bila kolom tank kosong.
     */
    const tujuanDariBatch = pindahSilo
      ? (/TFs+TOs+(S+)/i.exec(b._batch_mentah ?? '')?.[1] ?? null)
      : null;
    const siloTujuanId = pindahSilo
      ? cariId(indeks.silo, b._silo_tujuan_kode, b._tank_nama, tujuanDariBatch)
      : null;
    const tankId = pindahSilo ? null : cariId(indeks.tank, b._tank_qr, b._tank_nama);

    const kode = kodeUnik('transfer', b.kode, laporan, b._barisSumber);

    const kurang = [];
    if (!siloAsalId) kurang.push(`silo asal "${b._silo_asal_kode ?? b._silo_asal_nama}"`);
    if (!operatorId) kurang.push(`operator "${b._operator_nama}"`);
    if (!status) kurang.push(`status approval "${b.status_approval}"`);
    if (!jenis) kurang.push(`jenis transfer "${b.transfer_type}"`);
    if (!cmd) kurang.push(`cmd destination "${b.cmd_destination}"`);
    if (pindahSilo && !siloTujuanId) kurang.push(`silo tujuan "${b._tank_nama ?? b._batch_mentah}"`);
    if (!pindahSilo && !tankId) kurang.push(`tank "${b._tank_qr ?? b._tank_nama}"`);

    if (kurang.length > 0) {
      laporan.catat('transfer', b._barisSumber, 'relasi tidak ditemukan', {
        kode: b.kode, rincian: kurang,
      });
      continue;
    }

    /**
     * Batch dinormalkan (BR-21, F4-6), dan yang tidak terpetakan MASUK
     * LAPORAN sambil nilai mentahnya tetap dimuat. Menolak barisnya akan
     * membuang transfer yang sah hanya karena penulisan batchnya tidak baku;
     * mengubahnya diam-diam akan memutus penelusuran ke dokumen produksi.
     */
    let batch = b._batch_mentah;
    if (b._batch_mentah) {
      const norm = normalisasiBatch(b._batch_mentah);
      if (norm.batch) {
        batch = norm.batch;
      } else {
        /*
         * Nomor batch yang kehilangan prefiksnya masih dapat dipulihkan dari
         * transfer LAIN pada tanggal yang sama - lihat perbaikan.js. Yang
         * dipulihkan hanya bila hari itu memakai tepat satu prefiks.
         */
        const sembuh = perbaikiBatch(b._batch_mentah, b.trf_time, prefiksHarian);
        if (sembuh) {
          const ulang = normalisasiBatch(sembuh.nilai);
          batch = ulang.batch ?? sembuh.nilai;
          laporan.catat('transfer', b._barisSumber, 'diperbaiki otomatis', {
            kode: b.kode, ditolak: false,
            rincian: [`batch: "${b._batch_mentah}" -> ${batch}; ${sembuh.cara}`],
          });
        } else {
          // Nilai mentahnya tetap dimuat; yang hilang hanya bentuk bakunya.
          laporan.catat('transfer', b._barisSumber, 'batch tidak terpetakan', {
            kode: b.kode, ditolak: false,
            rincian: [`"${b._batch_mentah}" tidak dikenali bentuk bakunya (BR-21)`],
          });
        }
      }
    }

    /*
     * Standing time negatif - 21 baris pada export sungguhan.
     *
     * Angkanya TURUNAN, bukan hasil ukur: sistem lama menghitungnya dari
     * selisih dua waktu, dan waktu yang tertukar menghasilkan menit negatif.
     * Menolak seluruh barisnya berarti membuang volume dan batch yang justru
     * benar, jadi yang dibuang hanya nilai turunannya. Dikosongkan, TIDAK
     * dinolkan: nol berarti "berdiri nol menit", padahal yang sebenarnya
     * terjadi adalah tidak diketahui.
     */
    let standing = b.standing_time_menit;
    if (standing !== null && standing !== undefined && standing < 0) {
      laporan.catat('transfer', b._barisSumber, 'standing time negatif, dikosongkan', {
        kode: b.kode, ditolak: false,
        rincian: [
          `standing_time_menit ${standing} tidak mungkin; kemungkinan waktu mulai `
          + 'dan selesai tertukar di sistem lama. Volume dan batch tetap dimuat.',
        ],
      });
      standing = null;
    }

    const ok = await tulisBaris(
      conn, laporan, { list: 'transfer', barisSumber: b._barisSumber, kode: kode },
      `INSERT INTO transfer
         (kode, transfer_type, silo_asal_id, tank_id, silo_tujuan_id,
          vol_ltr, vol_akt_silo_ltr, batch, trf_time, standing_time_menit,
          operator_id, status_approval, cmd_destination, is_gantung)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         transfer_type = VALUES(transfer_type), silo_asal_id = VALUES(silo_asal_id),
         tank_id = VALUES(tank_id), silo_tujuan_id = VALUES(silo_tujuan_id),
         vol_ltr = VALUES(vol_ltr), vol_akt_silo_ltr = VALUES(vol_akt_silo_ltr),
         batch = VALUES(batch), trf_time = VALUES(trf_time),
         standing_time_menit = VALUES(standing_time_menit),
         operator_id = VALUES(operator_id), status_approval = VALUES(status_approval),
         cmd_destination = VALUES(cmd_destination), is_gantung = VALUES(is_gantung)`,
      [
        kode, jenis, siloAsalId, tankId, siloTujuanId,
        b.vol_ltr, b.vol_akt_silo_ltr ?? 0, batch, b.trf_time,
        standing, operatorId, status, cmd, !b.trf_time,
      ],
    );

    if (!ok) continue;

    fifoTertunda.push({
      kode,
      barisSumber: b._barisSumber,
      fifo: b._supplier_fifo ?? [],
    });
    dimuat += 1;
  }

  return { dimuat, fifoTertunda };
}

/**
 * `supplier_fifo` JSON menjadi baris `transfer_allocation` - F4-4.
 *
 * Inilah transformasi paling kritis di seluruh migrasi. Tanpanya, pertanyaan
 * "susu yang dikirim ke tank ini berasal dari supplier mana" kehilangan
 * jawabannya untuk seluruh riwayat, dan itu justru pertanyaan yang diajukan
 * saat terjadi masalah mutu.
 */
export function gabungkanAlokasiFifo(
  fifo = [],
  kunciDari = (a) => a?.id_prepast ?? a?.idPrepast ?? a?.prepast_id,
  labelDari = (a) => a?.id_prepast ?? a?.idPrepast ?? a?.prepast_id,
) {
  const hasil = [];
  const perPrepast = new Map();
  const konflik = [];

  const angka = (a, snake, camel, fallback = 0) =>
    Number(a?.[snake] ?? a?.[camel] ?? fallback);

  for (const mentah of fifo) {
    const kode = String(kunciDari(mentah) ?? '').trim();
    const label = String(labelDari(mentah) ?? kode).trim();

    // Referensi kosong tetap diteruskan agar jalur "alokasi yatim" yang sudah
    // ada mencatatnya secara eksplisit; jangan menghilangkan bukti sumber.
    if (!kode) {
      hasil.push(mentah);
      continue;
    }

    const kini = {
      ...mentah,
      id_prepast: kode,
      qty_available: angka(mentah, 'qty_available', 'qtyAvailable'),
      qty_allocated: angka(mentah, 'qty_allocated', 'qtyAllocated'),
      qty_after: angka(mentah, 'qty_after', 'qtyAfter'),
    };
    const sebelumnya = perPrepast.get(kode);

    if (!sebelumnya) {
      perPrepast.set(kode, kini);
      hasil.push(kini);
      continue;
    }

    const identik = sebelumnya.qty_available === kini.qty_available
      && sebelumnya.qty_allocated === kini.qty_allocated
      && sebelumnya.qty_after === kini.qty_after;

    if (!identik) {
      // Satu batch kadang muncul sebagai beberapa potongan di JSON SharePoint.
      // Model relasional menyimpan satu baris per transfer+prepast, sehingga
      // volume potongan dijumlahkan. Available terbesar adalah keadaan awal,
      // dan after terkecil adalah keadaan akhir setelah seluruh potongan.
      sebelumnya.qty_available = Math.max(sebelumnya.qty_available, kini.qty_available);
      sebelumnya.qty_allocated += kini.qty_allocated;
      sebelumnya.qty_after = Math.min(sebelumnya.qty_after, kini.qty_after);
    }

    konflik.push({ kode: label, identik });
  }

  return { alokasi: hasil, konflik };
}

/**
 * Resolusi kode Prepast ganda dari sistem lama.
 *
 * SharePoint dapat memberi dua baris Prepast kode sama untuk supplier berbeda.
 * `kodeUnik` menyimpan keduanya sebagai KODE dan KODE-2, sementara JSON FIFO
 * tetap menunjuk KODE pada kedua supplier. Supplier adalah bukti pembeda yang
 * eksplisit di kedua sumber, sehingga aman dipakai sebelum fallback ke baris
 * pertama untuk data lama yang tidak membawa metadata supplier.
 */
export function pilihPrepastUntukAlokasi(kode, supplierId, semuaPrepast) {
  if (!kode) return null;
  const teks = String(kode);
  const kandidat = semuaPrepast.filter((p) =>
    p.kode === teks || (p.kode.startsWith(`${teks}-`) && /^\d+$/.test(p.kode.slice(teks.length + 1))),
  );

  if (supplierId) {
    const sesuaiSupplier = kandidat.filter((p) => Number(p.supplier_id) === Number(supplierId));
    if (sesuaiSupplier.length === 1) return sesuaiSupplier[0];
  }

  return kandidat.find((p) => p.kode === teks) ?? null;
}

async function muatAlokasi(conn, fifoTertunda, indeks, laporan) {
  const [trf] = await conn.query('SELECT id, kode, vol_ltr FROM transfer');
  const petaTrf = new Map(trf.map((t) => [t.kode, t]));

  const [pst] = await conn.query('SELECT id, kode, supplier_id FROM prepast_record');

  let dimuat = 0;

  for (const t of fifoTertunda) {
    const transfer = petaTrf.get(t.kode);
    if (!transfer) continue;

    // Dibersihkan lebih dulu supaya menjalankan ulang tidak menggandakan
    // alokasi. Inilah yang membuat langkah ini idempoten (T-23).
    await conn.query('DELETE FROM transfer_allocation WHERE transfer_id = ?', [transfer.id]);

    if (t.fifo.length === 0) {
      laporan.catat('transfer_allocation', t.barisSumber, 'transfer tanpa alokasi FIFO', {
        kode: t.kode, ditolak: false,
        rincian: ['supplier_fifo kosong; penelusuran supplier tidak tersedia untuk transfer ini'],
      });
      continue;
    }

    /*
     * Cacat pemisah ribuan yang sama, kali ini DI DALAM supplier_fifo.
     *
     * `vol_ltr` sudah diperbaiki di lapisan angka, tetapi qty di dalam JSON
     * tidak melewati lapisan itu sama sekali - JSON.parse menerima 12.007
     * sebagai bilangan dua belas koma nol nol tujuh tanpa satu pun keluhan.
     * Buktinya tepat dan tidak dapat ditafsirkan lain: totalnya berselisih
     * SERIBU KALI dari volume transfernya. Kalau selisihnya bukan seribu
     * kali, tidak ada yang diubah.
     */
    const totalMentah = t.fifo.reduce(
      (n, a) => n + Number(a.qty_allocated ?? a.qtyAllocated ?? 0), 0,
    );
    let skala = 1;
    if (totalMentah > 0
        && Math.abs(totalMentah * 1000 - Number(transfer.vol_ltr)) < 0.5) {
      skala = 1000;
      laporan.catat('transfer_allocation', t.barisSumber, 'diperbaiki otomatis', {
        kode: t.kode, ditolak: false,
        rincian: [
          `qty di supplier_fifo berjumlah ${totalMentah} L sedangkan volume `
          + `transfernya ${transfer.vol_ltr} L - tepat seribu kali. Titik di `
          + 'dalam JSON dibaca sebagai pemisah ribuan.',
        ],
      });
    }

    let urutan = 0;
    let total = 0;

    const terurai = [];
    for (const a of t.fifo) {
      const kodePst = a.id_prepast ?? a.idPrepast ?? a.prepast_id;
      const supplierId = cariId(
        indeks.supplier,
        a.supplier_code, a.supplierCode, a.supplier_name, a.supplierName,
      );
      const prepast = pilihPrepastUntukAlokasi(kodePst, supplierId, pst);

      if (!prepast) {
        laporan.catat('transfer_allocation', t.barisSumber, 'alokasi yatim', {
          kode: t.kode, ditolak: false,
          rincian: [`id_prepast "${kodePst}" tidak ditemukan`],
        });
        continue;
      }

      if (prepast.kode !== String(kodePst)) {
        laporan.catat('transfer_allocation', t.barisSumber, 'kode prepast ganda dipetakan berdasarkan supplier', {
          kode: t.kode, ditolak: false,
          rincian: [`${kodePst} (${a.supplier_name ?? a.supplierName ?? a.supplier_code ?? ''}) -> ${prepast.kode}`],
        });
      }
      terurai.push({ ...a, _prepast: prepast });
    }

    const { alokasi, konflik } = gabungkanAlokasiFifo(
      terurai,
      (a) => a._prepast.id,
      (a) => a._prepast.kode,
    );
    if (konflik.length > 0) {
      const unik = [...new Set(konflik.map((k) => k.kode))];
      laporan.catat('transfer_allocation', t.barisSumber, 'alokasi prepast ganda dinormalisasi', {
        kode: t.kode, ditolak: false,
        rincian: [`${konflik.length} entri ganda untuk ${unik.join(', ')} digabung.`],
      });
    }

    for (const a of alokasi) {
      const prepast = a._prepast;

      const qty = Number(a.qty_allocated ?? a.qtyAllocated ?? 0) * skala;
      total += qty;
      urutan += 1;

      await conn.query(
        `INSERT INTO transfer_allocation
           (transfer_id, prepast_id, supplier_id, qty_available, qty_allocated,
            qty_after, urutan_fifo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          transfer.id, prepast.id, prepast.supplier_id,
          Number(a.qty_available ?? a.qtyAvailable ?? qty) * skala,
          qty,
          Number(a.qty_after ?? a.qtyAfter ?? 0) * skala,
          urutan,
        ],
      );
      dimuat += 1;
    }

    // V-4 diperiksa di sini juga supaya selisihnya tercatat berikut nilainya,
    // bukan hanya sebagai kegagalan verifikasi tanpa konteks.
    const selisih = Math.round((total - Number(transfer.vol_ltr)) * 100) / 100;
    if (Math.abs(selisih) > 0.01) {
      laporan.catat('transfer_allocation', t.barisSumber, 'jumlah alokasi tidak sama dengan volume transfer', {
        kode: t.kode, ditolak: false,
        rincian: [`alokasi ${total} L vs transfer ${transfer.vol_ltr} L, selisih ${selisih} L`],
      });
    }
  }

  return dimuat;
}

/**
 * Menautkan anak PINDAH SILO ke transfer yang melahirkannya - F4-5.
 *
 * Saat susu dipindahkan antar silo, sistem lama membuat baris prepast BARU di
 * silo tujuan. Baris itu tidak punya batch penerimaan induk, dan memang tidak
 * seharusnya punya: induknya adalah TRANSFER-nya, bukan sebuah penerimaan.
 *
 * Yang menghubungkan keduanya adalah `transfer_ref`, dan bentuknya bukan kode
 * transfer melainkan pasangan nomor silo: `001-TO-008`. Satu pasangan itu
 * dipakai berkali-kali sepanjang riwayat, sehingga menautkannya perlu penciri
 * kedua. Yang dipakai VOLUME - pindah silo memindahkan volume yang sama persis
 * ke prepast barunya - lalu waktu terdekat bila volumenya masih menunjuk lebih
 * dari satu transfer.
 *
 * Tanpa langkah ini seluruh anak pindah silo terlihat sebagai prepast yatim,
 * dan V-3 menyatakan GAGAL untuk keadaan yang sebenarnya sah.
 */
/**
 * Nomor silo versi SharePoint -> id silo.
 *
 * `silo_number` di export BUKAN `kode` silo di basis data: sumber memakai
 * 001 untuk SILO25A dan 003 untuk SILO1, sedangkan basis data memakai 25A
 * dan 1. Selama ini perbedaan itu tidak terasa karena silo selalu dapat
 * dikenali dari nama tampilannya - sampai `transfer_ref` muncul, sebab ia
 * menyebut silo HANYA lewat nomor versi SharePoint ("001-TO-008").
 *
 * Petanya disusun dari pasangan nomor-dan-nama yang ada di sumber itu
 * sendiri, jadi ia ikut berubah kalau penomorannya berubah.
 */
function petakanNomorSilo(sumber, indeks) {
  const pasangan = [
    ['silo_number', 'silo_display_name'],
    ['silo_tujuan', 'silo_tujuan_display'],
  ];
  const peta = new Map();

  for (const isi of Object.values(sumber)) {
    for (const baris of isi?.data ?? []) {
      for (const [kolomNomor, kolomNama] of pasangan) {
        const nomor = String(baris[kolomNomor] ?? '').trim();
        const nama = String(baris[kolomNama] ?? '').trim();
        if (!nomor || !nama) continue;
        const id = cariId(indeks.silo, nama);
        if (id) peta.set(nomor.toUpperCase(), id);
      }
    }
  }
  return peta;
}

async function hubungkanPindahSilo(conn, anak, laporan, petaNomor) {
  if (anak.length === 0) return 0;

  const [baris] = await conn.query(
    `SELECT id, kode, vol_ltr, trf_time, silo_asal_id, silo_tujuan_id
       FROM transfer
      WHERE transfer_type = 'PINDAH SILO' AND silo_tujuan_id IS NOT NULL`,
  );

  // Dikunci pada id silo, bukan pada nomornya: nomor versi SharePoint hanya
  // dipakai untuk MENERJEMAHKAN transfer_ref, bukan untuk mencocokkan.
  const perPasangan = new Map();
  for (const t of baris) {
    const kunci = `${t.silo_asal_id}>${t.silo_tujuan_id}`;
    if (!perPasangan.has(kunci)) perPasangan.set(kunci, []);
    perPasangan.get(kunci).push(t);
  }

  let tertaut = 0;

  for (const a of anak) {
    const ref = /^(.+?)-TO-(.+)$/.exec(String(a.transferRef).trim());
    const asalId = ref ? petaNomor.get(ref[1].trim().toUpperCase()) : null;
    const tujuanId = ref ? petaNomor.get(ref[2].trim().toUpperCase()) : null;
    const calon = (asalId && tujuanId)
      ? (perPasangan.get(`${asalId}>${tujuanId}`) ?? [])
      : [];

    if (calon.length === 0) {
      laporan.catat('prepast', a.barisSumber, 'anak pindah silo tanpa transfer induk', {
        kode: a.kode, ditolak: false,
        rincian: [
          `transfer_ref "${a.transferRef}" tidak cocok dengan satu pun transfer `
          + 'PINDAH SILO. Baris tetap dimuat, tetapi penelusurannya terputus.',
        ],
      });
      continue;
    }

    // Volume lebih dahulu: pindah silo memindahkan volume yang sama persis.
    const seVolume = calon.filter(
      (t) => Math.abs(Number(t.vol_ltr) - Number(a.volumeLtr)) < 0.5,
    );
    let pilihan = seVolume.length > 0 ? seVolume : calon;

    if (pilihan.length > 1 && a.waktu) {
      pilihan = [...pilihan].sort(
        (x, y) => Math.abs(new Date(x.trf_time) - a.waktu) - Math.abs(new Date(y.trf_time) - a.waktu),
      );
    }

    const t = pilihan[0];
    await conn.query(
      'UPDATE prepast_record SET transfer_ref_id = ? WHERE kode = ?',
      [t.id, a.kode],
    );
    tertaut += 1;

    if (seVolume.length === 0) {
      laporan.catat('prepast', a.barisSumber, 'anak pindah silo ditaut lewat waktu', {
        kode: a.kode, ditolak: false,
        rincian: [
          `tidak ada transfer "${a.transferRef}" yang volumenya ${a.volumeLtr} L; `
          + `ditaut ke ${t.kode} yang waktunya paling dekat. Perlu ditinjau.`,
        ],
      });
    }
  }

  return tertaut;
}

async function muatMonitoring(conn, baris, indeks, laporan) {
  let dimuat = 0;

  for (const b of baris) {
    const siloId = cariId(indeks.silo, b._silo_kode, b._silo_nama);
    const operatorId = cariId(indeks.operator, b._operator_nama);
    const status = petakanStatus(b.status_approval, PETA_STATUS, 'Pending Approval');

    const kode = kodeUnik('monitoring', b.kode, laporan, b._barisSumber);

    const kurang = [];
    if (!siloId) kurang.push(`silo "${b._silo_kode ?? b._silo_nama}"`);
    if (!operatorId) kurang.push(`operator "${b._operator_nama}"`);
    if (!status) kurang.push(`status approval "${b.status_approval}"`);

    if (kurang.length > 0) {
      laporan.catat('monitoring', b._barisSumber, 'relasi tidak ditemukan', {
        kode: b.kode, rincian: kurang,
      });
      continue;
    }

    const ok = await tulisBaris(
      conn, laporan, { list: 'monitoring', barisSumber: b._barisSumber, kode: kode },
      `INSERT INTO monitoring
         (kode, silo_id, ph_check, temp_check, time_check, supplier_list,
          val_aktual_snapshot_ltr, operator_id, status_approval)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         silo_id = VALUES(silo_id), ph_check = VALUES(ph_check),
         temp_check = VALUES(temp_check), time_check = VALUES(time_check),
         supplier_list = VALUES(supplier_list),
         val_aktual_snapshot_ltr = VALUES(val_aktual_snapshot_ltr),
         operator_id = VALUES(operator_id), status_approval = VALUES(status_approval)`,
      [
        kode, siloId, b.ph_check, b.temp_check, b.time_check,
        b.supplier_list, b.val_aktual_snapshot_ltr ?? 0, operatorId, status,
      ],
    );
    if (ok) dimuat += 1;
  }

  return dimuat;
}

/**
 * Menaikkan sekuens ID agar tidak pernah menerbitkan kode yang sudah ada - F4-5.
 *
 * Dua sistem membangkitkan kode dengan cara yang sama sekali berbeda pada
 * tanggal yang SAMA. Power Apps memakai `RandBetween(100,999)`; aplikasi baru
 * memakai sekuens harian yang dimulai dari 1 (`idGenerator.js`). Migrasi
 * memindahkan kode acak itu tanpa pernah menyentuh sekuensnya, sehingga
 * sekuens tetap di angka rendah dan pada hitungan ke-100 ia mulai menabrak
 * kode yang sudah ada.
 *
 * Kunci UNIQUE pada `kode` membuat tabrakan itu gagal, bukan merusak - tetapi
 * yang gagal adalah operator yang sedang menyimpan penerimaan, di tengah
 * pekerjaannya. Sekuens dinaikkan ke angka tertinggi yang sudah terpakai
 * supaya tabrakannya tidak pernah terjadi.
 *
 * Hanya dinaikkan, tidak pernah diturunkan: aplikasi mungkin sudah
 * menerbitkan nomor sendiri sebelum migrasi dijalankan ulang.
 */
const PREFIKS_TABEL = [
  ['RCV', 'receiving'],
  ['PST', 'prepast_record'],
  ['TRF', 'transfer'],
  ['MTR', 'monitoring'],
];

async function naikkanSekuensId(conn, laporan) {
  let disesuaikan = 0;

  for (const [prefiks, tabel] of PREFIKS_TABEL) {
    // Kode berbentuk PREFIKS-yyyymmdd-nnn. Akhiran "-2" pada kode ganda ikut
    // terpotong CAST, dan itu benar: yang dicari nomor urutnya, bukan akhirannya.
    const [baris] = await conn.query(
      `SELECT STR_TO_DATE(SUBSTRING(kode, ?, 8), '%Y%m%d') AS tanggal,
              MAX(CAST(SUBSTRING(kode, ?) AS UNSIGNED)) AS maks
         FROM \`${tabel}\`
        WHERE kode LIKE ?
        GROUP BY tanggal
       HAVING tanggal IS NOT NULL`,
      [prefiks.length + 2, prefiks.length + 11, `${prefiks}-%`],
    );

    for (const b of baris) {
      if (!b.maks) continue;
      const [hasil] = await conn.query(
        `INSERT INTO id_sequence (prefix, tanggal, last_number)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE last_number = GREATEST(last_number, VALUES(last_number))`,
        [prefiks, b.tanggal, b.maks],
      );
      if (hasil.affectedRows > 0) disesuaikan += 1;
    }
  }

  if (disesuaikan > 0) {
    laporan.catat('id_sequence', null, 'sekuens ID dinaikkan', {
      ditolak: false,
      rincian: [
        `${disesuaikan} sekuens harian dinaikkan ke nomor tertinggi yang sudah `
        + 'terpakai, supaya aplikasi tidak menerbitkan kode yang sama dengan '
        + 'kode hasil migrasi.',
      ],
    });
  }

  return disesuaikan;
}

async function muatStockOpname(conn, baris, indeks, laporan, operatorAdmin) {
  let dimuat = 0;

  for (const b of baris) {
    const siloId = cariId(indeks.silo, b._silo_kode);
    if (!siloId) {
      laporan.catat('stockOpname', b._barisSumber, 'relasi tidak ditemukan', {
        rincian: [`silo "${b._silo_kode}"`],
      });
      continue;
    }

    const ok = await tulisBaris(
      conn, laporan, {
        list: 'stockOpname', barisSumber: b._barisSumber, kode: b.periode,
        // Kunci alaminya periode DAN silo - satu periode memang berisi banyak silo.
        kunci: b.periode + '|' + b._silo_kode,
      },
      `INSERT INTO stock_opname (periode, silo_id, jumlah_awal_ltr, operator_id, is_finalized)
       VALUES (?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE jumlah_awal_ltr = VALUES(jumlah_awal_ltr)`,
      [b.periode, siloId, b.jumlah_awal_ltr ?? 0, operatorAdmin],
    );
    if (ok) dimuat += 1;
  }

  return dimuat;
}

/**
 * Menetapkan anchor standing time tiap silo dari riwayatnya - BR-09.
 *
 * MENGAPA INI PERLU ADA.
 *
 * Standing time universal silo dihitung dari `silo.standing_time_anchor`, dan
 * anchor itu hanya di-set oleh alur aplikasi: prepast pertama yang masuk ke
 * silo yang kosong. Migrasi tidak melewati alur itu, sehingga silo yang sudah
 * BERISI saat cutover masuk tanpa anchor - dan standing time-nya, indikator
 * mutu yang paling banyak dilihat, terbaca "tidak diketahui" untuk seluruh
 * stok yang dipindahkan. Itulah yang selama ini ditandai V-6.
 *
 * CARA MENURUNKANNYA, dan mengapa bukan cara yang lebih mudah.
 *
 * Yang lebih mudah adalah memakai prepast TERTUA yang masih aktif di silo itu.
 * Itu salah menurut definisi BR-09: anchor BERLANJUT walaupun susu pertama
 * sudah keluar, sebab isinya sudah tercampur. Memakai prepast aktif tertua
 * akan me-muda-kan silo setiap kali batch tertuanya habis - persis kebalikan
 * dari yang seharusnya terjadi.
 *
 * Jadi yang dicari: kapan silo itu TERAKHIR kosong, lalu pengisian PERTAMA
 * sesudahnya. Saat kosong terbaca dari transfer yang mengeluarkan seluruh isi
 * silo - `vol_akt_silo_ltr` sama dengan `vol_ltr` - yaitu penanda yang sama
 * dengan "0 0 0" pada form GMP.
 *
 * Silo yang tidak pernah tercatat kosong sepanjang riwayat memakai pengisian
 * paling awal yang ada. Itu batas bawah, bukan tebakan: standing time-nya
 * tidak mungkin lebih pendek dari itu.
 */
async function hitungAnchorSilo(conn, laporan) {
  const [silo] = await conn.query(
    `SELECT s.id, s.kode, s.silo_name, s.standing_time_anchor,
            v.vol_aktual_ltr
       FROM silo s
       JOIN v_silo_volume v ON v.silo_id = s.id
      WHERE s.is_buffer = FALSE`,
  );
  const sekarang = new Date();
  const anchor = await ambilAnchorSiloHistoris(sekarang, conn);
  let ditetapkan = 0;

  for (const s of silo) {
    const [depan] = await conn.query(
      `SELECT COUNT(*) AS n FROM transfer
        WHERE (silo_asal_id = ? OR silo_tujuan_id = ?)
          AND trf_time > UTC_TIMESTAMP()`,
      [s.id, s.id],
    );
    if (Number(depan[0].n) > 0) {
      laporan.catat('silo', null, 'transfer bertanggal di masa depan diabaikan', {
        kode: s.silo_name, ditolak: false,
        rincian: [
          `${depan[0].n} transfer dari silo ini bertanggal lebih maju daripada `
          + 'saat ini, jadi tidak ikut menentukan kapan silo terakhir kosong. '
          + 'Perbaiki tanggalnya di sumber.',
        ],
      });
    }

    const berisi = Number(s.vol_aktual_ltr) > 0;
    const target = berisi ? anchor.get(Number(s.id)) ?? null : null;
    const lama = s.standing_time_anchor ? new Date(s.standing_time_anchor) : null;

    if (berisi && !target) {
      laporan.catat('silo', null, 'anchor standing time tidak dapat diturunkan', {
        kode: s.silo_name, ditolak: false,
        rincian: [
          'Silo berisi tetapi tidak ada prepast bertanggal sesudah saat '
          + 'kosongnya yang terakhir. Standing time-nya akan terbaca tidak '
          + 'diketahui sampai ada pengisian baru.',
        ],
      });
    }

    const sama = lama === null && target === null
      || lama !== null && target !== null && lama.getTime() === target.getTime();
    if (sama) continue;

    await conn.query(
      'UPDATE silo SET standing_time_anchor = ? WHERE id = ?',
      [target, s.id],
    );
    ditetapkan += 1;

    laporan.catat('silo', null,
      target ? 'anchor standing time disinkronkan' : 'anchor standing time ditutup',
      {
        kode: s.silo_name, ditolak: false,
        rincian: [
          target
            ? `anchor siklus aktif ${target.toISOString()}; sebelumnya ${lama?.toISOString() ?? 'kosong'}.`
            : `silo kosong; anchor sebelumnya ${lama?.toISOString() ?? 'kosong'} ditutup.`,
        ],
      });
  }

  return ditetapkan;
}

/**
 * Menjalankan seluruh pemuatan.
 *
 * @param {string} dirSumber  folder berisi hasil export SharePoint
 */
export async function muatSemua(dirSumber, tanpa = []) {
  const laporan = new Laporan();
  // Berlaku untuk SATU kali jalan saja. Menjalankan ulang harus tetap boleh
  // menyentuh kode yang sama - di situlah ON DUPLICATE KEY UPDATE bekerja
  // sebagaimana mestinya (T-23); yang dijaga hanya kode ganda dalam berkas.
  kunciTerpakai.clear();
  const dilewati = new Set(tanpa);
  const indeks = await muatIndeksMaster();

  const [adm] = await pool.query("SELECT id FROM operator WHERE role = 'Admin' LIMIT 1");
  const operatorAdmin = adm[0]?.id;
  if (!operatorAdmin) {
    throw new Error('Tidak ada operator berperan Admin. Jalankan seed lebih dahulu.');
  }

  // Dibaca SELURUHNYA lebih dulu, sebelum satu baris pun ditulis: kolom yang
  // hilang harus ketahuan sebelum basis data tersentuh.
  const sumber = {};
  for (const [nama, def] of Object.entries(LIST)) {
    const isi = await bacaList(dirSumber, def.berkas);
    if (!isi) {
      if (dilewati.has(nama)) {
        laporan.catat(nama, null, 'dilewati atas permintaan', {
          ditolak: false, dilewati: true,
          rincian: ['Datanya tidak ikut pindah; tabelnya akan kosong.'],
        });
        continue;
      }
      laporan.catat(nama, null, 'berkas sumber tidak ditemukan', {
        rincian: [`dicari nama yang memuat "${def.berkas}"`],
      });
      continue;
    }
    const cek = periksaKepala(def, isi.kepala);
    if (!cek.lengkap) {
      laporan.catat(nama, null, 'kolom wajib tidak ada di berkas', { rincian: cek.hilang });
      continue;
    }
    sumber[nama] = isi;
  }

  const hasil = await withTransaction(async (conn) => {
    const angka = {};

    /*
     * Operator dimuat PALING DAHULU, dan indeks master dibaca ulang setelahnya.
     *
     * Tiap baris transaksi menunjuk operatornya lewat nama. Indeks yang dibaca
     * sebelum operator dimuat tidak memuat nama-nama baru itu, sehingga seluruh
     * transaksi milik operator yang belum ada akan ditolak - dan pada data
     * sungguhan itu berarti hampir seluruhnya.
     */
    /*
     * Operator boleh DILEWATI (mis. dari menu import berkala).
     *
     * Operator dikelola langsung di aplikasi - ditambah, diedit, dinonaktifkan
     * lewat layar Master. Mengimpornya ulang dari export SharePoint akan MENIMPA
     * perubahan yang sudah dibuat di aplikasi. Saat dilewati, transaksi tetap
     * menautkan operatornya lewat indeks operator yang SUDAH ada di basis data.
     */
    let op = { dimuat: 0, diturunkan: [] };
    if (dilewati.has('operator')) {
      laporan.catat('operator', null, 'dilewati atas permintaan', {
        ditolak: false, dilewati: true,
        rincian: ['Operator dikelola di aplikasi; import tidak menimpanya.'],
      });
    } else {
      op = await muatOperator(conn, dirSumber, laporan);
    }
    angka.operator = op.dimuat;
    angka.operatorDiturunkan = op.diturunkan.length;

    if (op.dimuat > 0) {
      const [ulang] = await conn.query('SELECT id, kode, nama_lengkap FROM operator');
      indeks.operator = new Map();
      for (const o of ulang) {
        if (o.kode) indeks.operator.set(String(o.kode).trim().toUpperCase(), o.id);
        if (o.nama_lengkap) indeks.operator.set(String(o.nama_lengkap).trim().toUpperCase(), o.id);
      }
    }

    /*
      * Profil sebaran dibangun dari SELURUH sumber sebelum satu baris pun
      * dipetakan: batas kewajaran tiap kolom diturunkan dari nilai bersih
      * kolom itu sendiri, bukan dari angka yang diketik di dalam kode.
      */
    const profil = bangunProfil(sumber);
    const prefiksHarian = bangunPrefiksHarian(sumber.transfer?.data ?? []);

    const petakan = (nama) => (sumber[nama]?.data ?? [])
      .map((m) => petakanBaris(LIST[nama], m, laporan, nama, profil))
      .filter(Boolean);

    angka.receiving = await muatReceiving(conn, petakan('receiving'), indeks, laporan);

    const pst = await muatPrepast(conn, petakan('prepast'), indeks, laporan);
    angka.prepast = pst.dimuat;
    angka.anakPindahSilo = pst.anakPindahSilo.length;

    const trf = await muatTransfer(conn, petakan('transfer'), indeks, laporan, prefiksHarian);
    angka.transfer = trf.dimuat;

    // Setelah transfer ada, barulah anak pindah silo punya induk untuk ditunjuk.
    angka.anakPindahSiloTertaut = await hubungkanPindahSilo(
      conn, pst.anakPindahSilo, laporan, petakanNomorSilo(sumber, indeks),
    );

    angka.transferAllocation = await muatAlokasi(conn, trf.fifoTertunda, indeks, laporan);
    angka.monitoring = await muatMonitoring(conn, petakan('monitoring'), indeks, laporan);
    angka.stockOpname = await muatStockOpname(
      conn, petakan('stockOpname'), indeks, laporan, operatorAdmin,
    );

    // Sesudah prepast dan transfer ada, riwayat silonya sudah lengkap dan
    // anchor standing time-nya dapat diturunkan.
    angka.anchorSiloDitetapkan = await hitungAnchorSilo(conn, laporan);

    angka.sekuensIdDinaikkan = await naikkanSekuensId(conn, laporan);

    /*
     * Satu entri audit untuk seluruh migrasi.
     *
     * Setelah cutover, basis data ini memuat ribuan catatan mutu yang tidak
     * dibuat siapa pun lewat aplikasi. Laporan pengecualian memang disimpan
     * sebagai berkas, tetapi berkas dapat tertinggal saat basis datanya
     * dipulihkan ke tempat lain - sedangkan yang dituntut 21 CFR Part 11
     * §11.10(e) adalah jejak yang MELEKAT pada datanya.
     *
     * Ringkasannya, bukan seluruh 135 pengecualiannya: entri audit harus
     * dapat dibaca manusia, dan rinciannya sudah punya tempatnya sendiri.
     */
    const perSebab = {};
    for (const p of laporan.pengecualian) {
      perSebab[p.sebab] = (perSebab[p.sebab] ?? 0) + 1;
    }

    await catatAudit(conn, {
      entity: 'MIGRASI',
      // Migrasi bukan baris pada tabel mana pun, jadi tidak ada id yang dapat
      // ditunjuk. Nol dipakai sebagai penanda "bukan satu baris tertentu".
      entityId: 0,
      action: 'MIGRATE',
      actorId: operatorAdmin,
      after: {
        sumber: dirSumber,
        dilewati: [...dilewati],
        termuat: angka,
        barisSumber: Object.fromEntries(
          Object.entries(sumber).map(([k, v]) => [k, v.data.length]),
        ),
        pengecualian: { jumlah: laporan.jumlah, perSebab },
      },
      reason: 'Migrasi data dari export SharePoint (Fase 4). '
        + 'Rincian per baris ada di laporan_pengecualian.csv '
        + 'dan laporan_verifikasi.json.',
    });

    return angka;
  });

  laporan.ringkasan = {
    ...hasil,
    barisSumber: Object.fromEntries(
      Object.entries(sumber).map(([k, v]) => [k, v.data.length]),
    ),
  };

  return laporan;
}
