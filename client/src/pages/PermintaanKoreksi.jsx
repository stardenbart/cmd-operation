import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  fmt, waktuSingkat, Field, Lencana, PesanGalat, PesanSukses, Kosong,
} from '../components/ui.jsx';

const TAB = [
  { key: 'PENDING', label: 'Menunggu' },
  { key: 'APPROVED', label: 'Disetujui' },
  { key: 'REJECTED', label: 'Ditolak' },
];

const NADA = { PENDING: 'waspada', APPROVED: 'baik', REJECTED: 'kritis' };

const MODUL_LABEL = {
  receiving: 'Penerimaan',
  prepast: 'Prepast',
  pengembalian: 'Pengembalian',
  transfer: 'Transfer',
  monitoring: 'Monitoring',
};

/** Nilai apa pun dari server, dirapikan untuk dibaca manusia. */
function tampil(v) {
  if (v === null || v === undefined || v === '') return 'kosong';
  // Tanggal ISO dari kolom DATETIME
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return waktuSingkat(v);
  if (typeof v === 'number') return fmt(v);
  return String(v);
}

/**
 * Umur permintaan. Ditonjolkan karena inilah yang dulu tidak terlihat:
 * pada alur Power Apps, permintaan yang tergantung membuat record hilang
 * dari export tanpa ada yang menghitung sudah berapa lama.
 */
function Umur({ menit }) {
  if (menit == null) return null;
  const jam = Math.floor(menit / 60);
  const teks = jam >= 24
    ? `${Math.floor(jam / 24)} hari`
    : jam >= 1 ? `${jam} jam` : `${menit} menit`;
  return <Lencana nada={jam >= 24 ? 'kritis' : jam >= 4 ? 'waspada' : 'netral'}>{teks}</Lencana>;
}

