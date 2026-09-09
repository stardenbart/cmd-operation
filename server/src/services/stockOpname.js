/**
 * Stock Opname - FR-8, FR-24, BR-20, memperbaiki B-2 & B-3
 *
 * Volume awal bulan per silo, hasil hitung fisik. Satu-satunya input Admin
 * (D-14), dan kelak menjadi sumber kolom "Jumlah Awal (lt)" pada form GMP
 * serta dasar rekonsiliasi susut (L-1, D-15).
 *
 * Dua bug pada layar lama diperbaiki di sini, dan keduanya struktural:
 *
 *  B-2  Upsert-nya tidak pernah bekerja. Formulanya
 *       `If(silo_number, Patch(..., LookUp(..., ID = silo_number), ...))`
 *       memakai `silo_number` (teks) sekaligus sebagai kondisi boolean dan
 *       sebagai pencocok ke kolom `ID` yang bertipe angka. Di sini keunikannya
 *       ditegakkan basis data lewat UNIQUE (periode, silo_id), bukan oleh
 *       formula yang harus benar setiap kali ditulis ulang.
 *
 *  B-3  `Notify()` validasinya tidak menghentikan eksekusi, sehingga
 *       penyimpanan tetap berjalan meski ada field kosong. Perbaikannya bukan
 *       sekadar mengganti Notify dengan pemeriksaan yang memblokir, melainkan
 *       MEMISAHKAN dua tindakan yang selama ini menyatu (WF-12): menyimpan satu
 *       baris tidak menuntut seluruh silo terisi, sedangkan memfinalisasi
 *       periode menuntutnya. Dengan begitu Admin dapat mengisi bertahap tanpa
 *       kehilangan pekerjaan, dan periode yang belum lengkap tidak mungkin
 *       terkunci.
 */

import { pool, withTransaction } from '../db/pool.js';
import { catatAudit } from './audit.js';
import { pastikanBerwenang, AKSI } from '../auth/permissions.js';
import { BusinessError, NotFoundError } from '../middleware/errors.js';

const POLA_PERIODE = /^\d{4}-(0[1-9]|1[0-2])$/;

function pastikanPeriode(periode) {
  if (!POLA_PERIODE.test(periode ?? '')) {
    throw new BusinessError(
      'FR-8.1',
      `Periode harus berbentuk YYYY-MM, diterima: ${periode}`,
    );
  }
}

/**
 * Silo yang wajib dihitung.
 *
 * Buffer dikecualikan (FR-8.2): ia bukan tempat penyimpanan, isinya batch yang
 * belum diprepast dan sudah punya catatannya sendiri.
 */
async function siloWajib(conn) {
  const [baris] = await conn.query(
    `SELECT id, kode, silo_name, kapasitas_maks_ltr, toleransi_ltr
       FROM silo
      WHERE is_active = TRUE AND is_buffer = FALSE
      ORDER BY urutan`,
  );
  return baris;
}

/** Isi periode: seluruh silo wajib, beserta nilai yang sudah tersimpan. */
export async function daftar(periode) {
  pastikanPeriode(periode);

  const silo = await siloWajib(pool);
  const [tersimpan] = await pool.query(
    `SELECT so.silo_id, so.jumlah_awal_ltr, so.is_finalized, so.updated_at,
            o.nama_lengkap AS operator_nama
       FROM stock_opname so
       JOIN operator o ON o.id = so.operator_id
      WHERE so.periode = ?`,
    [periode],
  );
  const peta = new Map(tersimpan.map((t) => [t.silo_id, t]));

  const baris = silo.map((s) => {
    const ada = peta.get(s.id);
    return {
      siloId: s.id,
      kode: s.kode,
      siloName: s.silo_name,
      kapasitasMaksLtr: Number(s.kapasitas_maks_ltr),
      batasKerasLtr: Number(s.kapasitas_maks_ltr) + Number(s.toleransi_ltr),
      jumlahAwalLtr: ada ? Number(ada.jumlah_awal_ltr) : null,
      terisi: Boolean(ada),
      diperbaruiOleh: ada?.operator_nama ?? null,
      diperbaruiPada: ada?.updated_at ?? null,
    };
  });

  const finalized = tersimpan.length > 0 && tersimpan.every((t) => t.is_finalized);

  return {
    periode,
    baris,
    finalized,
    jumlahTerisi: baris.filter((b) => b.terisi).length,
    jumlahSilo: baris.length,
    // Dijumlahkan hanya dari yang sudah terisi; angka ini untuk dibaca, bukan
    // untuk dipakai sampai periodenya lengkap.
    totalLtr: baris.reduce((s, b) => s + (b.jumlahAwalLtr ?? 0), 0),
  };
}

