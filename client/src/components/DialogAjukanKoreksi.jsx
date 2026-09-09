import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmt, Field, PesanGalat, Kosong } from './ui.jsx';
import { FIELD } from '../lib/fieldKoreksi.js';
import { isoKeInputWib } from '../lib/waktu.js';

/**
 * Pengajuan permintaan koreksi - FR-15, WF-3.
 *
 * Bedanya dengan dialog koreksi biasa bukan hanya endpointnya. Di sini
 * operator MENGUSULKAN, jadi form dimulai KOSONG, bukan terisi nilai
 * sekarang: yang dikirim hanya field yang benar-benar ia ubah. Kalau form
 * terisi semua nilai lalu semuanya dikirim, SPV akan melihat delapan baris
 * perbandingan yang tujuh di antaranya tidak berubah, dan yang penting
 * tenggelam di antaranya.
 */
export default function DialogAjukanKoreksi({ target, onTutup, onSukses }) {
  const qc = useQueryClient();
  const [usulan, setUsulan] = useState({});
  const [alasan, setAlasan] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['koreksi', target.modul, target.id],
    queryFn: () => api.get(`/koreksi/${target.modul}/${target.id}`),
  });

  const daftarField = FIELD[target.modul] ?? [];

  // Nilai sekarang tetap ditampilkan sebagai pembanding, hanya tidak
  // dimasukkan ke usulan.
  const [sekarang, setSekarang] = useState({});
  useEffect(() => {
    if (!data) return;
    const awal = {};
    for (const f of daftarField) {
      if (!f.dari) continue;
      const v = data.data[f.dari];
      awal[f.k] = f.jenis === 'waktu' ? isoKeInputWib(v) : (v ?? '');
    }
    setSekarang(awal);
  }, [data]);

  const kirim = useMutation({
    mutationFn: (body) => api.post('/permintaan-koreksi', body),
    onSuccess: (res) => {
      const d = res.data;
      onSukses(
        `Permintaan koreksi untuk ${d.kode} terkirim dan menunggu SPV. ` +
          `Record tetap berstatus ${d.statusRecord}, jadi tidak hilang dari laporan.`,
      );
      qc.invalidateQueries({ queryKey: ['permintaan-koreksi'] });
    },
  });

  const set = (k) => (e) => setUsulan({ ...usulan, [k]: e.target.value });

  const terisi = Object.entries(usulan).filter(([, v]) => v !== '' && v != null);
  const berubah = terisi.filter(([k, v]) => String(sekarang[k] ?? '') !== String(v));

  /** Label yang dapat dibaca untuk pilihan, supaya ringkasannya berarti. */
  const labelNilai = (f, v) => {
    if (f.jenis === 'pilihSupplier') {
      return data?.suppliers?.find((s) => String(s.id) === String(v))?.supplier_name ?? v;
    }
    if (f.jenis === 'pilihTank') {
      return data?.tanks?.find((t) => String(t.id) === String(v))?.tank_name ?? v;
    }
    return v;
  };

  return (
    <div className="kartu tumpuk">
      <div className="kartu__kepala">
        <h2>Ajukan koreksi {target.kode}</h2>
        <button type="button" className="btn btn--hantu btn--kecil dorong" onClick={onTutup}>
          Batal
        </button>
      </div>

      <p className="bantuan" style={{ marginTop: -8 }}>{target.ringkasan}</p>

      <div className="pesan pesan--info">
        Record ini sudah disetujui, jadi hanya SPV yang dapat mengubahnya. Isi
        nilai yang menurut Anda seharusnya, lalu SPV meninjau perbandingannya.
        Selama menunggu, record TETAP berstatus Approved dan tetap ikut
        terekspor. Isi hanya field yang perlu diubah, sisanya biarkan kosong.
      </div>

      <PesanGalat galat={kirim.error} onTutup={() => kirim.reset()} />

      {isLoading ? (
        <Kosong>Memuat nilai sekarang…</Kosong>
      ) : (
        <div className="form-grid">
          {daftarField.map((f) => (
            <Field
              key={f.k}
              label={f.label}
              bantuan={
                f.dari
                  ? `Sekarang: ${sekarang[f.k] === '' || sekarang[f.k] == null
                      ? 'kosong'
                      : labelNilai(f, sekarang[f.k])}`
                  : f.bantuan
              }
            >
              {f.jenis === 'waktu' && (
                <input type="datetime-local" value={usulan[f.k] ?? ''} onChange={set(f.k)} />
              )}
              {f.jenis === 'angka' && (
                <input
                  className="angka-input" inputMode="decimal" placeholder="Tidak diubah"
                  value={usulan[f.k] ?? ''} onChange={set(f.k)}
                />
              )}
              {f.jenis === 'teks' && (
                <input placeholder="Tidak diubah" value={usulan[f.k] ?? ''} onChange={set(f.k)} />
              )}
              {f.jenis === 'pilihSupplier' && (
                <select value={usulan[f.k] ?? ''} onChange={set(f.k)}>
                  <option value="">Tidak diubah</option>
                  {data?.suppliers?.map((sp) => (
                    <option key={sp.id} value={sp.id}>{sp.supplier_name}</option>
                  ))}
                </select>
              )}
              {f.jenis === 'pilihTank' && (
                <select value={usulan[f.k] ?? ''} onChange={set(f.k)}>
                  <option value="">Tidak diubah</option>
                  {data?.tanks?.map((t) => (
                    <option key={t.id} value={t.id}>{t.tank_name}</option>
                  ))}
                </select>
              )}
              {f.jenis === 'pilihPrefiks' && (
                <select value={usulan[f.k] ?? ''} onChange={set(f.k)}>
                  <option value="">Tidak diubah</option>
                  {data?.prefiksBatch?.map((p) => (
                    <option key={p.kode} value={p.kode}>
                      {p.kode}{p.is_standar ? '' : ' (non-baku)'}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ))}
        </div>
      )}

      {/* Ringkasan apa yang akan dilihat SPV, sebelum dikirim */}
      <div className="pecahan-total" style={{ display: 'block' }}>
        <span className="label">Yang akan ditinjau SPV</span>
        {berubah.length === 0 ? (
          <p className="bantuan" style={{ margin: '6px 0 0' }}>
            Belum ada nilai yang berbeda dari nilai sekarang.
          </p>
        ) : (
          <table className="tabel" style={{ marginTop: 6 }}>
            <tbody>
              {berubah.map(([k, v]) => {
                const f = daftarField.find((x) => x.k === k);
                return (
                  <tr key={k}>
                    <td style={{ width: '38%' }}>{f?.label ?? k}</td>
                    <td className="num" style={{ color: 'var(--text-secondary)' }}>
                      {sekarang[k] === '' || sekarang[k] == null
                        ? 'kosong'
                        : labelNilai(f, sekarang[k])}
                    </td>
                    <td style={{ width: 24, textAlign: 'center' }}>&rarr;</td>
                    <td className="num"><b>{labelNilai(f, v)}</b></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {target.modul === 'receiving' && (usulan.qtyKg || usulan.beratJenis) && (
        <div className="pecahan-total">
          <span className="label">Volume bila disetujui</span>
          <b className="angka" style={{ fontSize: 18 }}>
            {(() => {
              const ambil = (k) =>
                parseFloat(String(usulan[k] ?? sekarang[k] ?? '').replace(',', '.'));
              const kg = ambil('qtyKg');
              const bj = ambil('beratJenis');
              return kg > 0 && bj > 0 ? `${fmt(Math.floor(kg / bj))} L` : '-';
            })()}
          </b>
          <span className="bantuan">kg dibagi berat jenis, dibulatkan ke bawah</span>
        </div>
      )}

      <Field
        label="Alasan permintaan"
        wajib
        bantuan="Dibaca SPV saat menimbang, dan tercatat di jejak audit"
      >
        <textarea
          value={alasan} onChange={(e) => setAlasan(e.target.value)}
          placeholder="Hasil lab TS keluar berbeda dari yang diinput"
        />
      </Field>

      <div className="baris">
        <button
          type="button"
          className="btn btn--utama dorong"
          disabled={alasan.trim().length < 3 || berubah.length === 0 || kirim.isPending}
          onClick={() =>
            kirim.mutate({
              modul: target.modul,
              entityId: target.id,
              usulan: Object.fromEntries(berubah),
              alasan,
            })
          }
        >
          {kirim.isPending ? 'Mengirim…' : 'Kirim permintaan ke SPV'}
        </button>
      </div>
    </div>
  );
}
