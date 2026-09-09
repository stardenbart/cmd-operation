import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmt, Lencana, PesanGalat, PesanSukses, Kosong } from '../components/ui.jsx';

const MODUL = [
  { key: '', label: 'Semua' },
  { key: 'receiving', label: 'Penerimaan' },
  { key: 'prepast', label: 'Prepast' },
  { key: 'pengembalian', label: 'Pengembalian' },
  { key: 'transfer', label: 'Transfer' },
  { key: 'monitoring', label: 'Monitoring' },
];

const kunci = (b) => `${b.modul}:${b.id}`;

function usiaTeks(menit) {
  if (menit < 60) return `${menit} menit`;
  if (menit < 1440) return `${Math.floor(menit / 60)} jam`;
  return `${Math.floor(menit / 1440)} hari`;
}

/** Pohon turunan yang menghalangi penolakan, berjenjang (FR-17.1). */
function PohonDependensi({ pohon, tingkat = 0 }) {
  return pohon.map((s) => (
    <div key={`${s.modul}${s.id}`}>
      <div
        className="baris"
        style={{ paddingLeft: tingkat * 20, gap: 8, padding: '5px 0', flexWrap: 'nowrap' }}
      >
        <span className="label" style={{ minWidth: 88 }}>{s.modul}</span>
        <span className="angka">{s.kode}</span>
        <span className="angka" style={{ color: 'var(--text-secondary)' }}>
          {fmt(s.volumeLtr)} L
        </span>
        {s.anak.length === 0 && <Lencana nada="waspada">Tangani ini dulu</Lencana>}
      </div>
      <PohonDependensi pohon={s.anak} tingkat={tingkat + 1} />
    </div>
  ));
}

