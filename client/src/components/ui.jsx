/** Komponen dasar yang dipakai bersama seluruh halaman. */

export const fmt = (n, desimal = 0) =>
  n === null || n === undefined || n === ''
    ? '-'
    : Number(n).toLocaleString('id-ID', {
        minimumFractionDigits: desimal,
        maximumFractionDigits: desimal,
      });

/** BR-09 — "2h 3j 15m" / "3j 15m" / "15 menit" / "—" */
export function formatStandingTime(menit) {
  if (menit === null || menit === undefined || menit < 0) return '-';
  const t = Math.floor(menit);
  if (t >= 1440) return `${Math.floor(t / 1440)}h ${Math.floor((t % 1440) / 60)}j ${t % 60}m`;
  if (t >= 60) return `${Math.floor(t / 60)}j ${t % 60}m`;
  return `${t} menit`;
}

export const waktuSingkat = (iso) =>
  iso ? new Date(iso).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-';

export function Field({ label, wajib, bantuan, children }) {
  return (
    <label className="field">
      <span className="label">
        {label}
        {wajib && <span className="field__wajib">*</span>}
      </span>
      {children}
      {bantuan && <span className="bantuan">{bantuan}</span>}
    </label>
  );
}

export function Lencana({ nada = 'netral', children }) {
  return <span className={`lencana lencana--${nada}`}>{children}</span>;
}

/**
 * Menampilkan galat API beserta kode aturannya.
 *
 * Kode ditampilkan apa adanya (BR-06, FR-29.7, ...) supaya operator dapat
 * menyebutnya saat melapor, dan supaya jelas aturan mana yang tersentuh.
 */
export function PesanGalat({ galat, onTutup }) {
  if (!galat) return null;
  const detail = galat.detail;
  return (
    <div className="pesan pesan--galat">
      <div style={{ flex: 1 }}>
        <div>{galat.message}</div>
        {Array.isArray(detail) && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {detail.map((d, i) => <li key={i}>{d.field}: {d.pesan}</li>)}
          </ul>
        )}
        {galat.kode && <div className="pesan__kode">{galat.kode}</div>}
      </div>
      {onTutup && (
        <button type="button" className="btn btn--hantu btn--kecil" onClick={onTutup}>Tutup</button>
      )}
    </div>
  );
}

export function PesanSukses({ children }) {
  return children ? <div className="pesan pesan--sukses">{children}</div> : null;
}

/** Tautan unduh cadangan diberi gaya agar terbaca sebagai tindakan. */

export function Kosong({ children }) {
  return <div className="kosong">{children}</div>;
}
