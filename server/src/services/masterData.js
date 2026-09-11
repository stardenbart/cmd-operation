/**
 * Manajemen master data - FR-26
 *
 * Modul ini tidak punya padanan di Power Apps, dan itu bukan penambahan
 * cakupan. Selama data berada di SharePoint, seluruh master (silo, supplier,
 * operator) dapat disunting lewat antarmuka SharePoint List secara cuma-cuma.
 * Begitu pindah ke MySQL antarmuka itu hilang, dan tanpa penggantinya setiap
 * penambahan supplier menuntut intervensi DBA.
 *
 * SATU MESIN, BUKAN TUJUH HALAMAN. Perbedaan antar master hanya pada kolom dan
 * beberapa aturannya; menyalin logika daftar, cari, audit, dan penonaktifan ke
 * tujuh tempat berarti tujuh tempat yang harus dijaga tetap sepaham. Yang
 * berbeda dinyatakan sebagai data di `MASTER`, yang sama dikerjakan sekali.
 *
 * TIDAK ADA PENGHAPUSAN, hanya penonaktifan (FR-26.2.1). Master data yang
 * pernah menyentuh transaksi adalah bagian dari catatan mutu: menghapus
 * supplier berarti membuat baris form lama kehilangan nama pemasoknya.
 */

import argon2 from 'argon2';
import { pool, withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import {
  pastikanBerwenang, AKSI, PERAN, aksiUntukPeran, customPermissionsBersih, KATALOG_AKSI,
} from '../auth/permissions.js';
import { bangkitkanPasswordSementara } from '../auth/password.js';
import { config } from '../config.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';

/** Jenis kolom yang dikenal antarmuka. */
const T = {
  teks: 'teks',
  angka: 'angka',
  desimal: 'desimal',
  boolean: 'boolean',
  // Sama seperti boolean (divalidasi & disimpan identik — lihat JENIS_BOOLEAN
  // di bawah), tapi dirender sebagai switch on/off, bukan checkbox. Dipakai
  // untuk field yang maknanya "aktifkan/nonaktifkan aturan", bukan sekadar
  // atribut ya/tidak.
  sakelar: 'sakelar',
  pilihan: 'pilihan',
  tanggal: 'tanggal',
  teksPanjang: 'teksPanjang',
};

/** boolean dan sakelar divalidasi & disimpan dengan cara yang sama. */
const JENIS_BOOLEAN = [T.boolean, T.sakelar];

/**
 * Definisi tiap master.
 *
 * `pemakaian` menyebut dari mana entri ini dirujuk transaksi. Dipakai untuk
 * memberi tahu Admin berapa banyak transaksi yang bergantung padanya sebelum
 * ia menonaktifkannya - bukan untuk mencegah, sebab penonaktifan memang tidak
 * memengaruhi data historis.
 */
export const MASTER = Object.freeze({
  users: {
    label: 'User',
    tabel: 'operator',
    urut: 'nama_lengkap',
    cari: ['kode', 'nama_lengkap'],
    kolom: [
      { k: 'kode', label: 'Kode / NIK', jenis: T.teks, wajib: true, unik: true, maks: 20 },
      { k: 'username', label: 'Username', jenis: T.teks, wajib: true, maks: 60,
        bantuan: 'Dipakai untuk login. Harus unik.' },
      { k: 'nama_lengkap', label: 'Nama lengkap', jenis: T.teks, wajib: true, maks: 120 },
      {
        k: 'role',
        label: 'Peran',
        jenis: T.pilihan,
        wajib: true,
        pilihan: [PERAN.OPERATOR, PERAN.SPV, PERAN.ADMIN, PERAN.VIEWER],
        bantuan: 'Perubahan peran berlaku pada sesi berikutnya (FR-26.2.7)',
      },
      { k: 'is_active', label: 'Aktif', jenis: T.boolean, bawaan: true },
    ],
    // Kolom yang tidak pernah dikirim ke klien
    rahasia: ['password_hash'],
    pemakaian: [
      { tabel: 'receiving', kolom: 'operator_id' },
      { tabel: 'prepast_record', kolom: 'operator_id' },
      { tabel: 'transfer', kolom: 'operator_id' },
      { tabel: 'monitoring', kolom: 'operator_id' },
    ],
  },

  suppliers: {
    label: 'Supplier',
    tabel: 'supplier',
    urut: 'supplier_name',
    cari: ['kode', 'supplier_name'],
    kolom: [
      { k: 'kode', label: 'Kode', jenis: T.teks, wajib: true, unik: true, maks: 20 },
      { k: 'supplier_name', label: 'Nama supplier', jenis: T.teks, wajib: true, maks: 150 },
      { k: 'is_active', label: 'Aktif', jenis: T.boolean, bawaan: true },
    ],
    pemakaian: [
      { tabel: 'receiving', kolom: 'supplier_id' },
      { tabel: 'prepast_record', kolom: 'supplier_id' },
    ],
  },

  silos: {
    label: 'Silo',
    tabel: 'silo',
    urut: 'urutan',
    cari: ['kode', 'silo_name'],
    kolom: [
      { k: 'kode', label: 'Kode', jenis: T.teks, wajib: true, unik: true, maks: 20 },
      { k: 'silo_name', label: 'Nama tampilan', jenis: T.teks, wajib: true, maks: 80 },
      { k: 'qr_code_value', label: 'Nilai QR', jenis: T.teks, maks: 80 },
      { k: 'kapasitas_maks_ltr', label: 'Kapasitas nominal (L)', jenis: T.desimal, wajib: true },
      {
        k: 'toleransi_aktif',
        label: 'Toleransi aktif',
        jenis: T.sakelar,
        bawaan: true,
        bantuan: 'Nonaktifkan untuk melarang pengisian di atas kapasitas nominal (BR-24)',
      },
      {
        k: 'toleransi_ltr',
        label: 'Toleransi (L)',
        jenis: T.desimal,
        bantuan: 'Kelebihan yang masih dapat diterima di atas nominal, selama switch di atas aktif (BR-24)',
        // Nilainya tetap tersimpan saat switch dimatikan — hanya inputnya yang
        // dikunci di layar, supaya tidak perlu diketik ulang saat dinyalakan
        // lagi. Yang membuatnya benar-benar tidak berlaku adalah v_silo_volume
        // (lihat migrasi 026), bukan pengosongan nilai ini.
        nonaktifJika: { kolom: 'toleransi_aktif', nilai: false },
      },
      {
        k: 'monitoring_interval_jam',
        label: 'Interval monitoring (jam)',
        jenis: T.angka,
        wajib: true,
        bantuan:
          'BR-10. Disimpan sebagai angka, BUKAN dicocokkan dari nama silo - ' +
          'pencocokan nama itulah akar B-19',
      },
      { k: 'urutan', label: 'Urutan tampil', jenis: T.angka },
      { k: 'is_available', label: 'Tersedia dipakai', jenis: T.boolean, bawaan: true },
      { k: 'is_active', label: 'Aktif', jenis: T.boolean, bawaan: true },
      { k: 'notes', label: 'Catatan', jenis: T.teksPanjang },
    ],
    // is_buffer tidak dapat disunting: BR-02 menggantungkan seluruh alur
    // penerimaan padanya, dan mengubahnya lewat layar master akan memindahkan
    // tujuan penerimaan tanpa ada yang menyadarinya.
    terkunci: ['is_buffer'],
    pemakaian: [
      { tabel: 'receiving', kolom: 'silo_id' },
      { tabel: 'prepast_record', kolom: 'silo_tujuan_id' },
      { tabel: 'transfer', kolom: 'silo_asal_id' },
      { tabel: 'monitoring', kolom: 'silo_id' },
      { tabel: 'stock_opname', kolom: 'silo_id' },
    ],
  },

  tanks: {
    label: 'Tank',
    tabel: 'tank_master',
    urut: 'urutan',
    cari: ['tank_name', 'qr_value'],
    kolom: [
      { k: 'tank_name', label: 'Nama tank', jenis: T.teks, wajib: true, unik: true, maks: 40 },
      { k: 'qr_value', label: 'Nilai QR', jenis: T.teks, maks: 40 },
      { k: 'tank_trf_value', label: 'Nilai transfer', jenis: T.teks, maks: 40 },
      {
        k: 'cmd_destination',
        label: 'Tujuan CMD',
        jenis: T.pilihan,
        wajib: true,
        pilihan: ['CMD1', 'CMD2'],
        bantuan: 'Menentukan penandaan CMD2 pada transfer (BR-18)',
      },
      { k: 'urutan', label: 'Urutan tampil', jenis: T.angka },
      { k: 'is_active', label: 'Aktif', jenis: T.boolean, bawaan: true },
    ],
    pemakaian: [{ tabel: 'transfer', kolom: 'tank_id' }],
  },

  'batch-prefixes': {
    label: 'Prefiks batch',
    tabel: 'batch_prefix',
    urut: 'urutan',
    cari: ['kode', 'label'],
    kolom: [
      { k: 'kode', label: 'Kode', jenis: T.teks, wajib: true, unik: true, maks: 10, hurufBesar: true },
      { k: 'label', label: 'Label', jenis: T.teks, wajib: true, maks: 80 },
      {
        k: 'is_standar',
        label: 'Baku',
        jenis: T.boolean,
        bantuan: 'Prefiks baku ditawarkan lebih dulu saat input transfer (BR-21)',
      },
      { k: 'urutan', label: 'Urutan tampil', jenis: T.angka },
      { k: 'is_active', label: 'Aktif', jenis: T.boolean, bawaan: true },
    ],
    // Batch pada transfer disimpan sebagai teks, bukan foreign key, jadi
    // pemakaiannya dihitung dengan pencocokan awalan.
    pemakaianAwalan: { tabel: 'transfer', kolom: 'batch', dari: 'kode' },
  },

  'form-templates': {
    label: 'Template form',
    tabel: 'form_template',
    urut: 'berlaku_mulai',
    cari: ['kode_form', 'revisi', 'judul'],
    kolom: [
      { k: 'kode_form', label: 'Nomor dokumen', jenis: T.teks, wajib: true, maks: 40 },
      { k: 'revisi', label: 'Revisi', jenis: T.teks, wajib: true, maks: 10 },
      { k: 'berlaku_mulai', label: 'Berlaku mulai', jenis: T.tanggal, wajib: true },
      { k: 'berlaku_sampai', label: 'Berlaku sampai', jenis: T.tanggal },
      { k: 'judul', label: 'Judul', jenis: T.teks, wajib: true, maks: 200 },
      { k: 'keterangan', label: 'Catatan kaki', jenis: T.teksPanjang },
    ],
    // Tidak punya kolom is_active; masa berlakunya yang menentukan
    tanpaAktif: true,
  },
});

function definisi(master) {
  const def = MASTER[master];
  if (!def) throw new BusinessError('VALIDATION_ERROR', `Master tidak dikenal: ${master}`);
  return def;
}

/** Kolom yang dikirim ke klien: seluruh kolom definisi, tanpa yang rahasia. */
function kolomTampil(def) {
  return def.kolom.map((k) => k.k);
}

/** Menghitung berapa transaksi yang merujuk satu entri. */
async function hitungPemakaian(conn, def, id, kodeEntri) {
  let total = 0;

  for (const p of def.pemakaian ?? []) {
    const [baris] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${p.tabel}\` WHERE \`${p.kolom}\` = ?`,
      [id],
    );
    total += Number(baris[0].n);
  }

  if (def.pemakaianAwalan && kodeEntri) {
    const [baris] = await conn.query(
      `SELECT COUNT(*) AS n FROM \`${def.pemakaianAwalan.tabel}\`
        WHERE \`${def.pemakaianAwalan.kolom}\` LIKE ?`,
      [`${kodeEntri}%`],
    );
    total += Number(baris[0].n);
  }

  return total;
}

