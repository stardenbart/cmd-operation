import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmt, waktuSingkat, Field, Lencana, PesanGalat, PesanSukses } from '../components/ui.jsx';

const kosong = {
  siloId: '', volumeLtr: '', waktuKembali: '', waktuKeluar: '',
  transferAsalId: '', keteranganAsal: '', alasan: '',
};

/**
 * Pengembalian FM ke silo (BR-25, FR-31)
 *
 * Susu yang sudah ditransfer keluar dikembalikan, tetapi komposisi
 * suppliernya tidak diketahui: di tank dan jalur pipa, susu dari beberapa
 * supplier sudah tercampur. Form ini tidak berusaha menyamarkan hal itu.
 */
export default function Pengembalian() {
  const qc = useQueryClient();
  const [f, setF] = useState(kosong);
  const [sukses, setSukses] = useState(null);

  const { data: ctx } = useQuery({
    queryKey: ['pengembalian', 'form-context'],
    queryFn: () => api.get('/pengembalian/form-context'),
  });

  const { data: transfer } = useQuery({
    queryKey: ['pengembalian', 'transfer-terkini', f.siloId],
    queryFn: () => api.get(`/pengembalian/transfer-terkini/${f.siloId}`),
    enabled: Boolean(f.siloId),
  });

  const simpan = useMutation({
    mutationFn: (body) => api.post('/pengembalian', body),
    onSuccess: (res) => {
      const d = res.data;
      let pesan = `${d.kode} tersimpan. ${fmt(d.volumeLtr)} L masuk ${d.siloName}.`;
      if (d.sumberKunciFifo === 'waktu_kembali') {
        pesan += ' Usia susu tidak diketahui, jadi ia ditempatkan di akhir antrean FIFO.';
      }
      setSukses(pesan);
      setF({ ...kosong, siloId: f.siloId, waktuKembali: f.waktuKembali });
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['pengembalian'] });
    },
  });

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const silo = ctx?.silos.find((s) => String(s.silo_id) === String(f.siloId));

  // Tanpa salah satu dari keduanya, sistem tidak tahu usia susu ini dan
  // terpaksa menempatkannya di akhir antrean.
  const usiaDiketahui = Boolean(f.transferAsalId || f.waktuKeluar);

  return (
    <form
      className="tumpuk"
      onSubmit={(e) => { e.preventDefault(); setSukses(null); simpan.mutate(f); }}
    >
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Pengembalian ke silo</h2>
          <span className="label">Susu yang sudah ditransfer keluar, kembali</span>
        </div>

        <PesanSukses>{sukses}</PesanSukses>
        <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />

        <div className="form-grid">
          <Field
            label="Silo tujuan"
            wajib
            bantuan="Silo kosong didahulukan agar susu kembali tidak bercampur"
          >
            <select value={f.siloId} onChange={set('siloId')} required>
              <option value="">Pilih silo</option>
              {ctx?.silos.map((s) => (
                <option key={s.silo_id} value={s.silo_id}>
                  {s.silo_name}
                  {s.kosong ? ' · kosong' : ` · berisi ${fmt(s.vol_aktual_ltr)} L`}
                  {` · sisa ${fmt(s.vol_tersedia_ltr)} L`}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Volume (L)"
            wajib
            bantuan={silo ? `Tersedia ${fmt(silo.vol_tersedia_ltr)} L` : undefined}
          >
            <input
              className="angka-input" inputMode="decimal"
              value={f.volumeLtr} onChange={set('volumeLtr')} required
            />
          </Field>

          <Field label="Waktu kembali" wajib>
            <input
              type="datetime-local" value={f.waktuKembali}
              onChange={set('waktuKembali')} required
            />
          </Field>
        </div>
      </div>

      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Usia susu</h2>
          <span className="label">Menentukan urutan pemakaian</span>
        </div>

        <p className="bantuan" style={{ marginTop: -8 }}>
          Susu yang kembali bukan susu baru. Sistem perlu tahu kapan ia keluar
          dari silo agar dapat menempatkannya di urutan pemakaian yang benar.
          Tanpa itu, ia akan dipakai paling akhir, padahal ia yang paling tua.
        </p>

        <div className="form-grid">
          <Field label="Transfer asal" bantuan="Bila diketahui, waktunya diambil dari sini">
            <select value={f.transferAsalId} onChange={set('transferAsalId')}>
              <option value="">Tidak ditautkan</option>
              {transfer?.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kode} · {fmt(t.vol_ltr)} L ke {t.tujuan} · {waktuSingkat(t.trf_time)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Waktu keluar silo"
            bantuan={f.transferAsalId ? 'Diambil dari transfer asal' : 'Isi bila transfer asal tidak diketahui'}
          >
            <input
              type="datetime-local" value={f.waktuKeluar}
              onChange={set('waktuKeluar')}
              disabled={Boolean(f.transferAsalId)}
            />
          </Field>

          <Field label="Keterangan asal" bantuan="Dari mana susu kembali">
            <input
              value={f.keteranganAsal} onChange={set('keteranganAsal')}
              placeholder="Kembali dari MT 1, jalur produksi berhenti"
            />
          </Field>
        </div>

        {!usiaDiketahui && (
          <div className="pesan pesan--waspada">
            Usia susu belum diketahui. Bila dibiarkan kosong, pengembalian ini
            akan ditempatkan di akhir antrean FIFO dan baru dipakai paling
            akhir, padahal ia sudah lebih lama berada di luar silo.
          </div>
        )}
      </div>

      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Asal supplier</h2>
          <Lencana nada="waspada">Tidak dapat ditelusuri</Lencana>
        </div>

        <p className="bantuan" style={{ marginTop: -8 }}>
          Susu yang kembali sudah tercampur di tank dan jalur pipa, sehingga
          komposisi suppliernya tidak dapat dipisahkan lagi. Volume ini dicatat
          tanpa identitas supplier, dan silo yang menerimanya akan menampilkan
          berapa banyak isinya yang tidak dapat ditelusuri.
        </p>

        {silo && !silo.kosong && (
          <div className="pesan pesan--waspada">
            {silo.silo_name} sudah berisi {fmt(silo.vol_aktual_ltr)} L. Menambahkan
            susu tak tertelusuri ke sana membuat seluruh isinya ikut kehilangan
            ketertelusuran. Bila memungkinkan, pakai silo kosong.
          </div>
        )}

        {silo && Number(silo.vol_tak_dikenal_ltr) > 0 && (
          <div className="pesan pesan--waspada">
            {silo.silo_name} sudah berisi {fmt(silo.vol_tak_dikenal_ltr)} L yang
            asalnya tidak diketahui.
          </div>
        )}

        <Field label="Alasan pengembalian" wajib bantuan="Tercatat di jejak audit">
          <textarea
            value={f.alasan} onChange={set('alasan')} required
            placeholder="Produksi dihentikan karena kerusakan mesin filling"
          />
        </Field>

        <div className="baris">
          <button className="btn btn--utama dorong" disabled={simpan.isPending}>
            {simpan.isPending ? 'Menyimpan…' : 'Simpan pengembalian'}
          </button>
        </div>
      </div>
    </form>
  );
}
