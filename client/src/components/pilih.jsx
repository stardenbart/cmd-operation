import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Pilihan yang dapat dicari - satu nilai dan banyak nilai.
 *
 * MENGAPA BUKAN `<select>` BIASA.
 *
 * Supplier ada 32 dan namanya mirip-mirip. Pada `<select>`, mencari satu nama
 * berarti menggulir daftar dengan ibu jari di layar sentuh sambil memegang
 * sesuatu yang lain - dan salah pilih tidak menimbulkan galat apa pun, ia
 * hanya mencatat susu dari supplier yang salah.
 *
 * MENGAPA BUKAN `<datalist>`.
 *
 * `<datalist>` hanya mengembalikan TEKS yang diketik, bukan id pilihannya.
 * Menautkannya kembali ke id menuntut pencocokan nama, dan nama yang sedikit
 * berbeda - spasi ganda, huruf besar - menghasilkan "supplier tidak ditemukan"
 * padahal daftarnya benar. Perilakunya juga berbeda-beda antar peramban.
 *
 * Jadi ditulis sendiri: input teks untuk menyaring, daftar tombol untuk
 * memilih, dan yang tersimpan selalu ID - bukan teks yang diketik.
 */

/** Pencocokan longgar: tanpa peduli huruf besar dan spasi berlebih. */
function cocok(teks, kueri) {
  const t = String(teks ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const k = String(kueri ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return k === '' || t.includes(k);
}

/** Menutup daftar saat diklik di luar - tanpa ini daftar menempel di layar. */
function useKlikLuar(ref, saatKeluar, refTambahan) {
  useEffect(() => {
    function tangani(e) {
      const diWadah = ref.current?.contains(e.target);
      const diTambahan = refTambahan?.current?.contains(e.target);
      if (!diWadah && !diTambahan) saatKeluar();
    }
    document.addEventListener('mousedown', tangani);
    return () => document.removeEventListener('mousedown', tangani);
  }, [ref, refTambahan, saatKeluar]);
}

const GAYA_DAFTAR = {
  position: 'absolute',
  zIndex: 20,
  top: '100%',
  left: 0,
  right: 0,
  maxHeight: 240,
  overflowY: 'auto',
  background: 'var(--surface, #fff)',
  border: '1px solid var(--gridline, #d0d0d0)',
  borderRadius: 6,
  marginTop: 2,
  boxShadow: '0 6px 18px rgba(0,0,0,.12)',
};

const GAYA_ITEM = (aktif) => ({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '8px 10px',
  border: 0,
  background: aktif ? 'var(--gridline, #eee)' : 'transparent',
  cursor: 'pointer',
});

/**
 * Pilihan satu nilai yang dapat dicari.
 *
 * @param {Array<{id: any, label: string}>} opsi
 * @param {any} nilai id yang terpilih, atau '' bila belum ada
 */
export function PilihCari({
  opsi = [], nilai, onChange, placeholder = 'Cari…', required = false, id,
}) {
  const [buka, setBuka] = useState(false);
  const [kueri, setKueri] = useState('');
  const [sorot, setSorot] = useState(0);
  const wadah = useRef(null);

  useKlikLuar(wadah, () => setBuka(false));

  const terpilih = opsi.find((o) => String(o.id) === String(nilai));
  const tersaring = useMemo(
    () => opsi.filter((o) => cocok(o.label, kueri)),
    [opsi, kueri],
  );

  function pilih(o) {
    onChange(o.id);
    setKueri('');
    setBuka(false);
  }

  function tombol(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setBuka(true);
      setSorot((i) => Math.min(i + 1, tersaring.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSorot((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && buka) {
      e.preventDefault();
      if (tersaring[sorot]) pilih(tersaring[sorot]);
    } else if (e.key === 'Escape') {
      setBuka(false);
    }
  }

  return (
    <div ref={wadah} style={{ position: 'relative' }}>
      <input
        id={id}
        /* Nilai yang tampak: nama yang terpilih saat daftar tertutup, kueri
           saat sedang mencari. Tanpa pembedaan ini, pilihan yang sudah dibuat
           hilang dari layar begitu daftarnya dibuka. */
        value={buka ? kueri : (terpilih?.label ?? '')}
        onChange={(e) => { setKueri(e.target.value); setBuka(true); setSorot(0); }}
        onFocus={() => { setBuka(true); setKueri(''); setSorot(0); }}
        onKeyDown={tombol}
        placeholder={terpilih ? terpilih.label : placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={buka}
      />
      {/* Nilai sebenarnya dititipkan di input tersembunyi supaya `required`
          tetap ditegakkan peramban - input pencarian di atas boleh kosong
          walaupun pilihannya sudah ada. */}
      <input type="hidden" value={nilai ?? ''} required={required} />

      {buka && (
        <div style={GAYA_DAFTAR}>
          {tersaring.length === 0 ? (
            <div style={{ padding: '8px 10px', color: 'var(--text-secondary, #666)' }}>
              Tidak ada yang cocok
            </div>
          ) : (
            tersaring.map((o, i) => (
              <button
                key={o.id}
                type="button"
                style={GAYA_ITEM(i === sorot)}
                onMouseEnter={() => setSorot(i)}
                onClick={() => pilih(o)}
              >
                {o.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pilihan BANYAK nilai yang dapat dicari.
 *
 * Kosong berarti "seluruhnya", bukan "tidak ada". Itu perilaku yang diharapkan
 * dari sebuah filter: halaman yang baru dibuka menampilkan semuanya. Kalau
 * kosong berarti tidak ada, tabel akan tampak kosong dan terbaca sebagai
 * "tidak ada data" - bukan sebagai "belum memilih".
 */
export function PilihBanyakCari({
  opsi = [], nilai = [], onChange, placeholder = 'Semua', labelSemua = 'Semua',
  ariaLabel = 'Pilihan',
}) {
  const [buka, setBuka] = useState(false);
  const [kueri, setKueri] = useState('');
  const [posisi, setPosisi] = useState(null);
  const wadah = useRef(null);
  const pemicu = useRef(null);
  const daftar = useRef(null);

  useKlikLuar(wadah, () => setBuka(false), daftar);

  const perbaruiPosisi = useCallback(() => {
    const rect = pemicu.current?.getBoundingClientRect();
    if (!rect) return;

    const jarak = 7;
    const batasLayar = 12;
    const lebar = Math.min(Math.max(rect.width, 280), window.innerWidth - (batasLayar * 2));
    const kiri = Math.min(
      Math.max(rect.left, batasLayar),
      window.innerWidth - lebar - batasLayar,
    );
    const ruangBawah = window.innerHeight - rect.bottom - jarak - batasLayar;
    const ruangAtas = rect.top - jarak - batasLayar;
    const bukaKeAtas = ruangBawah < 230 && ruangAtas > ruangBawah;
    const ruangTersedia = bukaKeAtas ? ruangAtas : ruangBawah;

    setPosisi({
      left: kiri,
      width: lebar,
      top: bukaKeAtas ? 'auto' : rect.bottom + jarak,
      bottom: bukaKeAtas ? window.innerHeight - rect.top + jarak : 'auto',
      maxHeight: Math.max(160, Math.min(330, ruangTersedia)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!buka) {
      setPosisi(null);
      return undefined;
    }

    perbaruiPosisi();
    window.addEventListener('resize', perbaruiPosisi);
    window.addEventListener('scroll', perbaruiPosisi, true);
    return () => {
      window.removeEventListener('resize', perbaruiPosisi);
      window.removeEventListener('scroll', perbaruiPosisi, true);
    };
  }, [buka, perbaruiPosisi]);

  const terpilih = opsi.filter((o) => nilai.some((v) => String(v) === String(o.id)));
  const tersaring = useMemo(
    () => opsi.filter((o) => cocok(o.label, kueri)),
    [opsi, kueri],
  );

  function alihkan(o) {
    const ada = nilai.some((v) => String(v) === String(o.id));
    onChange(ada
      ? nilai.filter((v) => String(v) !== String(o.id))
      : [...nilai, o.id]);
  }

  const ringkasan = terpilih.length === 0
    ? labelSemua
    : terpilih.length <= 2
      ? terpilih.map((o) => o.label).join(', ')
      : `${terpilih.length} dipilih`;

  return (
    <div ref={wadah} style={{ position: 'relative' }}>
      <button
        ref={pemicu}
        type="button"
        className="btn btn--kedua"
        style={{ width: '100%', textAlign: 'left', fontWeight: 400 }}
        onClick={() => { setBuka((v) => !v); setKueri(''); }}
        aria-haspopup="listbox"
        aria-expanded={buka}
      >
        {ringkasan}
      </button>

      {buka && posisi && createPortal(
        <div
          ref={daftar}
          className="pilih-banyak__daftar"
          style={posisi}
          role="listbox"
          aria-label={ariaLabel}
          aria-multiselectable="true"
        >
          <div className="pilih-banyak__pencarian">
            <input
              value={kueri}
              onChange={(e) => setKueri(e.target.value)}
              placeholder={placeholder}
              autoComplete="off"
              autoFocus
            />
          </div>

          <div className="pilih-banyak__opsi">
            {nilai.length > 0 && (
              <button
                type="button"
                className="pilih-banyak__bersihkan"
                onClick={() => onChange([])}
              >
                Bersihkan Pilihan
              </button>
            )}

            {tersaring.length === 0 ? (
              <div className="pilih-banyak__kosong">Tidak Ada Yang Cocok</div>
            ) : (
              tersaring.map((o) => {
                const dipilih = nilai.some((v) => String(v) === String(o.id));
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`pilih-banyak__item${dipilih ? ' dipilih' : ''}`}
                    onClick={() => alihkan(o)}
                    role="option"
                    aria-selected={dipilih}
                  >
                    <span className="pilih-banyak__cek" aria-hidden="true" />
                    <span>{o.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      , document.body)}
    </div>
  );
}
