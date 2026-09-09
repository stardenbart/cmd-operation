import { useEffect, useState } from 'react';

/**
 * Tombol "Pasang aplikasi" untuk PWA.
 *
 * Chrome/Edge/Android menembakkan `beforeinstallprompt` ketika aplikasi
 * memenuhi syarat pasang (manifest + service worker + konteks aman). Kita
 * tahan event-nya lalu tampilkan tombol sendiri, jadi pemasangan tidak
 * bergantung pada banner bawaan peramban yang kerap terlewat.
 *
 * Tombol tidak muncul bila aplikasi sudah terpasang, atau di peramban yang
 * tidak mendukung event ini (mis. iOS Safari - di sana pemakainya memakai
 * Bagikan > Tambah ke Layar Utama).
 */
export default function PasangPWA() {
  const [prompt, setPrompt] = useState(null);
  const [terpasang, setTerpasang] = useState(false);

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setPrompt(e); };
    const onInstalled = () => { setTerpasang(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (terpasang || !prompt) return null;

  return (
    <button
      type="button"
      className="btn btn--kecil btn--kedua"
      onClick={async () => {
        prompt.prompt();
        try { await prompt.userChoice; } catch { /* abaikan */ }
        setPrompt(null);
      }}
    >
      Pasang aplikasi
    </button>
  );
}
