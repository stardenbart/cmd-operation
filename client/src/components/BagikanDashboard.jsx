import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Lencana, PesanGalat } from './ui.jsx';

/**
 * Panel kelola tautan publik dashboard - hanya Admin (master:kelola).
 *
 * Dikendalikan induk (Dashboard): tombolnya ada di kepala halaman, panel ini
 * dirender sebagai blok tersendiri di aliran halaman supaya tidak berdempetan
 * dengan judul di atasnya. Tautan read-only, tanpa login; token dapat DIPUTAR
 * (yang lama mati) atau DICABUT bila bocor.
 */
export default function BagikanDashboard({ onTutup }) {
  const qc = useQueryClient();
  const [tersalin, setTersalin] = useState(false);

  const { data } = useQuery({
    queryKey: ['dashboard-share'],
    queryFn: () => api.get('/dashboard-share'),
  });
  const token = data?.token ?? null;
  const tautan = token ? `${window.location.origin}/publik/dashboard?t=${token}` : null;

  const segar = () => qc.invalidateQueries({ queryKey: ['dashboard-share'] });
  const putar = useMutation({ mutationFn: () => api.post('/dashboard-share/putar'), onSuccess: segar });
  const cabut = useMutation({ mutationFn: () => api.post('/dashboard-share/cabut'), onSuccess: segar });

  const salin = async () => {
    if (!tautan) return;
    try {
      await navigator.clipboard.writeText(tautan);
      setTersalin(true);
      setTimeout(() => setTersalin(false), 1500);
    } catch { /* peramban tanpa izin clipboard: pemakai salin manual */ }
  };

  return (
    <div className="kartu tumpuk">
      <div className="kartu__kepala">
        <h2 style={{ fontSize: 16 }}>Bagikan dashboard</h2>
        <Lencana nada={token ? 'baik' : 'netral'}>{token ? 'Aktif' : 'Nonaktif'}</Lencana>
        <button type="button" className="btn btn--hantu btn--kecil dorong" onClick={onTutup}>
          Tutup
        </button>
      </div>

      <p className="bantuan" style={{ marginTop: -8 }}>
        Tautan read-only tanpa login: hanya kartu stok, visual silo, dan papan
        batch aktif. Token rahasia dan dapat dicabut kapan saja. Pemasangan PWA
        dan data langsung tetap mengikuti tautan HTTPS.
      </p>

      <PesanGalat galat={putar.error ?? cabut.error} onTutup={() => { putar.reset(); cabut.reset(); }} />

      {tautan ? (
        <>
          <div className="baris" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <input readOnly value={tautan} onFocus={(e) => e.target.select()} style={{ flex: 1 }} />
            <button type="button" className="btn btn--utama btn--kecil" onClick={salin}>
              {tersalin ? 'Tersalin' : 'Salin'}
            </button>
          </div>
          <div className="baris">
            <button
              type="button" className="btn btn--kedua btn--kecil"
              disabled={putar.isPending} onClick={() => putar.mutate()}
            >
              {putar.isPending ? 'Memutar…' : 'Putar token (matikan tautan lama)'}
            </button>
            <button
              type="button" className="btn btn--bahaya btn--kecil dorong"
              disabled={cabut.isPending} onClick={() => cabut.mutate()}
            >
              {cabut.isPending ? 'Mencabut…' : 'Cabut tautan'}
            </button>
          </div>
        </>
      ) : (
        <div className="baris">
          <span className="bantuan">Belum ada tautan aktif.</span>
          <button
            type="button" className="btn btn--utama btn--kecil dorong"
            disabled={putar.isPending} onClick={() => putar.mutate()}
          >
            {putar.isPending ? 'Membuat…' : 'Buat tautan'}
          </button>
        </div>
      )}
    </div>
  );
}