/** Daftar entri, dapat dicari & disaring - FR-26.2.9. */
export async function daftar(master, { cari, status } = {}) {
  const def = definisi(master);
  const kolom = kolomTampil(def);

  const syarat = [];
  const nilai = [];

  if (cari && def.cari.length > 0) {
    syarat.push(`(${def.cari.map((k) => `\`${k}\` LIKE ?`).join(' OR ')})`);
    def.cari.forEach(() => nilai.push(`%${cari}%`));
  }
  if (!def.tanpaAktif && (status === 'aktif' || status === 'nonaktif')) {
    syarat.push('is_active = ?');
    nilai.push(status === 'aktif');
  }

  // FR-34.3.6: hak akses custom ikut dikirim untuk master user, agar Admin
  // melihat siapa yang punya pengecualian dan form dapat mencentang yang aktif.
  const kolomEkstra = master === 'users' ? ', custom_permissions' : '';
  const [baris] = await pool.query(
    `SELECT id, ${kolom.map((k) => `\`${k}\``).join(', ')}${kolomEkstra}, updated_at
       FROM \`${def.tabel}\`
      ${syarat.length ? `WHERE ${syarat.join(' AND ')}` : ''}
      ORDER BY \`${def.urut}\``,
    nilai,
  );

  // Pemakaian dihitung untuk seluruh baris supaya Admin melihat dampaknya
  // sebelum menonaktifkan, bukan setelah.
  const data = [];
  for (const b of baris) {
    if (master === 'users') b.custom_permissions = aturArrayAksi(b.custom_permissions);
    data.push({
      ...b,
      jumlahPemakaian: await hitungPemakaian(pool, def, b.id, b.kode),
    });
  }

  return {
    master,
    label: def.label,
    kolom: def.kolom,
    terkunci: def.terkunci ?? [],
    tanpaAktif: Boolean(def.tanpaAktif),
    data,
    total: data.length,
  };
}

