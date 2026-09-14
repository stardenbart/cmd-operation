/**
 * Shift kerja pabrik — WIB, tiga jendela 8 jam.
 *
 *   Shift 1   07:00–14:59
 *   Shift 2   15:00–22:59
 *   Shift 3   23:00–06:59 (melewati tengah malam)
 *
 * Dipakai untuk mengakhiri SESI (bukan token) otomatis begitu shift
 * berganti — beda dari kedaluwarsa biasa: sesi yang lahir di shift 1 harus
 * berakhir tepat pukul 15.00 meski umurnya belum habis, supaya operator
 * shift berikutnya tidak bisa diam-diam meneruskan memakai identitas
 * operator shift sebelumnya yang lupa logout (jejak audit mencatat orang
 * yang salah).
 *
 * Jam dinding dihitung lewat Intl.DateTimeFormat, BUKAN Date#getHours() —
 * supaya benar lepas dari TZ proses server, tidak diam-diam salah kalau
 * suatu saat proses berjalan tanpa TZ=Asia/Jakarta.
 */
const ZONA = 'Asia/Jakarta';
const FORMAT_JAM = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA,
  hour: '2-digit',
  hourCycle: 'h23',
});

/** Jam dinding WIB (0–23) dari sebuah waktu. */
export function jamWib(waktu = new Date()) {
  return Number(FORMAT_JAM.format(waktu));
}

/** Shift yang berlaku pada suatu waktu — 1, 2, atau 3. */
export function shiftPada(waktu = new Date()) {
  const jam = jamWib(waktu);
  if (jam >= 7 && jam < 15) return 1;
  if (jam >= 15 && jam < 23) return 2;
  return 3;
}
