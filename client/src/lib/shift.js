/**
 * Shift kerja pabrik — WIB, tiga jendela 8 jam. Cermin dari
 * `server/src/auth/shift.js`; server tetap satu-satunya yang MENEGAKKAN
 * (wajibLogin & refresh() menolak sesi lintas-shift apa pun kata klien) —
 * ini hanya dipakai untuk memberi peringatan & keluar otomatis di layar
 * SEBELUM permintaan berikutnya ditolak server, supaya operator tidak
 * kehilangan pekerjaan yang sedang diketik tanpa peringatan.
 */
const ZONA = 'Asia/Jakarta';
const FORMAT_JAM = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Jam, menit, detik dinding WIB dari sebuah waktu. */
function bagianWib(waktu) {
  const bagian = Object.fromEntries(
    FORMAT_JAM.formatToParts(waktu).map(({ type, value }) => [type, value]),
  );
  return { jam: Number(bagian.hour), menit: Number(bagian.minute), detik: Number(bagian.second) };
}

/** Shift yang berlaku pada suatu waktu — 1, 2, atau 3. */
export function shiftPada(waktu = new Date()) {
  const { jam } = bagianWib(waktu);
  if (jam >= 7 && jam < 15) return 1;
  if (jam >= 15 && jam < 23) return 2;
  return 3;
}

/**
 * Milidetik dari sekarang sampai batas shift BERIKUTNYA (07.00, 15.00, atau
 * 23.00 WIB terdekat di depan).
 */
export function msSampaiPergantianShift(waktu = new Date()) {
  const { jam, menit, detik } = bagianWib(waktu);
  const detikSekarang = jam * 3600 + menit * 60 + detik;
  const batasJam = [7, 15, 23].map((j) => j * 3600);
  const berikutnya = batasJam.find((b) => b > detikSekarang) ?? (batasJam[0] + 24 * 3600);
  return (berikutnya - detikSekarang) * 1000;
}