/** Membersihkan & memvalidasi payload terhadap definisi kolom. */
function siapkanNilai(def, masukan, { wajibLengkap }) {
  const hasil = {};

  for (const k of def.kolom) {
    if ((def.terkunci ?? []).includes(k.k)) continue;

    const adaDiMasukan = Object.hasOwn(masukan, k.k);
    if (!adaDiMasukan) {
      if (wajibLengkap && k.wajib) {
        throw new BusinessError('FR-26', `${k.label} wajib diisi`);
      }
      continue;
    }

    let v = masukan[k.k];

    if (JENIS_BOOLEAN.includes(k.jenis)) {
      hasil[k.k] = Boolean(v);
      continue;
    }

    if (v === '' || v === null || v === undefined) {
      if (k.wajib) throw new BusinessError('FR-26', `${k.label} wajib diisi`);
      hasil[k.k] = null;
      continue;
    }

    if (k.jenis === T.angka || k.jenis === T.desimal) {
      const n = Number(String(v).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) {
        throw new BusinessError('FR-26', `${k.label} harus angka nol atau lebih`);
      }
      hasil[k.k] = k.jenis === T.angka ? Math.round(n) : n;
      continue;
    }

    if (k.jenis === T.pilihan && !k.pilihan.includes(v)) {
      throw new BusinessError(
        'FR-26',
        `${k.label} harus salah satu dari: ${k.pilihan.join(', ')}`,
      );
    }

    v = String(v).trim();
    if (k.hurufBesar) v = v.toUpperCase();
    if (k.maks && v.length > k.maks) {
      throw new BusinessError('FR-26', `${k.label} maksimal ${k.maks} karakter`);
    }
    hasil[k.k] = v;
  }

  return hasil;
}

