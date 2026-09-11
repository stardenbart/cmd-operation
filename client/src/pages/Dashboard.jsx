import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { inputWibKeIso, tambahHariInputWib } from '../lib/waktu.js';
import { fmt, Field, Lencana, PesanGalat, Kosong } from '../components/ui.jsx';
import {
  RingkasanStok, SiloPenyimpanan, PapanBatchAktif, useDenyut,
} from '../components/dashboardVisual.jsx';
import BagikanDashboard from '../components/BagikanDashboard.jsx';

const isoTanggal = (d = new Date()) => [
  d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'),
].join('-');
const isoWaktuInput = (d = new Date()) => {
  const lokal = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return lokal.toISOString().slice(0, 16);
};

/**
 * Penagihan input yang masih gantung - BR-23.
 *
 * Input separuh diizinkan karena penerimaan, prepast, dan transfer kerap
 * berjalan paralel. Konsekuensinya DITAGIH di halaman pertama tiap shift, bukan
 * didiamkan sampai form GMP-nya tidak dapat dicetak berbulan-bulan kemudian.
 * Ditampilkan JUGA saat kosong - sebagai kabar baik, bukan disembunyikan.
 */
function PengingatGantung() {
  const ke = useNavigate();
  useDenyut(60_000);

  const { data, error } = useQuery({
    queryKey: ['data', 'gantung'],
    queryFn: () => api.get('/data/gantung'),
    refetchInterval: 60_000,
  });

  if (error) return <PesanGalat galat={error} />;

  const daftar = data?.data ?? [];

  if (daftar.length === 0) {
    return (
      <div className="kartu">
        <Kosong>Tidak ada input yang menggantung. Seluruh catatan sudah lengkap.</Kosong>
      </div>
    );
  }

  const NAMA = { receiving: 'Penerimaan', prepast: 'Prepast', transfer: 'Transfer' };

  return (
    <div className="kartu tumpuk">
      <div className="pesan pesan--waspada">
        {daftar.length} input masih separuh dan belum dapat disetujui (BR-23).
        Yang tertua sudah {daftar[0].usiaJam} jam. Klik salah satunya untuk melengkapi.
      </div>

      <table className="tabel">
        <thead>
          <tr>
            <th>Jenis</th>
            <th>Kode</th>
            <th>Silo</th>
            <th className="num">Volume (L)</th>
            <th>Diinput oleh</th>
            <th className="num">Menggantung</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {daftar.map((d) => (
            <tr key={`${d.modul}-${d.id}`}>
              <td>{NAMA[d.modul] ?? d.modul}</td>
              <td className="angka">{d.kode}</td>
              <td>
                {d.tempat}
                {d.fieldKosong?.length > 0 && (
                  <div className="bantuan">
                    Kurang: {d.fieldKosong.map((f) => f.label).join(', ')}
                  </div>
                )}
              </td>
              <td className="num">{d.volumeLtr === null ? '—' : fmt(d.volumeLtr)}</td>
              <td>{d.operatorNama}</td>
              <td className="num">{d.usiaJam} jam</td>
              <td style={{ textAlign: 'right' }}>
                <button
                  type="button"
                  className="btn btn--utama btn--kecil"
                  onClick={() => ke(`/data?modul=${d.modul}&cari=${encodeURIComponent(d.kode)}`)}
                  disabled={!d.bolehSayaLengkapi}
                  title={d.bolehSayaLengkapi
                    ? 'Buka untuk dilengkapi'
                    : 'Hanya yang menginputnya atau SPV yang dapat melengkapi'}
                >
                  Lengkapi
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Papan batch aktif dengan data real-time / snapshot sesuai filter. */
function PapanBatchAktifLive({ kueri = '', live = true, versi = 0 }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['silos', 'batch-aktif', kueri, versi],
    queryFn: () => api.get(`/silos/batch-aktif${kueri ? `?${kueri}` : ''}`),
    refetchInterval: live ? 30_000 : false,
  });

  if (error) return <PesanGalat galat={error} />;
  if (isLoading) return <Kosong>Memuat batch aktif…</Kosong>;
  return <PapanBatchAktif baris={data?.data ?? []} live={live} />;
}

export default function Dashboard() {
  const ke = useNavigate();
  const { boleh } = useAuth();
  const [bagikan, setBagikan] = useState(false);
  // Filter rentang waktu disembunyikan secara default: pembuka halaman langsung
  // melihat silo penyimpanan tanpa harus melewati panel filter dulu.
  const [filterTampil, setFilterTampil] = useState(false);
  const [dariInput, setDariInput] = useState(`${isoTanggal()}T00:00`);
  const [sampaiInput, setSampaiInput] = useState(isoWaktuInput());
  const [filter, setFilter] = useState(null);
  const [versiFilter, setVersiFilter] = useState(0);
  const filterAktif = Boolean(filter);

  const parameter = new URLSearchParams();
  if (filterAktif) {
    parameter.set('dari', inputWibKeIso(filter.dari));
    parameter.set('sampai', inputWibKeIso(filter.sampai));
  }
  const kueri = parameter.toString();
  // Rentang yang sudah diterapkan adalah snapshot tetap. Hanya mode tanpa
  // filter yang mengikuti data real-time setiap 30 detik.
  const live = !filterAktif;
  const { data, isLoading, error } = useQuery({
    queryKey: ['silos', kueri, versiFilter],
    queryFn: () => api.get(`/silos${kueri ? `?${kueri}` : ''}`),
    refetchInterval: live ? 30_000 : false,
  });

  if (isLoading) return <Kosong>Memuat data silo…</Kosong>;
  if (error) return <PesanGalat galat={error} />;

  const { data: silos, ringkasan } = data;
  const buffer = silos.find((s) => s.is_buffer);
  const penyimpanan = silos.filter((s) => !s.is_buffer);

  return (
    <div className="tumpuk">
      <div className="halaman-kepala halaman-kepala--aksi">
        <div>
          <span className="halaman-kepala__eyebrow">Ringkasan Plant</span>
          <h1>Dashboard Operasional</h1>
          <p>Pantau kapasitas, kondisi, dan status pengecekan seluruh silo dalam satu tampilan.</p>
        </div>
        <div className="halaman-kepala__aksi">
          <button
            type="button"
            className={`btn btn--kecil ${(filterTampil || filterAktif) ? 'btn--utama' : 'btn--kedua'}`}
            aria-expanded={filterTampil || filterAktif}
            onClick={() => setFilterTampil((v) => !v)}
          >
            {(filterTampil || filterAktif) ? 'Sembunyikan filter' : 'Filter rentang waktu'}
          </button>
          {boleh('master:kelola') && (
            <button
              type="button"
              className="btn btn--kedua btn--kecil"
              onClick={() => setBagikan((v) => !v)}
            >
              {bagikan ? 'Tutup bagikan' : 'Bagikan dashboard'}
            </button>
          )}
        </div>
      </div>

      {boleh('master:kelola') && bagikan && (
        <BagikanDashboard onTutup={() => setBagikan(false)} />
      )}

      {(filterTampil || filterAktif) && (
      <div className="kartu tumpuk dashboard-filter">
        <div className="kartu__kepala">
          <div>
            <h2>Rentang Waktu</h2>
            <div className="bantuan">
              Zona Waktu WIB · Maksimum 90 hari · Mode Real-Time diperbarui otomatis.
            </div>
          </div>
          <Lencana nada={filterAktif ? 'netral' : 'baik'}>
            {filterAktif ? 'Historis' : 'Real-Time'}
          </Lencana>
        </div>
        <div className="form-grid">
          <Field label="Dari Waktu">
            <input type="datetime-local" value={dariInput} onChange={(e) => setDariInput(e.target.value)} />
          </Field>
          <Field label="Sampai Waktu">
            <input
              type="datetime-local" value={sampaiInput} min={dariInput}
              max={tambahHariInputWib(dariInput, 90)}
              onChange={(e) => setSampaiInput(e.target.value)}
            />
          </Field>
        </div>
        <div className="baris">
          <span className="bantuan">
            {filterAktif
              ? `Filter aktif: ${filter.dari.replace('T', ' ')} sampai ${filter.sampai.replace('T', ' ')} WIB. Standing time tetap dihitung sejak awal siklus isi silo.`
              : 'Pilih rentang, lalu tekan Terapkan Filter untuk menampilkan snapshot historis.'}
          </span>
          {filterAktif && (
            <button type="button" className="btn btn--kedua btn--kecil" onClick={() => setFilter(null)}>
              Kembali Ke Real-Time
            </button>
          )}
          <button
            type="button"
            className="btn btn--utama btn--kecil dorong"
            disabled={!dariInput || !sampaiInput || sampaiInput < dariInput}
            onClick={() => {
              setFilter({ dari: dariInput, sampai: sampaiInput });
              setVersiFilter((lama) => lama + 1);
            }}
          >
            Terapkan Filter
          </button>
        </div>
      </div>
      )}

      <RingkasanStok
        ringkasan={ringkasan}
        buffer={buffer}
        onBuffer={(b) => ke(`/silo/${b.silo_id}`)}
        onKgBelumTerkonversi={() => ke('/data?modul=receiving&bjKosong=true')}
      />

      <SiloPenyimpanan penyimpanan={penyimpanan} onPilih={(s) => ke(`/silo/${s.silo_id}`)} />

      {!filterAktif && (
        <div className="tumpuk">
          <div className="kartu__kepala">
            <h2>Perlu dilengkapi</h2>
            <span className="label">Input separuh yang belum dapat disetujui</span>
          </div>
          <PengingatGantung />
        </div>
      )}

      <div className="tumpuk">
        <div className="kartu__kepala">
          <h2>Batch aktif per silo</h2>
          <span className="label">Susu yang masih tersimpan, urut FIFO</span>
        </div>
        <PapanBatchAktifLive kueri={kueri} live={live} versi={versiFilter} />
      </div>
    </div>
  );
}