/** Menolak perubahan pada periode yang sudah difinalisasi - BR-20. */
async function pastikanBelumFinal(conn, periode) {
  const [baris] = await conn.query(
    'SELECT COUNT(*) AS n FROM stock_opname WHERE periode = ? AND is_finalized = TRUE',
    [periode],
  );
  if (Number(baris[0].n) > 0) {
    throw new BusinessError(
      'BR-20',
      `Periode ${periode} sudah difinalisasi dan tidak dapat diubah lagi.`,
    );
  }
}

/**
 * Menyimpan satu baris - FR-8.4, FR-24.1.
 *
 * Satu baris, bukan seluruh periode. Layar lama menulis seluruh silo lalu
 * memuat ulang halamannya (WF-12); di sini setiap baris berdiri sendiri,
 * sehingga kesalahan pada satu silo tidak membatalkan pekerjaan pada silo
 * lainnya.
 *
 * Nilai 0 SAH dan berbeda dari kosong: silo yang benar-benar kosong saat
 * dihitung adalah hasil yang valid, sedangkan kosong berarti belum dihitung.
 * Perbedaan itu yang menentukan boleh tidaknya periode difinalisasi.
 */
export async function simpanBaris({ periode, siloId, jumlahAwalLtr }, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.STOCK_OPNAME_KELOLA);
  pastikanPeriode(periode);

  const nilai = Number(jumlahAwalLtr);
  if (!Number.isFinite(nilai) || nilai < 0) {
    throw new BusinessError(
      'FR-8.5',
      'Volume awal harus angka nol atau lebih. Kosongkan bila silo belum dihitung.',
    );
  }

  return withTransaction(async (conn) => {
    await pastikanBelumFinal(conn, periode);

    const [siloBaris] = await conn.query(
      `SELECT id, kode, silo_name, kapasitas_maks_ltr, toleransi_ltr
         FROM silo WHERE id = ? AND is_active = TRUE AND is_buffer = FALSE`,
      [siloId],
    );
    const silo = siloBaris[0];
    if (!silo) throw new NotFoundError('Silo penyimpanan');

    // Volume yang secara fisik tidak mungkin ditolak, bukan sekadar
    // diperingatkan: hasil hitung di atas batas keras silo pasti salah ketik,
    // dan angka itu kelak menjadi dasar saldo berjalan.
    const batasKeras = Number(silo.kapasitas_maks_ltr) + Number(silo.toleransi_ltr);
    if (nilai > batasKeras) {
      throw new BusinessError(
        'BR-24',
        `${silo.silo_name} tidak dapat memuat ${nilai} L. Batas kerasnya ${batasKeras} L.`,
        { batasKerasLtr: batasKeras },
      );
    }

    const [lamaBaris] = await conn.query(
      'SELECT id, jumlah_awal_ltr FROM stock_opname WHERE periode = ? AND silo_id = ? FOR UPDATE',
      [periode, siloId],
    );
    const lama = lamaBaris[0] ?? null;

    /**
     * Upsert diserahkan ke BASIS DATA lewat UNIQUE (periode, silo_id).
     *
     * Inilah perbaikan struktural B-2: keunikan dijamin oleh kekangan, bukan
     * oleh formula pencarian yang harus ditulis benar di setiap tempat.
     */
    await conn.query(
      `INSERT INTO stock_opname (periode, silo_id, jumlah_awal_ltr, operator_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         jumlah_awal_ltr = VALUES(jumlah_awal_ltr),
         operator_id = VALUES(operator_id)`,
      [periode, siloId, nilai, aktor.id],
    );

    const [baruBaris] = await conn.query(
      'SELECT id FROM stock_opname WHERE periode = ? AND silo_id = ?',
      [periode, siloId],
    );

    await catatAudit(conn, {
      entity: 'stock_opname',
      entityId: baruBaris[0].id,
      action: lama ? 'UPDATE' : 'CREATE',
      actorId: aktor.id,
      before: lama ? { jumlahAwalLtr: Number(lama.jumlah_awal_ltr) } : null,
      after: { periode, siloId, siloName: silo.silo_name, jumlahAwalLtr: nilai },
      reason: `Stock opname ${periode} untuk ${silo.silo_name}`,
      ip,
    });

    return {
      periode,
      siloId,
      siloName: silo.silo_name,
      jumlahAwalLtr: nilai,
      cara: lama ? 'diperbarui' : 'dibuat',
    };
  });
}