/** Menolak kode ganda sebelum basis data menolaknya dengan pesan teknis. */
async function pastikanUnik(conn, def, nilai, idKecuali = null) {
  for (const k of def.kolom.filter((x) => x.unik)) {
    if (nilai[k.k] === undefined) continue;
    const [baris] = await conn.query(
      `SELECT id FROM \`${def.tabel}\` WHERE \`${k.k}\` = ? ${idKecuali ? 'AND id <> ?' : ''}`,
      idKecuali ? [nilai[k.k], idKecuali] : [nilai[k.k]],
    );
    if (baris[0]) {
      throw new BusinessError('FR-26', `${k.label} "${nilai[k.k]}" sudah dipakai entri lain`);
    }
  }
}

/**
 * Aturan khusus per master, dijalankan sebelum menulis.
 *
 * Sengaja terkumpul di satu tempat dan diberi nama, bukan tersebar sebagai
 * kondisi di dalam alur umum: masing-masing punya alasan yang perlu terbaca.
 */
async function aturanKhusus(conn, master, { lama, baru, aktor }) {
  if (master === 'silos' && baru.kapasitas_maks_ltr !== undefined && lama) {
    // FR-26.2.6 - kapasitas tidak boleh diturunkan di bawah isi yang ada
    const [vol] = await conn.query(
      'SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?',
      [lama.id],
    );
    const isi = Number(vol[0]?.vol_aktual_ltr ?? 0);
    const baruKapasitas = Number(baru.kapasitas_maks_ltr);
    const baruToleransi = Number(
      baru.toleransi_ltr ?? lama.toleransi_ltr ?? 0,
    );

    if (isi > baruKapasitas + baruToleransi) {
      throw new BusinessError(
        'FR-26.2.6',
        `${lama.silo_name} sedang berisi ${isi} L, sehingga kapasitasnya tidak ` +
          `dapat diturunkan menjadi ${baruKapasitas} L (batas keras ` +
          `${baruKapasitas + baruToleransi} L).`,
        { volumeSaatIniLtr: isi },
      );
    }
  }

  if (master === 'users' && lama) {
    // Menonaktifkan diri sendiri akan mengunci Admin keluar dari sistemnya
    // sendiri, dan tidak ada yang dapat memulihkannya dari dalam.
    if (baru.is_active === false && lama.id === aktor.id) {
      throw new BusinessError(
        'FR-26',
        'Anda tidak dapat menonaktifkan akun Anda sendiri.',
      );
    }

    // Sistem harus selalu punya minimal satu Admin aktif, kalau tidak master
    // data menjadi tidak dapat dikelola siapa pun.
    const kehilanganAdmin =
      lama.role === PERAN.ADMIN &&
      (baru.is_active === false || (baru.role && baru.role !== PERAN.ADMIN));

    if (kehilanganAdmin) {
      const [sisa] = await conn.query(
        `SELECT COUNT(*) AS n FROM operator
          WHERE role = ? AND is_active = TRUE AND id <> ?`,
        [PERAN.ADMIN, lama.id],
      );
      if (Number(sisa[0].n) === 0) {
        throw new BusinessError(
          'FR-26',
          'Ini satu-satunya Admin yang aktif. Tunjuk Admin lain lebih dahulu, ' +
            'kalau tidak master data tidak dapat dikelola siapa pun.',
        );
      }
    }
  }

  if (master === 'silos' && baru.is_active === false && lama) {
    const [vol] = await conn.query(
      'SELECT vol_aktual_ltr FROM v_silo_volume WHERE silo_id = ?',
      [lama.id],
    );
    const isi = Number(vol[0]?.vol_aktual_ltr ?? 0);
    if (isi > 0) {
      throw new BusinessError(
        'FR-26',
        `${lama.silo_name} masih berisi ${isi} L. Kosongkan lebih dahulu ` +
          'sebelum menonaktifkannya.',
        { volumeSaatIniLtr: isi },
      );
    }
  }
}

