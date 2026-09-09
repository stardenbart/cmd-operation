import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmt, Field, Lencana, PesanGalat, PesanSukses, Kosong } from '../components/ui.jsx';

/** Bulan berjalan sebagai YYYY-MM setempat. */
function bulanIni() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const NAMA_BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const labelPeriode = (p) => {
  const [tahun, bulan] = p.split('-');
  return `${NAMA_BULAN[Number(bulan) - 1]} ${tahun}`;
};

/**
 * Satu baris silo.
 *
 * Disimpan saat field kehilangan fokus, bukan saat tombol Save ditekan
 * (WF-12). Layar lama menulis seluruh silo lalu memuat ulang halamannya, jadi
 * kesalahan pada satu silo membatalkan pekerjaan pada silo lainnya.
 */
function BarisSilo({ baris, periode, terkunci, bolehSunting, onSukses, onGalat }) {
  const [nilai, setNilai] = useState(
    baris.jumlahAwalLtr === null ? '' : String(baris.jumlahAwalLtr),
  );
  const [status, setStatus] = useState(null);

  // Nilai dari server menang saat periode berganti
  useEffect(() => {
    setNilai(baris.jumlahAwalLtr === null ? '' : String(baris.jumlahAwalLtr));
    setStatus(null);
  }, [periode, baris.siloId, baris.jumlahAwalLtr]);

  const simpan = useMutation({
    mutationFn: (v) =>
      api.post('/stock-opname/baris', {
        periode,
        siloId: baris.siloId,
        jumlahAwalLtr: v,
      }),
    onSuccess: (res) => {
      setStatus('tersimpan');
      onSukses(res.data);
    },
    onError: (err) => {
      setStatus('gagal');
      onGalat(err);
    },
  });

  const asli = baris.jumlahAwalLtr === null ? '' : String(baris.jumlahAwalLtr);

  const lepasFokus = () => {
    const bersih = nilai.trim();
    // Kosong berarti BELUM DIHITUNG, dan itu bukan nol. Mengosongkan field
    // karena itu tidak menyimpan apa pun, bukan menyimpan nol.
    if (bersih === '' || bersih === asli) return;
    simpan.mutate(bersih);
  };

  return (
    <tr className={baris.terisi ? '' : 'baris--belum'}>
      <td>{baris.siloName}</td>
      <td className="num">{fmt(baris.kapasitasMaksLtr)} L</td>
      <td>
        <input
          className="angka-input"
          inputMode="decimal"
          value={nilai}
          disabled={terkunci || !bolehSunting}
          placeholder={terkunci || !bolehSunting ? '' : 'belum dihitung'}
          onChange={(e) => { setNilai(e.target.value); setStatus(null); }}
          onBlur={lepasFokus}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </td>
      <td>
        {simpan.isPending && <span className="bantuan">menyimpan…</span>}
        {!simpan.isPending && status === 'tersimpan' && (
          <Lencana nada="baik">Tersimpan</Lencana>
        )}
        {!simpan.isPending && status === 'gagal' && (
          <Lencana nada="kritis">Gagal</Lencana>
        )}
        {!simpan.isPending && !status && baris.terisi && (
          <span className="bantuan">
            {baris.diperbaruiOleh}
          </span>
        )}
        {!simpan.isPending && !status && !baris.terisi && (
          <span className="bantuan">belum dihitung</span>
        )}
      </td>
    </tr>
  );
}

