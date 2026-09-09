import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Kosong } from '../components/ui.jsx';
import {
  RingkasanStok, SiloPenyimpanan, PapanBatchAktif,
} from '../components/dashboardVisual.jsx';
import TombolLayarPenuh from '../components/TombolLayarPenuh.jsx';

/**
 * Dashboard PUBLIK - tanpa login.
 *
 * Header, logo, dan gaya teks disamakan dengan aplikasi utama (kelas `.topbar`)
 * supaya konsisten. Isi dipisah menjadi DUA tampilan yang ditukar lewat tombol,
 * bukan digulir: (1) ringkasan + visual silo, (2) tabel detail batch aktif.
 * Kartu & silo sengaja statis - penerima tautan tidak punya sesi untuk membuka
 * halaman detail.
 */
async function ambilPublik(token) {
  const res = await fetch(`/api/v1/public/dashboard?t=${encodeURIComponent(token)}`);
  if (!res.ok) {
    const badan = await res.json().catch(() => ({}));
    throw new Error(badan?.error?.message || badan?.message || 'Tautan tidak berlaku.');
  }
  return (await res.json()).data;
}

const waktuId = (iso) => (iso
  ? new Date(iso).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
  : '');

export default function PublicDashboard() {
  const [sp] = useSearchParams();
  const token = sp.get('t') || '';
  const fsRef = useRef(null);
  const [tampilan, setTampilan] = useState('visual'); // 'visual' | 'tabel'

  const { data, isLoading, error } = useQuery({
    queryKey: ['publik-dashboard', token],
    queryFn: () => ambilPublik(token),
    enabled: Boolean(token),
    refetchInterval: 30_000,
  });

  const konten = () => {
    if (!token || error) {
      return (
        <div className="kartu">
          <Kosong>Tautan tidak berlaku atau telah dicabut. Minta tautan baru ke admin.</Kosong>
        </div>
      );
    }
    if (isLoading || !data) return <Kosong>Memuat dashboard…</Kosong>;

    const buffer = data.silos.find((s) => s.is_buffer);
    const penyimpanan = data.silos.filter((s) => !s.is_buffer);

    return (
      <div className="tumpuk">
        <div className="halaman-kepala halaman-kepala--aksi">
          <div>
            <span className="halaman-kepala__eyebrow">Ringkasan Plant</span>
            <h1>Dashboard Operasional</h1>
            <p>Stok, kondisi, dan batch aktif seluruh silo dalam satu tampilan.</p>
          </div>
          <div className="halaman-kepala__aksi">
            <div className="segmen" role="tablist" aria-label="Tampilan">
              <button
                type="button" role="tab" aria-selected={tampilan === 'visual'}
                className={`btn btn--kecil ${tampilan === 'visual' ? 'btn--utama' : 'btn--kedua'}`}
                onClick={() => setTampilan('visual')}
              >
                Ringkasan &amp; Silo
              </button>
              <button
                type="button" role="tab" aria-selected={tampilan === 'tabel'}
                className={`btn btn--kecil ${tampilan === 'tabel' ? 'btn--utama' : 'btn--kedua'}`}
                onClick={() => setTampilan('tabel')}
              >
                Detail batch
              </button>
            </div>
            <TombolLayarPenuh targetRef={fsRef} />
          </div>
        </div>

        {tampilan === 'visual' ? (
          <>
            <RingkasanStok ringkasan={data.ringkasan} buffer={buffer} />
            <SiloPenyimpanan penyimpanan={penyimpanan} />
          </>
        ) : (
          <div className="tumpuk">
            <div className="kartu__kepala">
              <h2>Batch aktif per silo</h2>
              <span className="label">Susu yang masih tersimpan, urut FIFO</span>
            </div>
            <PapanBatchAktif baris={data.batchAktif} live />
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={fsRef} className="publik">
      <header className="topbar">
        <div className="topbar__identitas">
          <img className="topbar__logo" src="/Logo_Cimory.png" alt="Cimory" />
          <div className="topbar__judul">
            <div className="topbar__merek">CMD 1 Operation</div>
            <div className="topbar__sub">Fresh Milk Receiving · Plant Sentul 1</div>
          </div>
        </div>
        <div className="topbar__kanan">
          {data?.diperbaruiPada && (
            <span className="publik__waktu">Diperbarui {waktuId(data.diperbaruiPada)} WIB</span>
          )}
        </div>
      </header>
      <main className="isi">{konten()}</main>
    </div>
  );
}