async function ambilEntri(conn, def, id) {
  const [baris] = await conn.query(`SELECT * FROM \`${def.tabel}\` WHERE id = ?`, [id]);
  if (!baris[0]) throw new NotFoundError(def.label);
  return baris[0];
}

/** Membuang kolom rahasia dari objek yang dikembalikan maupun dicatat audit. */
function tanpaRahasia(def, baris) {
  if (!baris) return baris;
  const salinan = { ...baris };
  for (const k of def.rahasia ?? []) delete salinan[k];
  return salinan;
}

/** Menormalkan kolom JSON custom_permissions menjadi array (FR-34). */
function aturArrayAksi(nilai) {
  if (Array.isArray(nilai)) return nilai;
  if (typeof nilai === 'string' && nilai.trim()) {
    try {
      const hasil = JSON.parse(nilai);
      return Array.isArray(hasil) ? hasil : [];
    } catch { return []; }
  }
  return [];
}

export async function buat(master, masukan, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.MASTER_KELOLA);
  const def = definisi(master);
  const nilai = siapkanNilai(def, masukan, { wajibLengkap: true });

  // Kolom boolean yang tidak dikirim mengambil nilai bawaannya
  for (const k of def.kolom) {
    if (JENIS_BOOLEAN.includes(k.jenis) && nilai[k.k] === undefined && k.bawaan !== undefined) {
      nilai[k.k] = k.bawaan;
    }
  }

  return withTransaction(async (conn) => {
    await pastikanUnik(conn, def, nilai);
    await aturanKhusus(conn, master, { lama: null, baru: nilai, aktor });

    /*
     * User baru TIDAK dapat dibuat tanpa password, dan passwordnya tidak boleh
     * ditentukan Admin: password adalah kredensial pemiliknya (FR-1.1). Jadi
     * password sementara dibangkitkan acak, ditampilkan SEKALI, dan wajib
     * diganti saat login pertama.
     */
    let passwordSementara = null;
    if (master === 'users') {
      passwordSementara = bangkitkanPasswordSementara();
      nilai.password_hash = await argon2.hash(passwordSementara, { type: argon2.argon2id });
      nilai.must_change_password = true;
    }

    const kolom = Object.keys(nilai);
    const [hasil] = await conn.query(
      `INSERT INTO \`${def.tabel}\` (${kolom.map((k) => `\`${k}\``).join(', ')})
       VALUES (${kolom.map(() => '?').join(', ')})`,
      kolom.map((k) => nilai[k]),
    );

    const baru = await ambilEntri(conn, def, hasil.insertId);

    await catatAudit(conn, {
      entity: def.tabel,
      entityId: hasil.insertId,
      action: 'CREATE',
      actorId: aktor.id,
      after: tanpaRahasia(def, baru),
      reason: `Master ${def.label} dibuat`,
      ip,
    });

    return { data: tanpaRahasia(def, baru), passwordSementara };
  });
}

export async function perbarui(master, id, masukan, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.MASTER_KELOLA);
  const def = definisi(master);
  const nilai = siapkanNilai(def, masukan, { wajibLengkap: false });

  if (Object.keys(nilai).length === 0) {
    throw new BusinessError('FR-26', 'Tidak ada nilai yang diubah');
  }

  return withTransaction(async (conn) => {
    const lama = await ambilEntri(conn, def, id);
    await pastikanUnik(conn, def, nilai, id);
    await aturanKhusus(conn, master, { lama, baru: nilai, aktor });

    const kolom = Object.keys(nilai);
    await conn.query(
      `UPDATE \`${def.tabel}\` SET ${kolom.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`,
      [...kolom.map((k) => nilai[k]), id],
    );

    let baru = await ambilEntri(conn, def, id);

    // FR-34.3.5: peran berubah -> hak akses custom yang kini sudah dimiliki
    // peran baru dibersihkan agar tidak redundan.
    if (master === 'users' && lama.role !== baru.role) {
      const bersih = customPermissionsBersih(baru.role, aturArrayAksi(lama.custom_permissions));
      await conn.query('UPDATE operator SET custom_permissions = ? WHERE id = ?', [
        bersih.length ? JSON.stringify(bersih) : null, id,
      ]);
      baru = await ambilEntri(conn, def, id);
    }

    // Yang dicatat hanya kolom yang BERUBAH. Menyalin seluruh baris ke jejak
    // audit membuat perubahan satu kolom tenggelam di antara belasan kolom
    // yang sama persis.
    const berubah = {};
    for (const k of kolom) {
      if (String(lama[k] ?? '') !== String(baru[k] ?? '')) {
        berubah[k] = { dari: lama[k], menjadi: baru[k] };
      }
    }

    await catatAudit(conn, {
      entity: def.tabel,
      entityId: id,
      action: 'UPDATE',
      actorId: aktor.id,
      before: tanpaRahasia(def, lama),
      after: { perubahan: berubah },
      reason: `Master ${def.label} diperbarui`,
      ip,
    });

    return {
      data: tanpaRahasia(def, baru),
      perubahan: berubah,
      // FR-26.2.7 - perubahan peran baru berlaku pada sesi berikutnya
      catatan:
        master === 'users' && berubah.role
          ? 'Perubahan peran berlaku pada sesi berikutnya; sesi yang sedang berjalan tidak berubah.'
          : null,
    };
  });
}



