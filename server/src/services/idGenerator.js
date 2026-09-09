/**
 * Generator ID transaksi — F0-6, mengatasi M-4
 *
 * Power Apps membangkitkan ID sebagai `"RCV-" & Text(Today(),"yyyymmdd") & "-"
 * & Text(RandBetween(100,999),"000")` — hanya 900 nilai per hari per prefiks,
 * tanpa pemeriksaan tabrakan. Pada 30 transaksi sehari, peluang dua ID sama
 * dalam satu hari sudah di atas 35% menurut paradoks ulang tahun.
 *
 * Di sini ID berasal dari sekuens harian di basis data, dijamin unik oleh
 * kunci UNIQUE pada kolom `kode`.
 */

/** YYYY-MM-DD dalam UTC — sekuens mengikuti hari kalender UTC, seperti data. */
function tanggalUtc(waktu) {
  return waktu.toISOString().slice(0, 10);
}

/**
 * Menerbitkan ID berikutnya untuk suatu prefiks pada suatu hari.
 *
 * HARUS dipanggil di dalam transaksi. `INSERT ... ON DUPLICATE KEY UPDATE`
 * mengambil kunci baris, sehingga dua transaksi bersamaan tidak pernah
 * menerima nomor yang sama — yang kedua menunggu sampai yang pertama commit.
 *
 * @param {import('mysql2/promise').Connection} conn transaksi berjalan
 * @param {'RCV'|'PST'|'TRF'|'MTR'} prefix
 * @param {Date} [waktu] untuk pengujian; bawaan waktu server
 * @returns {Promise<string>} mis. 'RCV-20260825-001'
 */
export async function terbitkanId(conn, prefix, waktu = new Date()) {
  const tgl = tanggalUtc(waktu);

  await conn.query(
    `INSERT INTO id_sequence (prefix, tanggal, last_number)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE last_number = last_number + 1`,
    [prefix, tgl],
  );

  const [baris] = await conn.query(
    'SELECT last_number FROM id_sequence WHERE prefix = ? AND tanggal = ?',
    [prefix, tgl],
  );

  const nomor = baris[0].last_number;
  // padStart(3) mempertahankan bentuk yang sudah dikenal operator (001..999)
  // dan melebar sendiri di atas 999, bukan berputar kembali ke awal.
  return `${prefix}-${tgl.replaceAll('-', '')}-${String(nomor).padStart(3, '0')}`;
}