/** Perbandingan berdampingan: nilai sekarang di kiri, usulan di kanan. */
function Perbandingan({ baris }) {
  const berubah = baris.filter((b) => b.berubah);
  if (berubah.length === 0) {
    return <p className="bantuan">Tidak ada nilai yang berbeda dari record sekarang.</p>;
  }
  return (
    <table className="tabel">
      <thead>
        <tr>
          <th>Field</th>
          <th className="num">Sekarang</th>
          <th />
          <th className="num">Diusulkan</th>
        </tr>
      </thead>
      <tbody>
        {berubah.map((b) => (
          <tr key={b.field}>
            <td>{b.label}</td>
            <td className="num" style={{ color: 'var(--text-secondary)' }}>{tampil(b.lama)}</td>
            <td style={{ width: 24, textAlign: 'center' }}>&rarr;</td>
            <td className="num"><b>{tampil(b.baru)}</b></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PermintaanKoreksi() {
  const qc = useQueryClient();
  const { boleh } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const [terpilih, setTerpilih] = useState(null);
  const [catatan, setCatatan] = useState('');
  const [sukses, setSukses] = useState(null);

  const bolehMemutuskan = boleh('koreksi:tinjau');

  const { data, isLoading } = useQuery({
    queryKey: ['permintaan-koreksi', status],
    queryFn: () => api.get(`/permintaan-koreksi?status=${status}`),
  });

  const selesai = (pesan) => {
    setSukses(pesan);
    setTerpilih(null);
    setCatatan('');
    // Koreksi menyentuh record, sisa silo, dan daftar approval sekaligus
    qc.invalidateQueries({ queryKey: ['permintaan-koreksi'] });
    qc.invalidateQueries({ queryKey: ['data'] });
    qc.invalidateQueries({ queryKey: ['silos'] });
    qc.invalidateQueries({ queryKey: ['approval'] });
  };

  const setujui = useMutation({
    mutationFn: ({ id }) => api.post(`/permintaan-koreksi/${id}/approve`, { catatan }),
    onSuccess: (res) => {
      const d = res.data;
      selesai(
        d.cara === 'reversal'
          ? `${d.kode} dibuat menggantikan ${d.kodeDigantikan}. Record lama ditandai REVISED dan menunggu persetujuan Anda di halaman Approval.`
          : `${d.kode} dikoreksi sesuai permintaan.`,
      );
    },
  });

  const tolak = useMutation({
    mutationFn: ({ id }) => api.post(`/permintaan-koreksi/${id}/reject`, { catatan }),
    onSuccess: () => selesai('Permintaan ditolak. Record asli tidak berubah sama sekali.'),
  });

  const galat = setujui.error ?? tolak.error;
  const sibuk = setujui.isPending || tolak.isPending;

  return (
    <div className="halaman-koreksi">
      <div className="kartu__kepala">
        <h1>Permintaan Koreksi</h1>
      </div>

      <p className="bantuan">
        Operator tidak dapat mengubah record yang sudah disetujui, jadi ia
        mengusulkan nilainya di sini. Selama permintaan menunggu, recordnya
        tetap berstatus Approved dan tetap ikut terekspor. Saat Anda
        menyetujui, koreksinya dijalankan sistem, bukan dikembalikan lagi ke
        operator.
      </p>

      <PesanSukses>{sukses}</PesanSukses>

      <div className="baris koreksi-tabs">
        {TAB.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`btn btn--kecil ${status === t.key ? 'btn--utama' : 'btn--kedua'}`}
            onClick={() => { setStatus(t.key); setTerpilih(null); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <Kosong>Memuat permintaan…</Kosong>
      ) : data.data.length === 0 ? (
        <Kosong>
          {status === 'PENDING'
            ? 'Tidak ada permintaan yang menunggu.'
            : 'Belum ada permintaan pada status ini.'}
        </Kosong>
      ) : (
        <div className="tumpuk">
          {data.data.map((p) => {
            const dipilih = terpilih === p.id;
            return (
              <div key={p.id} className="kartu kartu--berjarak">
                <div className="kartu__kepala">
                  <h2 style={{ fontSize: 16 }}>
                    {MODUL_LABEL[p.modul] ?? p.modul} {p.kode}
                  </h2>
                  <Lencana nada={NADA[p.status]}>{p.status}</Lencana>
                  {p.statusRecord && (
                    <Lencana nada={p.statusRecord === 'Approved' ? 'baik' : 'waspada'}>
                      Record: {p.statusRecord}
                    </Lencana>
                  )}
                  {p.status === 'PENDING' && <Umur menit={p.usiaMenit} />}
                </div>

                <div className="baris" style={{ gap: 20 }}>
                  <span className="label">Pemohon</span>
                  <span>{p.pemohon}</span>
                  <span className="label">Diajukan</span>
                  <span>{waktuSingkat(p.dibuat)}</span>
                </div>

                <p style={{ margin: '4px 0 0' }}>
                  <span className="label">Alasan pemohon</span><br />
                  {p.alasan}
                </p>

                <Perbandingan baris={p.perbandingan} />

                {p.catatanPeninjau && (
                  <p className="bantuan">
                    Catatan {p.peninjau}: {p.catatanPeninjau}
                  </p>
                )}

                {/*
                  Permintaan basi: record berubah setelah permintaan diajukan
                  (di-void, atau sudah digantikan lewat koreksi langsung).
                  Menjalankan koreksinya akan mengubah record yang bukan lagi
                  yang dimaksud pemohon.
                */}
                {p.status === 'PENDING' && !p.dapatDijalankan && (
                  <div className="pesan pesan--waspada">
                    Record ini sudah tidak berstatus Approved
                    {p.statusRecord ? ` (kini ${p.statusRecord})` : ' atau sudah tidak ada'},
                    jadi permintaan ini sudah tidak dapat dijalankan. Tolak
                    permintaannya dengan penjelasan agar pemohon tahu, lalu ia
                    dapat mengajukan ulang atas record penggantinya.
                  </div>
                )}

                {p.status === 'PENDING' && bolehMemutuskan && (
                  dipilih ? (
                    <>
                      <PesanGalat galat={galat} onTutup={() => { setujui.reset(); tolak.reset(); }} />
                      <Field
                        label="Catatan peninjauan"
                        bantuan="Wajib bila menolak. Tercatat di jejak audit."
                      >
                        <textarea
                          value={catatan}
                          onChange={(e) => setCatatan(e.target.value)}
                          placeholder="Sesuai hasil lab, disetujui"
                        />
                      </Field>
                      <div className="baris">
                        <button
                          type="button"
                          className="btn btn--hantu btn--kecil"
                          onClick={() => { setTerpilih(null); setCatatan(''); }}
                        >
                          Tutup
                        </button>
                        <button
                          type="button"
                          className="btn btn--bahaya dorong"
                          disabled={catatan.trim().length < 3 || sibuk}
                          onClick={() => tolak.mutate({ id: p.id })}
                        >
                          {tolak.isPending ? 'Menolak…' : 'Tolak permintaan'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--utama"
                          disabled={sibuk || !p.dapatDijalankan}
                          onClick={() => setujui.mutate({ id: p.id })}
                        >
                          {setujui.isPending ? 'Menjalankan…' : 'Setujui dan jalankan koreksi'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="baris">
                      <button
                        type="button"
                        className="btn btn--kedua btn--kecil dorong"
                        onClick={() => { setTerpilih(p.id); setCatatan(''); setujui.reset(); tolak.reset(); }}
                      >
                        Tinjau
                      </button>
                    </div>
                  )
                )}

                {p.status === 'PENDING' && !bolehMemutuskan && (
                  <p className="bantuan">Menunggu keputusan SPV.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
