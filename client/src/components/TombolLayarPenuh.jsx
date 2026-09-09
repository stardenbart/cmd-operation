import { useEffect, useState } from 'react';

/**
 * Tombol layar penuh - menampilkan hanya tampilan dashboard.
 *
 * Meng-fullscreen-kan elemen `targetRef` (bukan seluruh dokumen), sehingga
 * sidebar dan topbar aplikasi ikut tersembunyi dan yang tersisa hanya papan
 * dashboardnya - berguna untuk layar dinding. Keluar lewat tombol ini lagi
 * atau tombol Esc peramban.
 */
export default function TombolLayarPenuh({ targetRef }) {
  const [penuh, setPenuh] = useState(false);

  useEffect(() => {
    const onChange = () => setPenuh(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        const el = targetRef?.current ?? document.documentElement;
        await el.requestFullscreen();
      }
    } catch { /* peramban menolak atau tak mendukung: abaikan */ }
  };

  // Sembunyikan bila peramban tak mendukung Fullscreen API.
  if (typeof document !== 'undefined' && !document.documentElement.requestFullscreen) {
    return null;
  }

  return (
    <button type="button" className="btn btn--kedua btn--kecil" onClick={toggle}>
      {penuh ? 'Keluar layar penuh' : 'Layar penuh'}
    </button>
  );
}