/**
 * Reset PIN - FR-26.2.5.
 *
 * PIN lama tidak pernah dapat dilihat siapa pun, termasuk Admin: yang
 * tersimpan hanya hash argon2id. PIN sementara ditampilkan SEKALI di respons
 * ini dan tidak pernah ditulis ke tabel mana pun, termasuk jejak audit -
 * jejak audit yang memuat PIN akan membuat tanda tangan elektronik dapat
 * dipakai orang lain.
 */
export async function resetPassword(id, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.MASTER_KELOLA);
  const def = definisi('users');

  return withTransaction(async (conn) => {
    const lama = await ambilEntri(conn, def, id);
    const password = bangkitkanPasswordSementara();
    const hash = await argon2.hash(password, { type: argon2.argon2id });

    await conn.query(
      `UPDATE operator
          SET password_hash = ?, must_change_password = TRUE,
              failed_attempts = 0, locked_until = NULL
        WHERE id = ?`,
      [hash, id],
    );

    /*
     * Sesi yang sedang berjalan ikut dicabut.
     *
     * Reset dilakukan karena pemiliknya tidak dapat masuk, atau karena
     * kredensialnya dicurigai bocor. Pada kemungkinan kedua, membiarkan sesi
     * lama tetap hidup berarti reset ini tidak mengusir siapa pun.
     */
    await conn.query(
      'UPDATE refresh_token SET revoked_at = UTC_TIMESTAMP() WHERE operator_id = ? AND revoked_at IS NULL',
      [id],
    );

    await catatAudit(conn, {
      entity: 'operator',
      entityId: id,
      action: 'PIN_RESET',
      actorId: aktor.id,
      // Tidak ada before/after berisi password. Yang dicatat PERISTIWANYA.
      after: { kode: lama.kode, username: lama.username, mustChangePassword: true },
      reason: `Reset password untuk ${lama.nama_lengkap}`,
      ip,
    });

    return {
      kode: lama.kode,
      username: lama.username,
      namaLengkap: lama.nama_lengkap,
      passwordSementara: password,
    };
  });
}

