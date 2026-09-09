/**
 * Verifikasi migrasi V-1 s/d V-6 - F4-7, T-20, Bagian 11.3
 *
 * Dijalankan OTOMATIS setiap kali migrasi dijalankan, bukan sebagai
 * pemeriksaan manual sekali jalan. Pemeriksaan manual pada data sebanyak ini
 * berarti seseorang membandingkan angka di dua layar, dan yang lolos dari mata
 * pada pukul dua pagi menjelang cutover tidak akan tertangkap lagi setelahnya.
 *
 * Tiap kriteria mengembalikan bukti, bukan hanya lulus atau gagal. "V-4 gagal"
 * tidak dapat ditindaklanjuti; "V-4 gagal pada TRF-0012, alokasi 4.900 L
 * sedangkan transfernya 5.000 L" dapat.
 */

import { pool } from '../db/pool.js';

const angka = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * V-1 Volume tiap silo sama persis dengan yang ditampilkan Power Apps saat
 * cutover, toleransi 0 liter.
 *
 * Pembandingnya harus datang dari luar - dari layar Power Apps saat pembekuan
 * input - sebab sistem baru tidak punya cara mengetahui angka sistem lama.
 * Bila pembandingnya tidak diberikan, kriteria ini dilaporkan TIDAK DAPAT
 * DIPERIKSA, bukan lulus. Melaporkannya lulus tanpa pembanding adalah
 * kebohongan yang paling mudah dilakukan di seluruh berkas ini.
 */
export async function v1(volumeAcuan) {
  const [baris] = await pool.query(
    'SELECT silo_id, kode, silo_name, vol_aktual_ltr FROM v_silo_volume ORDER BY urutan',
  );

  if (!volumeAcuan || Object.keys(volumeAcuan).length === 0) {
    return {
      kode: 'V-1',
      judul: 'Volume silo sama dengan Power Apps',
      status: 'TIDAK DAPAT DIPERIKSA',
      pesan:
        'Volume acuan dari Power Apps belum diberikan. Isi berkas acuan saat '
        + 'pembekuan input, lalu jalankan ulang verifikasi.',
      bukti: baris.map((b) => ({ silo: b.silo_name, sistemBaru: angka(b.vol_aktual_ltr) })),
    };
  }

  const selisih = [];
  for (const b of baris) {
    const acuan = volumeAcuan[b.silo_name] ?? volumeAcuan[b.kode];
    if (acuan === undefined) continue;
    const beda = Math.round((angka(b.vol_aktual_ltr) - Number(acuan)) * 100) / 100;
    if (beda !== 0) {
      selisih.push({ silo: b.silo_name, sistemBaru: angka(b.vol_aktual_ltr), powerApps: Number(acuan), selisih: beda });
    }
  }

  return {
    kode: 'V-1',
    judul: 'Volume silo sama dengan Power Apps',
    status: selisih.length === 0 ? 'LULUS' : 'GAGAL',
    pesan: selisih.length === 0
      ? 'Seluruh silo sama persis.'
      : `${selisih.length} silo berbeda volumenya.`,
    bukti: selisih,
  };
}

/**
 * V-2 Jumlah baris per tabel cocok dengan jumlah item SharePoint, dikurangi
 * pengecualian yang terdokumentasi.
 */
