import { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { Field, PesanGalat } from './ui.jsx';

/**
 * Ganti password sendiri - FR-1.
 *
 * Terpisah dari layar Login, yang hanya menangani keadaan WAJIB ganti setelah
 * Admin mereset. Yang di sini adalah penggantian atas kemauan sendiri, dan itu
 * harus dapat dilakukan kapan pun tanpa menunggu dipaksa: password yang
 * dicurigai bocor tidak menunggu jadwal.
 *
 * Server mencabut seluruh sesi begitu password berganti, jadi layar ini
 * mengantar pemakainya ke halaman masuk, bukan mengembalikannya ke aplikasi
 * dengan token yang sudah mati.
 */
export default function DialogGantiPassword({ onTutup }) {
  const { gantiPassword } = useAuth();
  const [lama, setLama] = useState('');
  const [baru, setBaru] = useState('');
  const [ulangi, setUlangi] = useState('');
  const [galat, setGalat] = useState(null);
  const [mengirim, setMengirim] = useState(false);

  async function kirim(e) {
    e.preventDefault();
    setGalat(null);

    if (baru !== ulangi) {
      setGalat(new Error('Password baru dan ulangannya tidak sama'));
      return;
    }
    if (baru === lama) {
      setGalat(new Error('Password baru harus berbeda dari password lama'));
      return;
    }

    setMengirim(true);
    try {
      await gantiPassword(lama, baru);
      // Sesi sudah dicabut server; keadaan lokal ikut dibersihkan oleh
      // gantiPassword(), sehingga aplikasi kembali ke layar masuk sendiri.
    } catch (err) {
      setGalat(err);
      setMengirim(false);
    }
  }

  return (
    /* Kartu biasa, bukan overlay: proyek ini tidak punya CSS lapisan, dan
       dialog lain (DialogKoreksi) pun dirender sebagai kartu di alur halaman.
       Memakai kelas yang tidak ada di stylesheet menghasilkan kotak tanpa
       gaya yang menutupi isi halaman. */
    <section className="kartu tumpuk" aria-label="Ganti password">
      <form className="tumpuk" onSubmit={kirim}>
        <div className="kartu__kepala"><h2>Ganti password</h2></div>

        <PesanGalat galat={galat} onTutup={() => setGalat(null)} />

        <div className="pesan pesan--info">
          Setelah diganti, seluruh sesi Anda di perangkat lain ikut berakhir dan
          Anda perlu masuk kembali.
        </div>

        <Field label="Password sekarang" wajib>
          <input
            type="password" autoComplete="current-password"
            value={lama} onChange={(e) => setLama(e.target.value)} required autoFocus
          />
        </Field>

        <Field label="Password baru" wajib bantuan="Minimal 8 karakter">
          <input
            type="password" autoComplete="new-password" minLength={8}
            value={baru} onChange={(e) => setBaru(e.target.value)} required
          />
        </Field>

        <Field label="Ulangi password baru" wajib>
          <input
            type="password" autoComplete="new-password"
            value={ulangi} onChange={(e) => setUlangi(e.target.value)} required
          />
        </Field>

        <div className="baris">
          <button type="button" className="btn btn--kedua" onClick={onTutup} disabled={mengirim}>
            Batal
          </button>
          <button className="btn btn--utama dorong" disabled={mengirim || !lama || !baru || !ulangi}>
            {mengirim ? 'Menyimpan…' : 'Ganti password'}
          </button>
        </div>
      </form>
    </section>
  );
}
