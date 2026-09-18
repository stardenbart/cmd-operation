import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { PesanGalat } from './ui.jsx';

/**
 * Tanda tangan digital operator - kolom Paraf Halaman 1 form GMP.
 *
 * Digambar sendiri lewat <canvas> + Pointer Events, tanpa pustaka tanda
 * tangan pihak ketiga - konsisten dengan grafik.jsx di aplikasi ini yang
 * juga digambar sendiri, dan sesuatu sesederhana "gambar garis mengikuti
 * jari/mouse" tidak butuh dependensi tambahan.
 *
 * Kanvas TETAP 300x120 (rasio 2,5:1) - formExcel.js mengasumsikan rasio ini
 * saat menskalakan gambar ke sel Paraf. Mengubah ukuran di sini berarti
 * menyesuaikan UKURAN_TANDA_TANGAN_PX di server juga.
 */
const LEBAR_KANVAS = 300;
const TINGGI_KANVAS = 120;

export default function DialogTandaTangan({ onTutup }) {
  const kanvasRef = useRef(null);
  const menggambarRef = useRef(false);
  const posisiRef = useRef(null);
  const [sudahMenggambar, setSudahMenggambar] = useState(false);
  const [memuat, setMemuat] = useState(true);
  const [mengirim, setMengirim] = useState(false);
  const [galat, setGalat] = useState(null);
  const [sukses, setSukses] = useState(null);

  const ctx = () => kanvasRef.current?.getContext('2d');

  function bersihkanKanvas() {
    const c = ctx();
    if (!c) return;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, LEBAR_KANVAS, TINGGI_KANVAS);
  }

  // Muat tanda tangan yang sudah ada (kalau ada) supaya operator tahu apa
  // yang sekarang tersimpan, bukan mulai dari kanvas kosong setiap kali.
  useEffect(() => {
    let batal = false;
    (async () => {
      bersihkanKanvas();
      try {
        const res = await api.get('/auth/signature');
        if (batal) return;
        if (res.gambar) {
          const img = new Image();
          img.onload = () => ctx()?.drawImage(img, 0, 0, LEBAR_KANVAS, TINGGI_KANVAS);
          img.src = res.gambar;
        }
      } catch (err) {
        if (!batal) setGalat(err);
      } finally {
        if (!batal) setMemuat(false);
      }
    })();
    return () => { batal = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function posisiDari(e) {
    const rect = kanvasRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (LEBAR_KANVAS / rect.width),
      y: (e.clientY - rect.top) * (TINGGI_KANVAS / rect.height),
    };
  }

  function mulai(e) {
    e.preventDefault();
    menggambarRef.current = true;
    posisiRef.current = posisiDari(e);
    kanvasRef.current.setPointerCapture(e.pointerId);
  }

  function gambar(e) {
    if (!menggambarRef.current) return;
    e.preventDefault();
    const baru = posisiDari(e);
    const c = ctx();
    c.strokeStyle = '#1a1a2e';
    c.lineWidth = 2.2;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(posisiRef.current.x, posisiRef.current.y);
    c.lineTo(baru.x, baru.y);
    c.stroke();
    posisiRef.current = baru;
    setSudahMenggambar(true);
  }

  function selesai() {
    menggambarRef.current = false;
  }

  function hapusGambar() {
    bersihkanKanvas();
    setSudahMenggambar(false);
  }

  async function simpan() {
    setGalat(null);
    setSukses(null);
    setMengirim(true);
    try {
      const gambar = kanvasRef.current.toDataURL('image/png');
      await api.post('/auth/signature', { gambar });
      setSukses('Tanda tangan tersimpan.');
      setSudahMenggambar(false);
    } catch (err) {
      setGalat(err);
    } finally {
      setMengirim(false);
    }
  }

  return (
    <section className="kartu tumpuk" aria-label="Tanda tangan saya">
      <div className="kartu__kepala"><h2>Tanda tangan saya</h2></div>

      <PesanGalat galat={galat} onTutup={() => setGalat(null)} />
      {sukses && <div className="pesan pesan--sukses">{sukses}</div>}

      <p className="bantuan" style={{ marginTop: -8 }}>
        Digambar sekali di sini, dipakai otomatis di kolom Paraf setiap
        Receiving yang Anda kerjakan. Wajib diisi sebelum bisa menyimpan
        Receiving baru.
      </p>

      <div
        style={{
          border: '1px solid var(--border, #ccc)', borderRadius: 8,
          width: '100%', maxWidth: LEBAR_KANVAS, opacity: memuat ? 0.4 : 1,
        }}
      >
        <canvas
          ref={kanvasRef}
          width={LEBAR_KANVAS}
          height={TINGGI_KANVAS}
          style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none', cursor: 'crosshair' }}
          onPointerDown={mulai}
          onPointerMove={gambar}
          onPointerUp={selesai}
          onPointerLeave={selesai}
        />
      </div>

      <div className="baris">
        <button type="button" className="btn btn--kedua btn--kecil" onClick={hapusGambar} disabled={mengirim}>
          Hapus &amp; gambar ulang
        </button>
        <div className="dorong" />
        <button type="button" className="btn btn--kedua" onClick={onTutup} disabled={mengirim}>
          Tutup
        </button>
        <button
          type="button"
          className="btn btn--utama"
          onClick={simpan}
          disabled={mengirim || !sudahMenggambar}
        >
          {mengirim ? 'Menyimpan…' : 'Simpan tanda tangan'}
        </button>
      </div>
    </section>
  );
}