export async function v2(laporan) {
  const tabel = {
    receiving: 'receiving',
    prepast: 'prepast_record',
    transfer: 'transfer',
    monitoring: 'monitoring',
    stockOpname: 'stock_opname',
  };

  const bukti = [];
  let gagal = 0;
  let dilewati = 0;

  for (const [list, nama] of Object.entries(tabel)) {
    const [b] = await pool.query(`SELECT COUNT(*) AS n FROM \`${nama}\``);
    const diMysql = Number(b[0].n);
    const diSumber = laporan?.ringkasan?.barisSumber?.[list] ?? null;
    const semua = laporan ? laporan.perList(list) : [];
    // Hanya yang benar-benar menolak barisnya. Peringatan - batch yang tidak
    // terpetakan, alokasi yang tidak menutup volumenya - barisnya tetap dimuat.
    const ditolak = semua.filter((p) => p.ditolak !== false).length;
    const peringatan = semua.length - ditolak;

    if (semua.some((p) => p.dilewati)) {
      bukti.push({ list, diMysql, catatan: 'sengaja tidak diekspor, datanya tidak ikut pindah' });
      dilewati += 1;
      continue;
    }

    if (diSumber === null) {
      bukti.push({ list, diMysql, diSumber: null, ditolak, catatan: 'sumber tidak terbaca' });
      gagal += 1;
      continue;
    }

    const seharusnya = diSumber - ditolak;
    const cocok = diMysql === seharusnya;
    if (!cocok) gagal += 1;

    bukti.push({ list, diSumber, ditolak, peringatan, seharusnya, diMysql, cocok });
  }

  /*
   * List yang sengaja tidak diekspor TIDAK dinyatakan LULUS.
   *
   * Tabelnya memang kosong sesuai keputusan yang sudah diambil, jadi menyebutnya
   * GAGAL akan memblokir cutover atas hal yang justru sudah disetujui. Tetapi
   * menyebutnya LULUS akan menyembunyikan adanya data yang tidak ikut pindah,
   * tepat di berkas yang dilampirkan saat menyetujui cutover (T-22).
   */
  const status = gagal > 0 ? 'GAGAL' : (dilewati > 0 ? 'PERLU REVIEW' : 'LULUS');
  const pesan = gagal > 0
    ? `${gagal} tabel tidak cocok.`
    : (dilewati > 0
      ? `Tabel yang diekspor cocok. ${dilewati} list sengaja tidak diekspor dan perlu disetujui.`
      : 'Seluruh tabel cocok.');

  return {
    kode: 'V-2',
    judul: 'Jumlah baris cocok dengan sumber',
    status,
    pesan,
    bukti,
  };
}

/**
 * V-3 Setiap prepast punya induk receiving yang valid, KECUALI anak
 * PINDAH SILO.
 *
 * Pengecualian itu bukan kelonggaran: anak pindah silo memang tidak lahir dari
 * batch penerimaan, ia lahir dari batch prepast di silo lain.
 */
export async function v3() {
  const [yatim] = await pool.query(
    `SELECT p.id, p.kode, p.silo_tujuan_id, p.vol_prepast_ltr
       FROM prepast_record p
      WHERE p.jenis_batch = 'PREPAST'
        AND p.receiving_id IS NULL
        AND p.parent_prepast_id IS NULL
        AND p.transfer_ref_id IS NULL`,
  );

  return {
    kode: 'V-3',
    judul: 'Prepast punya induk penerimaan yang sah',
    status: yatim.length === 0 ? 'LULUS' : 'GAGAL',
    pesan: yatim.length === 0
      ? 'Seluruh prepast punya induk, atau merupakan anak pindah silo.'
      : `${yatim.length} prepast tanpa induk dan bukan anak pindah silo.`,
    bukti: yatim.map((p) => ({ kode: p.kode, volumeLtr: angka(p.vol_prepast_ltr) })),
  };
}

/** V-4 SUM(transfer_allocation.qty_allocated) per transfer = transfer.vol_ltr. */
export async function v4() {
  const [beda] = await pool.query(
    `SELECT t.kode, t.vol_ltr,
            COALESCE(SUM(a.qty_allocated), 0) AS teralokasi,
            COUNT(a.id) AS jumlah_alokasi
       FROM transfer t
       LEFT JOIN transfer_allocation a ON a.transfer_id = t.id
      WHERE t.status_approval NOT IN ('VOIDED', 'REVISED', 'Rejected')
      GROUP BY t.id, t.kode, t.vol_ltr
     HAVING ABS(COALESCE(SUM(a.qty_allocated), 0) - t.vol_ltr) > 0.01`,
  );

  return {
    kode: 'V-4',
    judul: 'Alokasi FIFO menutup volume transfer',
    status: beda.length === 0 ? 'LULUS' : 'GAGAL',
    pesan: beda.length === 0
      ? 'Seluruh transfer teralokasi penuh.'
      : `${beda.length} transfer selisih antara alokasi dan volumenya.`,
    bukti: beda.map((t) => ({
      kode: t.kode,
      volumeLtr: angka(t.vol_ltr),
      teralokasiLtr: angka(t.teralokasi),
      selisihLtr: Math.round((angka(t.teralokasi) - angka(t.vol_ltr)) * 100) / 100,
      jumlahAlokasi: Number(t.jumlah_alokasi),
    })),
  };
}