/**
 * Mengatur hak akses custom seorang user - FR-34.2, FR-34.3.
 *
 * Aditif saja (BR-27): yang disimpan hanya aksi VALID yang BELUM diberikan
 * peran user itu - yang lain dibuang lewat customPermissionsBersih(). Perubahan
 * dicatat audit (sebelum & sesudah) dan sesi berjalan dicabut agar berlaku pada
 * sesi berikutnya (FR-34.5.4).
 */
export async function aturHakAkses(id, permissions, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.MASTER_KELOLA);
  const def = definisi('users');

  return withTransaction(async (conn) => {
    const lama = await ambilEntri(conn, def, id);
    if (!lama) throw new NotFoundError('User');

    const sebelum = aturArrayAksi(lama.custom_permissions);
    const sesudah = customPermissionsBersih(lama.role, Array.isArray(permissions) ? permissions : []);

    await conn.query('UPDATE operator SET custom_permissions = ? WHERE id = ?', [
      sesudah.length ? JSON.stringify(sesudah) : null, id,
    ]);

    // Berlaku pada sesi berikutnya - sesi berjalan memakai cp lama di JWT-nya.
    await conn.query(
      'UPDATE refresh_token SET revoked_at = UTC_TIMESTAMP() WHERE operator_id = ? AND revoked_at IS NULL',
      [id],
    );

    await catatAudit(conn, {
      entity: 'operator',
      entityId: id,
      action: 'HAK_AKSES',
      actorId: aktor.id,
      before: { customPermissions: sebelum },
      after: { customPermissions: sesudah },
      reason: `Hak akses custom ${lama.nama_lengkap} diperbarui`,
      ip,
    });

    return { id, customPermissions: sesudah };
  });
}