export default function StockOpname() {
  const qc = useQueryClient();
  const { boleh } = useAuth();
  const [periode, setPeriode] = useState(bulanIni());
  const [sukses, setSukses] = useState(null);
  const [galat, setGalat] = useState(null);

  const bolehSunting = boleh('stock_opname:kelola');

  const isi = useQuery({
    queryKey: ['stock-opname', periode],
    queryFn: () => api.get(`/stock-opname?periode=${periode}`),
  });

  const riwayat = useQuery({
    queryKey: ['stock-opname-periode'],
    queryFn: () => api.get('/stock-opname/periode'),
  });

  const kunci = useMutation({
    mutationFn: () => api.post('/stock-opname/finalisasi', { periode }),
    onSuccess: (res) => {
      setGalat(null);
      setSukses(
        `Periode ${labelPeriode(periode)} difinalisasi: ${res.data.jumlahSilo} silo, ` +
          `total ${fmt(res.data.totalLtr)} L. Nilainya kini tidak dapat diubah lagi.`,
      );
      qc.invalidateQueries({ queryKey: ['stock-opname'] });
      qc.invalidateQueries({ queryKey: ['stock-opname-periode'] });
    },
    onError: (err) => { setSukses(null); setGalat(err); },
  });

  const data = isi.data?.data;
  const lengkap = data && data.jumlahTerisi === data.jumlahSilo;

  return (
    <div className="tumpuk">
      <div className="kartu__kepala">
        <h1>Stock Opname</h1>
        {data?.finalized && <Lencana nada="netral">Periode terkunci</Lencana>}
      </div>

      <p className="bantuan">
        Volume awal bulan per silo, hasil hitung fisik. Nilainya disimpan begitu
        Anda pindah dari kolomnya, jadi pengisian dapat dilakukan bertahap.
        Finalisasi adalah tindakan terpisah: ia menuntut seluruh silo sudah
        dihitung, lalu mengunci periodenya.
      </p>

      <PesanSukses>{sukses}</PesanSukses>
      <PesanGalat galat={galat ?? isi.error} onTutup={() => setGalat(null)} />

      <div className="kartu">
        <div className="form-grid">
          <Field label="Periode" wajib bantuan="Bulan hitung fisik">
            <input
              type="month" value={periode}
              onChange={(e) => { setPeriode(e.target.value); setSukses(null); setGalat(null); }}
            />
          </Field>
        </div>
      </div>

      {isi.isLoading ? (
        <Kosong>Memuat periode…</Kosong>
      ) : !data ? null : (
        <div className="kartu">
          <div className="kartu__kepala">
            <h2 style={{ fontSize: 16 }}>{labelPeriode(periode)}</h2>
            <span className="label">
              {data.jumlahTerisi} dari {data.jumlahSilo} silo dihitung
            </span>
            {lengkap && !data.finalized && <Lencana nada="baik">Lengkap</Lencana>}
          </div>

          {data.finalized && (
            <div className="pesan pesan--info">
              Periode ini sudah difinalisasi, jadi nilainya tidak dapat diubah
              lagi (BR-20). Bila hasil hitungnya perlu dikoreksi, itu keputusan
              mutu yang harus ditempuh di luar sistem ini.
            </div>
          )}

          <table className="tabel">
            <thead>
              <tr>
                <th>Silo</th>
                <th className="num">Kapasitas nominal</th>
                <th>Volume awal (L)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.baris.map((b) => (
                <BarisSilo
                  key={b.siloId}
                  baris={b}
                  periode={periode}
                  terkunci={data.finalized}
                  bolehSunting={bolehSunting}
                  onSukses={(d) => {
                    setGalat(null);
                    setSukses(`${d.siloName} ${d.cara}: ${fmt(d.jumlahAwalLtr)} L.`);
                    qc.invalidateQueries({ queryKey: ['stock-opname'] });
                  }}
                  onGalat={(err) => { setSukses(null); setGalat(err); }}
                />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                <th />
                <th className="num">{fmt(data.totalLtr)} L</th>
                <th />
              </tr>
            </tfoot>
          </table>

          {bolehSunting && !data.finalized && (
            <div className="baris kartu__aksi">
              <span className="bantuan">
                {lengkap
                  ? 'Seluruh silo sudah dihitung. Periode siap difinalisasi.'
                  : `Masih ada ${data.jumlahSilo - data.jumlahTerisi} silo yang belum dihitung.`}
              </span>
              <button
                type="button"
                className="btn btn--utama dorong"
                disabled={!lengkap || kunci.isPending}
                onClick={() => kunci.mutate()}
              >
                {kunci.isPending ? 'Memfinalisasi…' : 'Finalisasi Periode'}
              </button>
            </div>
          )}
        </div>
      )}

      {riwayat.data?.data.length > 0 && (
        <div className="kartu">
          <div className="kartu__kepala"><h2 style={{ fontSize: 16 }}>Periode tercatat</h2></div>
          <table className="tabel">
            <thead>
              <tr>
                <th>Periode</th>
                <th className="num">Silo</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {riwayat.data.data.map((p) => (
                <tr key={p.periode}>
                  <td>{labelPeriode(p.periode)}</td>
                  <td className="num">{p.jumlahSilo}</td>
                  <td className="num">{fmt(p.totalLtr)} L</td>
                  <td>
                    {p.finalized
                      ? <Lencana nada="netral">Terkunci</Lencana>
                      : <Lencana nada="waspada">Masih terbuka</Lencana>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      type="button" className="btn btn--hantu btn--kecil"
                      onClick={() => { setPeriode(p.periode); setSukses(null); setGalat(null); }}
                    >
                      Buka
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