export default function Approval() {
  const qc = useQueryClient();
  const { boleh } = useAuth();
  const [modul, setModul] = useState('');
  const [pilih, setPilih] = useState(new Set());
  const [tolakTarget, setTolakTarget] = useState(null);
  const [alasan, setAlasan] = useState('');
  const [sukses, setSukses] = useState(null);

  const bolehPutuskan = boleh('approval:putuskan');

  const { data, isLoading } = useQuery({
    queryKey: ['approval', 'queue', modul],
    queryFn: () => api.get(`/approval/queue${modul ? `?modul=${modul}` : ''}`),
    refetchInterval: 30_000,
  });

  const segarkan = () => {
    qc.invalidateQueries({ queryKey: ['approval'] });
    qc.invalidateQueries({ queryKey: ['silos'] });
  };

  const massal = useMutation({
    mutationFn: (daftar) => api.post('/approval/bulk-approve', { daftar }),
    onSuccess: (res) => {
      setSukses(`${res.data.jumlah} record disetujui.`);
      setPilih(new Set());
      segarkan();
    },
  });

  const tolak = useMutation({
    mutationFn: ({ modul: m, id, alasan: a }) =>
      api.post(`/approval/${m}/${id}/reject`, { alasan: a }),
    onSuccess: (res) => {
      setSukses(`${res.data.kode} ditolak.`);
      setTolakTarget(null);
      setAlasan('');
      segarkan();
    },
  });

  if (isLoading) return <Kosong>Memuat antrean…</Kosong>;

  const baris = data.data;
  const semuaTerpilih = baris.length > 0 && baris.every((b) => pilih.has(kunci(b)));

  const togglePilih = (b) => {
    const s = new Set(pilih);
    const k = kunci(b);
    if (s.has(k)) s.delete(k); else s.add(k);
    setPilih(s);
  };

  const terpilih = baris.filter((b) => pilih.has(kunci(b)));

  return (
    <div className="tumpuk">
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Antrean persetujuan</h2>
          {data.total > 0 && (
            <span className="label">
              {data.total} menunggu · tertua {usiaTeks(data.usiaTertuaMenit)}
            </span>
          )}
        </div>

        <PesanSukses>{sukses}</PesanSukses>
        <PesanGalat galat={massal.error} onTutup={() => massal.reset()} />

        <div className="baris">
          {MODUL.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`btn btn--kecil ${modul === m.key ? 'btn--utama' : 'btn--kedua'}`}
              onClick={() => { setModul(m.key); setPilih(new Set()); }}
            >
              {m.label}
              {m.key && data.perModul[m.key] ? ` (${data.perModul[m.key]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {baris.length === 0 ? (
        <div className="kartu">
          <Kosong>Tidak ada yang menunggu persetujuan.</Kosong>
        </div>
      ) : (
        <div className="kartu tumpuk">
          {bolehPutuskan && (
            <div className="baris">
              <label className="baris" style={{ gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  style={{ width: 20, height: 20, minHeight: 20 }}
                  checked={semuaTerpilih}
                  onChange={() =>
                    setPilih(semuaTerpilih ? new Set() : new Set(baris.map(kunci)))
                  }
                />
                <span className="label">Pilih semua di halaman ini</span>
              </label>

              <button
                type="button"
                className="btn btn--utama dorong"
                disabled={terpilih.length === 0 || massal.isPending}
                onClick={() =>
                  massal.mutate(terpilih.map((b) => ({ modul: b.modul, id: b.id })))
                }
              >
                {massal.isPending ? 'Menyetujui…' : `Setujui ${terpilih.length} terpilih`}
              </button>
            </div>
          )}

          <table className="tabel">
            <thead>
              <tr>
                {bolehPutuskan && <th style={{ width: 36 }}></th>}
                <th>Modul</th>
                <th>Kode</th>
                <th>Ringkasan</th>
                <th>Operator</th>
                <th>Menunggu</th>
                {bolehPutuskan && <th></th>}
              </tr>
            </thead>
            <tbody>
              {baris.map((b) => (
                <tr key={kunci(b)}>
                  {bolehPutuskan && (
                    <td>
                      <input
                        type="checkbox"
                        style={{ width: 20, height: 20, minHeight: 20 }}
                        checked={pilih.has(kunci(b))}
                        onChange={() => togglePilih(b)}
                        aria-label={`Pilih ${b.kode}`}
                      />
                    </td>
                  )}
                  <td><span className="label">{b.modul}</span></td>
                  <td className="angka">{b.kode}</td>
                  <td>{b.ringkasan}</td>
                  <td>{b.operator_nama}</td>
                  <td>
                    {b.usia_menit > 240
                      ? <Lencana nada="waspada">{usiaTeks(b.usia_menit)}</Lencana>
                      : usiaTeks(b.usia_menit)}
                  </td>
                  {bolehPutuskan && (
                    <td style={{ textAlign: 'right' }}>
                      {/* Reject selalu satu per satu: penolakan menuntut
                          alasan yang khusus untuk record itu (FR-16.4). */}
                      <button
                        type="button"
                        className="btn btn--bahaya btn--kecil"
                        onClick={() => { setTolakTarget(b); setAlasan(''); tolak.reset(); }}
                      >
                        Tolak
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tolakTarget && (
        <div className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2>Tolak {tolakTarget.kode}</h2>
            <button
              type="button"
              className="btn btn--hantu btn--kecil dorong"
              onClick={() => setTolakTarget(null)}
            >
              Batal
            </button>
          </div>

          <p className="bantuan" style={{ marginTop: -8 }}>{tolakTarget.ringkasan}</p>

          {tolak.error?.kode === 'BR-15' ? (
            <>
              <div className="pesan pesan--galat">{tolak.error.message}</div>
              <h3>Turunan yang harus ditangani lebih dulu</h3>
              <div style={{ borderLeft: '2px solid var(--gridline)', paddingLeft: 12 }}>
                <PohonDependensi pohon={tolak.error.detail?.pohon ?? []} />
              </div>
            </>
          ) : (
            <PesanGalat galat={tolak.error} onTutup={() => tolak.reset()} />
          )}

          <label className="field">
            <span className="label">Alasan penolakan *</span>
            <textarea
              value={alasan}
              onChange={(e) => setAlasan(e.target.value)}
              placeholder="Berat jenis salah baca, perlu ditimbang ulang"
              autoFocus
            />
          </label>

          <div className="baris">
            <button
              type="button"
              className="btn btn--bahaya dorong"
              disabled={alasan.trim().length < 3 || tolak.isPending}
              onClick={() =>
                tolak.mutate({ modul: tolakTarget.modul, id: tolakTarget.id, alasan })
              }
            >
              {tolak.isPending ? 'Menolak…' : 'Tolak record ini'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