/**
 * Konteks hak akses custom seorang user untuk mengisi form (FR-34.3.1):
 * peran, hak akses custom yang aktif, dan katalog aksi yang MASIH dapat
 * diberikan (seluruh katalog dikurangi yang sudah dimiliki peran).
 */
export async function hakAksesUser(id) {
  const [baris] = await pool.query(
    'SELECT role, custom_permissions FROM operator WHERE id = ?', [id],
  );
  if (!baris[0]) throw new NotFoundError('User');
  const dimiliki = new Set(aksiUntukPeran(baris[0].role));
  return {
    role: baris[0].role,
    customPermissions: aturArrayAksi(baris[0].custom_permissions),
    tersedia: KATALOG_AKSI.filter((x) => !dimiliki.has(x.aksi)),
  };
}

/** Riwayat perubahan satu entri - FR-26.2.3. */
export async function riwayat(master, id) {
  const def = definisi(master);
  const [baris] = await pool.query(
    `SELECT a.id, a.action, a.before_json, a.after_json, a.reason, a.created_at,
            o.nama_lengkap AS aktor_nama
       FROM audit_log a
       JOIN operator o ON o.id = a.actor_id
      WHERE a.entity = ? AND a.entity_id = ?
      ORDER BY a.id DESC`,
    [def.tabel, id],
  );

  const urai = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

  return baris.map((b) => ({
    id: b.id,
    aksi: b.action,
    aktor: b.aktor_nama,
    alasan: b.reason,
    waktu: b.created_at,
    sebelum: b.before_json ? urai(b.before_json) : null,
    sesudah: b.after_json ? urai(b.after_json) : null,
  }));
}

/** Beranda master data - FR-26.1.7. */
export async function ringkasan() {
  const hasil = [];

  for (const [master, def] of Object.entries(MASTER)) {
    const [jumlah] = await pool.query(
      def.tanpaAktif
        ? `SELECT COUNT(*) AS total, 0 AS nonaktif FROM \`${def.tabel}\``
        : `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN is_active = FALSE THEN 1 ELSE 0 END) AS nonaktif
             FROM \`${def.tabel}\``,
    );

    const [terakhir] = await pool.query(
      `SELECT a.created_at, a.action, o.nama_lengkap
         FROM audit_log a
         JOIN operator o ON o.id = a.actor_id
        WHERE a.entity = ?
        ORDER BY a.id DESC LIMIT 1`,
      [def.tabel],
    );

    hasil.push({
      master,
      label: def.label,
      total: Number(jumlah[0].total),
      nonaktif: Number(jumlah[0].nonaktif ?? 0),
      perubahanTerakhir: terakhir[0]
        ? {
          waktu: terakhir[0].created_at,
          aksi: terakhir[0].action,
          aktor: terakhir[0].nama_lengkap,
        }
        : null,
    });
  }

  return hasil;
}

/** Isi satu master sebagai CSV - FR-26.2.8. */
export async function keCsv(master) {
  const def = definisi(master);
  const isi = await daftar(master, {});
  const kolom = kolomTampil(def);

  const kutip = (v) => {
    if (v === null || v === undefined) return '';
    const t = typeof v === 'boolean' ? (v ? 'ya' : 'tidak') : String(v);
    return /[",\n;]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };

  const kepala = ['id', ...def.kolom.map((k) => k.label), 'jumlah_pemakaian'];
  const baris = isi.data.map((d) =>
    [d.id, ...kolom.map((k) => kutip(d[k])), d.jumlahPemakaian].join(';'),
  );

  // Titik koma dan BOM: Excel berbahasa Indonesia membuka CSV berkoma sebagai
  // satu kolom, dan tanpa BOM nama beraksen rusak.
  return `﻿${kepala.join(';')}\n${baris.join('\n')}\n`;
}