/** V-5 Tidak ada qty_remaining_ltr negatif atau melebihi volume asalnya. */
export async function v5() {
  const [rcv] = await pool.query(
    `SELECT kode, qty_ltr, qty_remaining_ltr FROM receiving
      WHERE qty_remaining_ltr < 0 OR qty_remaining_ltr > qty_ltr + 0.01`,
  );
  const [pst] = await pool.query(
    `SELECT kode, vol_prepast_ltr, qty_remaining_ltr FROM prepast_record
      WHERE qty_remaining_ltr < 0 OR qty_remaining_ltr > vol_prepast_ltr + 0.01`,
  );

  const bukti = [
    ...rcv.map((r) => ({
      modul: 'receiving', kode: r.kode,
      volumeLtr: angka(r.qty_ltr), sisaLtr: angka(r.qty_remaining_ltr),
    })),
    ...pst.map((p) => ({
      modul: 'prepast', kode: p.kode,
      volumeLtr: angka(p.vol_prepast_ltr), sisaLtr: angka(p.qty_remaining_ltr),
    })),
  ];

  return {
    kode: 'V-5',
    judul: 'Sisa batch masuk akal',
    status: bukti.length === 0 ? 'LULUS' : 'GAGAL',
    pesan: bukti.length === 0
      ? 'Tidak ada sisa negatif maupun melebihi volume asalnya.'
      : `${bukti.length} batch bersisa tidak masuk akal.`,
    bukti,
  };
}

/**
 * V-6 Setiap silo dengan volume > 0 dan standing_time_anchor NULL masuk
 * laporan review.
 *
 * Ini PERINGATAN, bukan kegagalan. Anchor yang kosong berarti standing time
 * tidak dapat dihitung untuk silo itu sampai ada pergerakan berikutnya - perlu
 * diketahui manusia, tetapi tidak menghalangi cutover.
 */
export async function v6() {
  const [baris] = await pool.query(
    `SELECT v.silo_name, v.vol_aktual_ltr
       FROM v_silo_volume v
      WHERE v.is_buffer = FALSE
        AND v.vol_aktual_ltr > 0
        AND v.standing_time_anchor IS NULL`,
  );

  return {
    kode: 'V-6',
    judul: 'Silo berisi tanpa jangkar standing time',
    status: baris.length === 0 ? 'LULUS' : 'PERLU REVIEW',
    pesan: baris.length === 0
      ? 'Seluruh silo berisi punya jangkar.'
      : `${baris.length} silo berisi tanpa jangkar; standing time-nya belum dapat dihitung.`,
    bukti: baris.map((b) => ({ silo: b.silo_name, volumeLtr: angka(b.vol_aktual_ltr) })),
  };
}

/**
 * Menjalankan seluruh kriteria.
 *
 * @param {object} opsi
 * @param {object} [opsi.laporan]       hasil muatSemua(), untuk V-2
 * @param {object} [opsi.volumeAcuan]   volume per silo dari Power Apps, untuk V-1
 */
export async function verifikasiSemua({ laporan, volumeAcuan } = {}) {
  const hasil = [
    await v1(volumeAcuan),
    await v2(laporan),
    await v3(),
    await v4(),
    await v5(),
    await v6(),
  ];

  const gagal = hasil.filter((h) => h.status === 'GAGAL');
  const perluPerhatian = hasil.filter(
    (h) => h.status === 'PERLU REVIEW' || h.status === 'TIDAK DAPAT DIPERIKSA',
  );

  return {
    hasil,
    lulus: gagal.length === 0,
    jumlahGagal: gagal.length,
    jumlahPerluPerhatian: perluPerhatian.length,
    // Cutover boleh berjalan hanya bila tidak ada yang GAGAL. Yang berstatus
    // PERLU REVIEW ditinjau manusia (T-22), tidak memblokir.
    bolehCutover: gagal.length === 0,
  };
}