/**
 * Memfinalisasi periode - FR-8.5, FR-24.2, BR-20.
 *
 * Di sinilah validasi kelengkapan MEMBLOKIR, dan inilah perbaikan B-3.
 * Layar lama menampilkan peringatan lalu tetap menyimpan; di sini periode
 * yang belum lengkap tidak dapat dikunci sama sekali, dan silo mana yang
 * belum dihitung disebutkan namanya supaya Admin tidak perlu mencarinya.
 */
export async function finalisasi(periode, aktor, ip) {
  pastikanBerwenang(aktor, AKSI.STOCK_OPNAME_KELOLA);
  pastikanPeriode(periode);

  return withTransaction(async (conn) => {
    await pastikanBelumFinal(conn, periode);

    const silo = await siloWajib(conn);
    const [tersimpan] = await conn.query(
      'SELECT id, silo_id, jumlah_awal_ltr FROM stock_opname WHERE periode = ? FOR UPDATE',
      [periode],
    );
    const sudah = new Set(tersimpan.map((t) => t.silo_id));

    const belum = silo.filter((s) => !sudah.has(s.id));
    if (belum.length > 0) {
      throw new BusinessError(
        'FR-8.5',
        `Periode ${periode} belum lengkap. Belum dihitung: ` +
          `${belum.map((s) => s.silo_name).join(', ')}.`,
        { siloBelumDihitung: belum.map((s) => ({ siloId: s.id, siloName: s.silo_name })) },
      );
    }

    await conn.query(
      'UPDATE stock_opname SET is_finalized = TRUE WHERE periode = ?',
      [periode],
    );

    const total = tersimpan.reduce((s, t) => s + Number(t.jumlah_awal_ltr), 0);

    /**
     * Dicatat SATU JEJAK PER BARIS, bukan satu jejak untuk periodenya.
     *
     * Finalisasi memang keputusan atas periode, dan mencatatnya sekali terasa
     * lebih ringkas. Tetapi `audit_log.entity_id` sengaja NOT NULL: tiap jejak
     * harus menunjuk record tertentu, supaya pertanyaan "apa saja yang pernah
     * terjadi pada record ini" dapat dijawab dari satu tempat (21 CFR Part 11
     * sec.11.10(e)). Jejak yang menggantung tanpa record akan luput dari
     * pertanyaan itu.
     *
     * Jadi tiap baris mencatat penguncian dirinya sendiri, dengan konteks
     * periodenya disertakan supaya keputusan kolektifnya tetap terbaca.
     */
    for (const t of tersimpan) {
      await catatAudit(conn, {
        entity: 'stock_opname',
        entityId: t.id,
        action: 'FINALIZE_SO',
        actorId: aktor.id,
        before: { isFinalized: false },
        after: {
          isFinalized: true,
          periode,
          siloId: t.silo_id,
          jumlahAwalLtr: Number(t.jumlah_awal_ltr),
          jumlahSiloPeriode: tersimpan.length,
          totalPeriodeLtr: total,
        },
        reason: `Finalisasi stock opname periode ${periode}`,
        ip,
      });
    }

    return { periode, jumlahSilo: tersimpan.length, totalLtr: total, finalized: true };
  });
}

/** Periode yang pernah diisi, untuk pemilih periode. */
export async function daftarPeriode() {
  const [baris] = await pool.query(
    `SELECT periode,
            COUNT(*) AS jumlah_silo,
            SUM(jumlah_awal_ltr) AS total_ltr,
            MIN(is_finalized) AS finalized
       FROM stock_opname
      GROUP BY periode
      ORDER BY periode DESC
      LIMIT 24`,
  );
  return baris.map((b) => ({
    periode: b.periode,
    jumlahSilo: Number(b.jumlah_silo),
    totalLtr: Number(b.total_ltr),
    finalized: Boolean(Number(b.finalized)),
  }));
}
