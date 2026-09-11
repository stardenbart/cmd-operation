import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Field, Lencana, PesanGalat, Kosong } from './ui.jsx';

export default function DialogLengkapiReceiving({ target, onTutup, onSukses }) {
  const qc = useQueryClient();
  const [nilai, setNilai] = useState({});

  const { data, isLoading } = useQuery({
    queryKey: ['receiving', 'complete-context', target.id],
    queryFn: () => api.get(`/receiving/${target.id}/complete-context`),
  });

  useEffect(() => {
    if (!data?.data) return;
    const d = data.data;
    setNilai({
      beratJenis: d.beratJenis ?? '',
      nilaiTs: d.nilaiTs ?? '',
    });
  }, [data]);

  const simpan = useMutation({
    mutationFn: (body) => api.post(`/receiving/${target.id}/complete`, body),
    onSuccess: (res) => {
      const d = res.data;
      const pesan = d.isGantung
        ? `${d.kode} tersimpan, masih perlu: ${d.fieldKosong.map((f) => f.label).join(', ')}.`
        : `${d.kode} sudah lengkap dan masuk antrean approval.`;
      qc.invalidateQueries({ queryKey: ['data'] });
      qc.invalidateQueries({ queryKey: ['receiving'] });
      qc.invalidateQueries({ queryKey: ['approval'] });
      qc.invalidateQueries({ queryKey: ['silos'] });
      onSukses(pesan);
    },
  });

  const set = (key) => (e) => setNilai((lama) => ({ ...lama, [key]: e.target.value }));

  function kirim() {
    const body = {};
    for (const [key, value] of Object.entries(nilai)) {
      if (value !== '') body[key] = value;
    }
    simpan.mutate(body);
  }

  const kosong = data?.data?.fieldKosong ?? [];
  const beratJenisTerkunci = data?.data?.beratJenis != null;
  const nilaiTsTerkunci = data?.data?.nilaiTs != null;

  // BR-03 — pratinjau konversi, dibulatkan ke bawah persis seperti server
  // (sama seperti halaman Receiving). Hanya bermakna selama Berat Jenis
  // masih dapat diketik di sini; begitu sudah tersimpan, "Volume tercatat"
  // di bawah menampilkan angka SUNGGUHAN dari server, bukan pratinjau lagi.
  const kg = parseFloat(String(data?.data?.qtyKg ?? '').replace(',', '.'));
  const bj = parseFloat(String(nilai.beratJenis ?? '').replace(',', '.'));
  const pratinjauLtr = !beratJenisTerkunci && kg > 0 && bj > 0 ? Math.floor(kg / bj) : null;

  return (
    <div className="kartu tumpuk">
      <div className="kartu__kepala">
        <div>
          <span className="halaman-kepala__eyebrow">Lengkapi Receiving</span>
          <h2 style={{ fontSize: 18 }}>{target.kode}</h2>
        </div>
        <button type="button" className="btn btn--hantu btn--kecil dorong" onClick={onTutup}>
          Batal
        </button>
      </div>

      {kosong.length > 0 && (
        <div className="pesan pesan--waspada">
          Masih kosong: {kosong.map((f) => f.label).join(', ')}
        </div>
      )}

      <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />

      {isLoading ? <Kosong>Memuat nilai Receiving…</Kosong> : (
        <div className="form-grid">
          <Field label="Berat Jenis" bantuan="Titik atau koma sama saja">
            <input
              className="angka-input"
              inputMode="decimal"
              value={nilai.beratJenis ?? ''}
              onChange={set('beratJenis')}
              disabled={beratJenisTerkunci}
              placeholder="1,025"
            />
          </Field>
          <Field label="Total Solid" bantuan="Boleh dilengkapi menyusul">
            <input
              className="angka-input"
              inputMode="decimal"
              value={nilai.nilaiTs ?? ''}
              onChange={set('nilaiTs')}
              disabled={nilaiTsTerkunci}
              placeholder="12,5"
            />
          </Field>
        </div>
      )}

      {data?.data?.qtyLtr != null ? (
        // Berat Jenis sudah tersimpan sebelumnya — ini angka SUNGGUHAN dari
        // server (sudah masuk stok buffer), bukan hasil ketikan saat ini.
        <div className="bantuan">Volume tercatat: {data.data.qtyLtr} L</div>
      ) : pratinjauLtr !== null && (
        // Belum disimpan — ini hanya pratinjau di browser, dihitung ulang
        // persis seperti server, supaya bisa dicek sebelum menekan simpan.
        <div className="pecahan-total">
          <span className="label">Pratinjau volume</span>
          <b className="angka" style={{ fontSize: 20 }}>{pratinjauLtr} L</b>
          <span className="bantuan">kg ÷ berat jenis, dibulatkan ke bawah — belum tersimpan</span>
        </div>
      )}

      <div className="baris">
        <Lencana nada="waspada">Gantung</Lencana>
        <button
          type="button"
          className="btn btn--utama dorong"
          disabled={simpan.isPending || isLoading}
          onClick={kirim}
        >
          {simpan.isPending ? 'Menyimpan…' : 'Simpan kelengkapan'}
        </button>
      </div>
    </div>
  );
}
