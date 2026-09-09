/** Mengubah nilai datetime-local (yang dimaknai sebagai WIB) menjadi ISO UTC. */
export function inputWibKeIso(nilai) {
  if (!nilai) return '';
  const teks = String(nilai).trim();
  const lokal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(teks);
  const lengkap = lokal && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(teks)
    ? `${teks}:00`
    : teks;
  const tanggal = new Date(lokal ? `${lengkap}+07:00` : lengkap);
  return Number.isNaN(tanggal.getTime()) ? '' : tanggal.toISOString();
}

export function tambahHariInputWib(nilai, jumlah) {
  const iso = inputWibKeIso(nilai);
  if (!iso) return undefined;
  const tanggal = new Date(iso);
  tanggal.setUTCDate(tanggal.getUTCDate() + jumlah);
  return new Date(tanggal.getTime() + 7 * 60 * 60_000).toISOString().slice(0, 16);
}

const FORMAT_INPUT_WIB = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** ISO UTC dari API menjadi jam dinding WIB untuk input datetime-local. */
export function isoKeInputWib(nilai) {
  if (!nilai) return '';
  const tanggal = new Date(nilai);
  if (Number.isNaN(tanggal.getTime())) return '';
  const bagian = Object.fromEntries(
    FORMAT_INPUT_WIB.formatToParts(tanggal).map(({ type, value }) => [type, value]),
  );
  return `${bagian.year}-${bagian.month}-${bagian.day}T${bagian.hour}:${bagian.minute}`;
}

const FORMAT_WIB = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Menampilkan waktu API sebagai tanggal yang mudah dibaca dalam zona WIB. */
export function formatWaktuWib(nilai) {
  if (!nilai) return '-';
  const tanggal = new Date(nilai);
  if (Number.isNaN(tanggal.getTime())) return '-';

  const bagian = Object.fromEntries(
    FORMAT_WIB.formatToParts(tanggal).map(({ type, value }) => [type, value]),
  );
  return `${bagian.day} ${bagian.month} ${bagian.year}, ${bagian.hour}.${bagian.minute} WIB`;
}

/** Menampilkan kedua batas periode tanpa mengekspos format ISO/UTC dari API. */
export function formatRentangWib(dari, sampai) {
  return `${formatWaktuWib(dari)} sampai ${formatWaktuWib(sampai)}`;
}
