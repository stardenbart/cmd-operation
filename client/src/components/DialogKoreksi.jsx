import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmt, Field, Lencana, PesanGalat, Kosong } from './ui.jsx';
import { FIELD } from '../lib/fieldKoreksi.js';
import { isoKeInputWib } from '../lib/waktu.js';

/** Pohon turunan yang menghalangi koreksi. */
function Pohon({ pohon, tingkat = 0 }) {
  return pohon.map((s) => (
    <div key={`${s.modul}${s.id}`}>
      <div className="baris" style={{ paddingLeft: tingkat * 20, gap: 8, padding: '4px 0', flexWrap: 'nowrap' }}>
        <span className="label" style={{ minWidth: 84 }}>{s.modul}</span>
        <span className="angka">{s.kode}</span>
        <span className="angka" style={{ color: 'var(--text-secondary)' }}>{fmt(s.volumeLtr)} L</span>
      </div>
      <Pohon pohon={s.anak} tingkat={tingkat + 1} />
    </div>
  ));
}

export default function DialogKoreksi({ target, onTutup, onSukses }) {
  const qc = useQueryClient();
  const [nilai, setNilai] = useState({});
  const [alasan, setAlasan] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['koreksi', target.modul, target.id],
    queryFn: () => api.get(`/koreksi/${target.modul}/${target.id}`),
  });

  const daftarField = FIELD[target.modul] ?? [];

  // Form diisi nilai yang ADA SEKARANG, bukan kosong: koreksi adalah
  // mengubah sebagian, dan operator perlu melihat apa yang sedang diubah.
  useEffect(() => {
    if (!data) return;
    const awal = {};
    for (const f of daftarField) {
      if (!f.dari) continue;
      const v = data.data[f.dari];
      awal[f.k] = f.jenis === 'waktu' ? isoKeInputWib(v) : (v ?? '');
    }
    setNilai(awal);
  }, [data]);

  const simpan = useMutation({
    mutationFn: (body) => api.post(`/koreksi/${target.modul}/${target.id}`, body),
    onSuccess: (res) => {
      const d = res.data;
      onSukses(
        d.cara === 'reversal'
          ? `${d.kode} dibuat menggantikan ${d.kodeDigantikan}. Record lama ditandai REVISED.`
          : `${d.kode} dikoreksi.` +
            (d.indukDisesuaikan
              ? ` Sisa batch induk ${d.indukDisesuaikan.kode} menjadi ${fmt(d.indukDisesuaikan.sisaBaruLtr)} L.`
              : ''),
      );
      qc.invalidateQueries({ queryKey: ['data'] });
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['approval'] });
    },
  });

  const set = (k) => (e) => setNilai({ ...nilai, [k]: e.target.value });
  const terhalang = simpan.error?.kode === 'BR-15';
  const reversal = target.statusApproval === 'Approved';

  return (
    <div className="kartu tumpuk">
      <div className="kartu__kepala">
        <h2>Koreksi {target.kode}</h2>
        {reversal && <Lencana nada="waspada">Sudah disetujui</Lencana>}
        <button type="button" className="btn btn--hantu btn--kecil dorong" onClick={onTutup}>
          Batal
        </button>
      </div>

      <p className="bantuan" style={{ marginTop: -8 }}>{target.ringkasan}</p>

      {reversal && (
        <div className="pesan pesan--waspada">
          Record ini sudah disetujui, jadi koreksinya membuat record BARU dan
          menandai yang lama sebagai REVISED. Penggantian itu harus terlihat di
          daftar transaksi, bukan hanya di jejak audit.
        </div>
      )}

      {terhalang ? (
        <>
          <div className="pesan pesan--galat">{simpan.error.message}</div>
          <h3>Turunan yang harus ditangani lebih dulu</h3>
          <div style={{ borderLeft: '2px solid var(--gridline)', paddingLeft: 12 }}>
            <Pohon pohon={simpan.error.detail?.pohon ?? []} />
          </div>
        </>
      ) : (
        <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />
      )}

      {isLoading ? (
        <Kosong>Memuat nilai saat ini…</Kosong>
      ) : (
        <div className="form-grid">
          {daftarField.map((f) => (
            <Field key={f.k} label={f.label} bantuan={f.bantuan}>
              {f.jenis === 'waktu' && (
                <input type="datetime-local" value={nilai[f.k] ?? ''} onChange={set(f.k)} />
              )}
              {f.jenis === 'angka' && (
                <input
                  className="angka-input" inputMode="decimal"
                  value={nilai[f.k] ?? ''} onChange={set(f.k)}
                />
              )}
              {f.jenis === 'teks' && (
                <input value={nilai[f.k] ?? ''} onChange={set(f.k)} />
              )}
              {f.jenis === 'pilihSupplier' && (
                <select value={nilai[f.k] ?? ''} onChange={set(f.k)}>
                  <option value="">Tidak diubah</option>
                  {data?.suppliers?.map((sp) => (
                    <option key={sp.id} value={sp.id}>{sp.supplier_name}</option>
                  ))}
                </select>
              )}
              {f.jenis === 'pilihTank' && (
                <select value={nilai[f.k] ?? ''} onChange={set(f.k)}>
                  <option value="">Tidak diubah</option>
                  {data?.tanks?.map((t) => (
                    <option key={t.id} value={t.id}>{t.tank_name}</option>
                  ))}
                </select>
              )}
              {f.jenis === 'pilihPrefiks' && (
                <select value={nilai[f.k] ?? ''} onChange={set(f.k)}>
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

      {target.modul === 'receiving' && (
        <div className="pecahan-total">
          <span className="label">Volume tercatat</span>
          <b className="angka" style={{ fontSize: 18 }}>
            {(() => {
              const kg = parseFloat(String(nilai.qtyKg ?? '').replace(',', '.'));
              const bj = parseFloat(String(nilai.beratJenis ?? '').replace(',', '.'));
              return kg > 0 && bj > 0 ? `${fmt(Math.floor(kg / bj))} L` : '-';
            })()}
          </b>
          <span className="bantuan">kg dibagi berat jenis, dibulatkan ke bawah</span>
        </div>
      )}

      {target.modul === 'transfer' && (
        <p className="bantuan">
          Volume transfer tidak dapat dikoreksi di sini: mengubahnya berarti
          menghitung ulang alokasi FIFO. Batalkan transfernya lalu buat yang baru.
        </p>
      )}

      <Field label="Alasan koreksi" wajib bantuan="Tercatat di jejak audit">
        <textarea
          value={alasan} onChange={(e) => setAlasan(e.target.value)}
          placeholder="Flowmeter salah baca, volume dikoreksi"
        />
      </Field>

      <div className="baris">
        <button
          type="button"
          className="btn btn--utama dorong"
          disabled={alasan.trim().length < 3 || simpan.isPending || isLoading}
          onClick={() => simpan.mutate({ ...nilai, alasan, konfirmasiRollover: true })}
        >
          {simpan.isPending
            ? 'Menyimpan…'
            : reversal ? 'Simpan sebagai record baru' : 'Simpan koreksi'}
        </button>
      </div>
    </div>
  );
}
