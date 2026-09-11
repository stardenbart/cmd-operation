import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmt, Field, PesanGalat, PesanSukses } from '../components/ui.jsx';
import { PilihCari } from '../components/pilih.jsx';

const kosong = { supplierId: '', qtyKg: '', beratJenis: '', nilaiTs: '', finishTime: '', remarks: '' };

export default function Receiving() {
  const qc = useQueryClient();
  const [f, setF] = useState(kosong);
  const [sukses, setSukses] = useState(null);

  const { data: ctx } = useQuery({
    queryKey: ['receiving', 'form-context'],
    queryFn: () => api.get('/receiving/form-context'),
  });

  const simpan = useMutation({
    mutationFn: (body) => api.post('/receiving', body),
    onSuccess: (res) => {
      const d = res.data;
      if (d.is_gantung) {
        const kosongLabel = [];
        if (d.berat_jenis === null) kosongLabel.push('Berat Jenis');
        if (d.nilai_ts === null) kosongLabel.push('Total Solid');
        setSukses(`${d.kode} tersimpan, masih perlu: ${kosongLabel.join(', ')}. Lengkapi lewat Data List.`);
      } else {
        setSukses(`${d.kode} tersimpan. ${fmt(d.qty_ltr)} L masuk buffer.`);
      }
      setF(kosong);
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['receiving'] });
    },
  });

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  // BR-03 — pratinjau konversi, dibulatkan ke bawah persis seperti server.
  // Berat Jenis boleh kosong (dilengkapi belakangan) — volume belum dapat
  // dihitung sampai nilainya tersedia, beda dengan "belum ada input sama sekali".
  const kg = parseFloat(String(f.qtyKg).replace(',', '.'));
  const bj = parseFloat(String(f.beratJenis).replace(',', '.'));
  const beratJenisKosong = f.beratJenis === '';
  const liter = kg > 0 && bj > 0 ? Math.floor(kg / bj) : null;

  return (
    <form
      className="tumpuk"
      onSubmit={(e) => { e.preventDefault(); setSukses(null); simpan.mutate(f); }}
    >
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Penerimaan susu</h2>
          {ctx?.buffer && (
            <span className="label">
              Tujuan {ctx.buffer.silo_name} · tersedia {fmt(ctx.buffer.vol_tersedia_ltr)} L
            </span>
          )}
        </div>

        <PesanSukses>{sukses}</PesanSukses>
        <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />

        <div className="form-grid">
          <Field label="Supplier" wajib bantuan="Ketik untuk mencari">
            {/* 32 supplier dengan nama mirip-mirip. Menggulir dropdown di layar
                sentuh sambil memegang sesuatu yang lain menghasilkan salah
                pilih, dan salah supplier tidak menimbulkan galat apa pun -
                ia hanya mencatat susu dari pemasok yang salah. */}
            <PilihCari
              opsi={(ctx?.suppliers ?? []).map((s) => ({ id: s.id, label: s.supplier_name }))}
              nilai={f.supplierId}
              onChange={(id) => setF({ ...f, supplierId: id })}
              placeholder="Cari nama supplier"
              required
            />
          </Field>

          <Field label="Waktu selesai" wajib bantuan="Satu isian tanggal & jam sekaligus">
            {/* WF-1 — menggantikan DatePicker + jam + menit terpisah beserta
                enam aturan validasi "harus 2 digit" yang lahir dari situ */}
            <input type="datetime-local" value={f.finishTime} onChange={set('finishTime')} required />
          </Field>

          <Field label="Kuantitas (kg)" wajib>
            <input className="angka-input" inputMode="decimal" value={f.qtyKg} onChange={set('qtyKg')} placeholder="20296" required />
          </Field>

          <Field label="Berat jenis" bantuan="Boleh dikosongkan dulu — masuk Perlu dilengkapi">
            <input className="angka-input" inputMode="decimal" value={f.beratJenis} onChange={set('beratJenis')} placeholder="1,025" />
          </Field>

          <Field label="Total solid" bantuan="Boleh dikosongkan dulu — masuk Perlu dilengkapi">
            <input className="angka-input" inputMode="decimal" value={f.nilaiTs} onChange={set('nilaiTs')} placeholder="12,5" />
          </Field>

          <Field label="Catatan">
            <input value={f.remarks} onChange={set('remarks')} />
          </Field>
        </div>

        <div className="pecahan-total">
          <span className="label">Volume tercatat</span>
          <b className="angka" style={{ fontSize: 20 }}>
            {liter !== null ? `${fmt(liter)} L` : beratJenisKosong && kg > 0 ? 'Belum dapat dihitung' : '-'}
          </b>
          <span className="bantuan">kg ÷ berat jenis, dibulatkan ke bawah</span>
        </div>

        <div className="baris">
          <button className="btn btn--utama dorong" disabled={simpan.isPending}>
            {simpan.isPending ? 'Menyimpan…' : 'Simpan penerimaan'}
          </button>
        </div>
      </div>
    </form>
  );
}
