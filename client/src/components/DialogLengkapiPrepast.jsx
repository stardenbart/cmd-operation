import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { isoKeInputWib } from '../lib/waktu.js';
import { Field, Lencana, PesanGalat, Kosong } from './ui.jsx';

const OPRP_MIN = 81;

export default function DialogLengkapiPrepast({ target, onTutup, onSukses }) {
  const qc = useQueryClient();
  const [nilai, setNilai] = useState({});

  const { data, isLoading } = useQuery({
    queryKey: ['prepast', 'complete-context', target.id],
    queryFn: () => api.get(`/prepast/${target.id}/complete-context`),
  });

  useEffect(() => {
    if (!data?.data) return;
    const d = data.data;
    setNilai({
      prepastStart: isoKeInputWib(d.prepastStart),
      prepastFinish: isoKeInputWib(d.prepastFinish),
      flowrate: d.flowrate ?? '',
      tempAfterHeater: d.tempAfterHeater ?? '',
      tempOutput: d.tempOutput ?? '',
    });
  }, [data]);

  const simpan = useMutation({
    mutationFn: (body) => api.post(`/prepast/${target.id}/complete`, body),
    onSuccess: (res) => {
      const d = res.data;
      const pesan = d.isGantung
        ? `${d.kode} tersimpan, masih perlu: ${d.fieldKosong.map((f) => f.label).join(', ')}.`
        : `${d.kode} sudah lengkap dan masuk antrean approval.`;
      qc.invalidateQueries({ queryKey: ['data'] });
      qc.invalidateQueries({ queryKey: ['prepast'] });
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

    if (nilai.prepastFinish && nilai.prepastStart && nilai.prepastFinish <= nilai.prepastStart) {
      const setuju = window.confirm(
        'Waktu selesai lebih awal dari waktu mulai. Konfirmasi bahwa proses melewati tengah malam.',
      );
      if (!setuju) return;
      body.konfirmasiRollover = true;
    }

    const suhu = Number(String(nilai.tempAfterHeater ?? '').replace(',', '.'));
    if (nilai.tempAfterHeater !== '' && suhu < OPRP_MIN) {
      const setuju = window.confirm(
        `Temp After Heater ${suhu} °C di bawah ambang OPRP ${OPRP_MIN} °C. Tetap simpan?`,
      );
      if (!setuju) return;
      body.konfirmasiOprp = true;
    }

    simpan.mutate(body);
  }

  const kosong = data?.data?.fieldKosong ?? [];

  return (
    <div className="kartu tumpuk">
      <div className="kartu__kepala">
        <div>
          <span className="halaman-kepala__eyebrow">Lengkapi Prepast</span>
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

      {isLoading ? <Kosong>Memuat nilai Prepast…</Kosong> : (
        <div className="form-grid">
          <Field label="Mulai" wajib>
            <input type="datetime-local" value={nilai.prepastStart ?? ''} onChange={set('prepastStart')} />
          </Field>
          <Field label="Selesai">
            <input type="datetime-local" value={nilai.prepastFinish ?? ''} onChange={set('prepastFinish')} />
          </Field>
          <Field label="Flowrate">
            <input className="angka-input" inputMode="decimal" value={nilai.flowrate ?? ''} onChange={set('flowrate')} />
          </Field>
          <Field label="Temp after heater" bantuan={`Ambang OPRP ${OPRP_MIN} °C`}>
            <input className="angka-input" inputMode="decimal" value={nilai.tempAfterHeater ?? ''} onChange={set('tempAfterHeater')} />
          </Field>
          <Field label="Temp output">
            <input className="angka-input" inputMode="decimal" value={nilai.tempOutput ?? ''} onChange={set('tempOutput')} />
          </Field>
        </div>
      )}

      <div className="baris">
        <Lencana nada="waspada">Gantung</Lencana>
        <button
          type="button"
          className="btn btn--utama dorong"
          disabled={simpan.isPending || isLoading || !nilai.prepastStart}
          onClick={kirim}
        >
          {simpan.isPending ? 'Menyimpan…' : 'Simpan kelengkapan'}
        </button>
      </div>
    </div>
  );
}
