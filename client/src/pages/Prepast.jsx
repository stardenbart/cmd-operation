import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import {
  fmt, waktuSingkat, Field, Lencana, PesanGalat, PesanSukses, Kosong,
} from '../components/ui.jsx';

const OPRP_MIN = 81;
const angka = (v) => parseFloat(String(v).replace(',', '.'));
const keInputWaktu = (nilai) => {
  if (!nilai) return '';
  const d = new Date(nilai);
  const lokal = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return lokal.toISOString().slice(0, 16);
};

/**
 * Prepast multi-silo — FR-29.
 *
 * Variabel proses diisi SATU KALI dan berlaku untuk seluruh baris silo.
 * Power Apps memaksa mengisi form yang sama berulang kali, mengetik ulang
 * jam, flowrate, dan kedua suhu di tiap pengulangan — sumber anomali
 * SILO25A/25A (B-18) dan sumber nilai yang tidak konsisten antar pecahan.
 */
export default function Prepast() {
  const qc = useQueryClient();
  const [batch, setBatch] = useState(null);
  const [pecahan, setPecahan] = useState([{ siloId: '', volumeLtr: '' }]);
  const [proses, setProses] = useState({
    prepastStart: '', prepastFinish: '', flowrate: '', tempAfterHeater: '', tempOutput: '', remarks: '',
  });
  const [sukses, setSukses] = useState(null);
  const [kontinu, setKontinu] = useState(false);

  const { data: antrean, isLoading } = useQuery({
    queryKey: ['prepast', 'buffer-queue'],
    queryFn: () => api.get('/prepast/buffer-queue'),
  });
  // Preferensi tampilan GLOBAL (bukan per-halaman) — diatur Admin di Master
  // Data Silo, berlaku sama untuk semua orang. Cache dibagi lintas halaman
  // lewat kunci ['pengaturan'] yang sama.
  const { data: pengaturan } = useQuery({
    queryKey: ['pengaturan'],
    queryFn: () => api.get('/pengaturan'),
  });
  const tampilkanSisaSilo = pengaturan?.data?.tampilkanSisaSilo ?? true;
  const { data: ctx } = useQuery({
    queryKey: ['prepast', 'form-context', batch?.id],
    queryFn: () => api.get(`/prepast/form-context/${batch.id}`),
    enabled: Boolean(batch),
  });
  const { data: konteksKontinu } = useQuery({
    queryKey: ['prepast', 'continuity'],
    queryFn: () => api.get('/prepast/continuity'),
    enabled: Boolean(batch),
  });
  const sebelumnya = konteksKontinu?.data?.sebelumnya;
  const saranStart = keInputWaktu(konteksKontinu?.data?.saranStart);

  const simpan = useMutation({
    mutationFn: (body) => api.post('/prepast', body),
    onSuccess: (res) => {
      const d = res.data;
      setSukses(
        `${d.dibuat.length} record dibuat: ${d.dibuat.map((x) => x.kode).join(', ')}. ` +
        (d.sisaBatchIndukLtr === null
          ? 'Volume belum dapat dihitung — Berat Jenis Receiving induk belum diisi.'
          : `Total ${fmt(d.totalLtr)} L. Sisa batch induk ${fmt(d.sisaBatchIndukLtr)} L.`) +
        (d.gantung
          ? ` Perlu dilengkapi: ${d.fieldKosong.map((f) => f.label).join(', ')}.`
          : ' Data proses lengkap.'),
      );
      setBatch(null);
      setPecahan([{ siloId: '', volumeLtr: '' }]);
      setProses({ prepastStart: '', prepastFinish: '', flowrate: '', tempAfterHeater: '', tempOutput: '', remarks: '' });
      setKontinu(false);
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['prepast'] });
    },
  });

  const setP = (k) => (e) => {
    const nilai = e.target.value;
    setProses({ ...proses, [k]: nilai });
    if (k === 'prepastStart' && kontinu && nilai !== saranStart) setKontinu(false);
  };

  // NULL berarti Receiving induknya belum punya Berat Jenis — volume liternya
  // memang belum dapat dihitung, beda dari batch yang sungguh sudah habis.
  const sisaTidakDiketahui = Boolean(batch) && batch.qty_remaining_ltr == null;
  const sisaBatch = batch ? Number(batch.qty_remaining_ltr) : 0;
  const totalPecahan = pecahan.reduce((s, p) => s + (angka(p.volumeLtr) || 0), 0);
  const sisaAlokasi = Math.round((sisaBatch - totalPecahan) * 100) / 100;
  // Setiap baris yang terlihat adalah satu record. Silo dan volume yang kosong
  // sengaja tidak dikirim agar backend menyimpannya sebagai NULL dan menagih
  // keduanya lewat Dashboard.
  const pecahanSiap = pecahan.map((p) => ({
    ...(p.siloId ? { siloId: Number(p.siloId) } : {}),
    ...(p.volumeLtr !== '' ? { volumeLtr: p.volumeLtr } : {}),
  }));
  const jumlahTanpaSilo = pecahanSiap.filter((p) => p.siloId === undefined).length;
  const jumlahTanpaVolume = pecahanSiap.filter((p) => p.volumeLtr === undefined).length;

  // Silo yang sudah dipilih tidak muncul lagi di baris berikutnya —
  // FR-29.5 membuat SILO25A/25A mustahil, bukan sekadar tidak dianjurkan.
  const siloTersedia = (idx) => {
    const dipakai = new Set(pecahan.filter((_, i) => i !== idx).map((p) => String(p.siloId)));
    return (ctx?.siloTujuan ?? []).filter((s) => !dipakai.has(String(s.silo_id)));
  };

  const ubahPecahan = (i, k, v) =>
    setPecahan(pecahan.map((p, idx) => (idx === i ? { ...p, [k]: v } : p)));

  const tempRendah = proses.tempAfterHeater !== '' && angka(proses.tempAfterHeater) < OPRP_MIN;

  function kirim(e) {
    e.preventDefault();
    setSukses(null);
    let konfirmasiRollover = false;
    if (proses.prepastFinish && proses.prepastStart
      && proses.prepastFinish <= proses.prepastStart) {
      konfirmasiRollover = window.confirm(
        'Waktu selesai lebih awal dari waktu mulai. Konfirmasi bahwa proses melewati tengah malam.',
      );
      if (!konfirmasiRollover) return;
    }

    let konfirmasiOprp = false;
    if (tempRendah) {
      konfirmasiOprp = window.confirm(
        `Temp After Heater ${angka(proses.tempAfterHeater)} °C di bawah ambang OPRP ${OPRP_MIN} °C. Tetap simpan?`,
      );
      if (!konfirmasiOprp) return;
    }

    // Waktu Selesai dan Silo Tujuan yang kosong dikirim sebagai tidak-ada:
    // itulah yang membuat record MENGGANTUNG, bukan ditolak validasi.
    const { prepastFinish, ...prosesTanpaFinish } = proses;
    simpan.mutate({
      receivingId: batch.id,
      pecahan: pecahanSiap,
      ...prosesTanpaFinish,
      ...(prepastFinish ? { prepastFinish } : {}),
      konfirmasiRollover,
      konfirmasiOprp,
      kontinu,
      continuityPreviousId: kontinu ? sebelumnya?.id : undefined,
    });
  }

  if (isLoading) return <Kosong>Memuat antrean buffer…</Kosong>;

  if (!batch) {
    return (
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Antrean buffer</h2>
          <span className="label">Urut masuk, yang paling lama diprepast lebih dulu</span>
        </div>
        <PesanSukses>{sukses}</PesanSukses>
        {antrean?.data.length === 0 && <Kosong>Buffer kosong. Belum ada yang bisa diprepast.</Kosong>}
        <table className="tabel">
          <thead>
            <tr>
              <th>Batch</th><th>Supplier</th><th className="num">Sisa</th>
              <th>Diterima</th><th></th>
            </tr>
          </thead>
          <tbody>
            {antrean?.data.map((r, i) => (
              <tr key={r.id}>
                <td>
                  <span className="angka">{r.kode}</span>
                  {i === 0 && <> <Lencana nada="baik">Terlama</Lencana></>}
                </td>
                <td>{r.supplier_name}</td>
                <td className="num">
                  {r.qty_remaining_ltr == null
                    ? <Lencana nada="waspada">Volume belum diketahui</Lencana>
                    : `${fmt(r.qty_remaining_ltr)} L`}
                </td>
                <td>{waktuSingkat(r.finish_time)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button type="button" className="btn btn--kedua btn--kecil" onClick={() => setBatch(r)}>
                    Prepast
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <form className="tumpuk" onSubmit={kirim}>
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>{batch.kode} · {batch.supplier_name}</h2>
          <span className="label">
            {sisaTidakDiketahui ? 'Sisa belum diketahui — Berat Jenis Receiving belum diisi' : `Sisa ${fmt(sisaBatch)} L`}
          </span>
          <button type="button" className="btn btn--hantu btn--kecil" onClick={() => setBatch(null)}>
            Ganti batch
          </button>
        </div>

        <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />

        <h3>Proses</h3>
        <p className="bantuan" style={{ marginTop: -8 }}>
          Diisi sekali, berlaku untuk semua silo tujuan di bawah.
        </p>
        <div className="form-grid">
          <Field label="Mulai" wajib>
            <input type="datetime-local" value={proses.prepastStart} onChange={setP('prepastStart')} required />
          </Field>
          <Field label="Selesai" bantuan="Boleh dikosongkan dulu - record menggantung sampai dilengkapi">
            <input type="datetime-local" value={proses.prepastFinish} onChange={setP('prepastFinish')} />
          </Field>
          <Field label="Flowrate" bantuan="Boleh dikosongkan dulu - record menggantung sampai dilengkapi">
            <input className="angka-input" inputMode="decimal" value={proses.flowrate} onChange={setP('flowrate')} placeholder="5,2" />
          </Field>
          <Field label="Temp after heater" bantuan={`Ambang OPRP ${OPRP_MIN} °C - boleh dikosongkan, record menggantung`}>
            <input className="angka-input" inputMode="decimal" value={proses.tempAfterHeater} onChange={setP('tempAfterHeater')} placeholder="87,5" />
          </Field>
          <Field label="Temp output" bantuan="Boleh dikosongkan dulu - record menggantung sampai dilengkapi">
            <input className="angka-input" inputMode="decimal" value={proses.tempOutput} onChange={setP('tempOutput')} placeholder="7,0" />
          </Field>
          <Field label="Catatan">
            <input value={proses.remarks} onChange={setP('remarks')} />
          </Field>
        </div>

        <div className="pesan pesan--info tumpuk" style={{ gap: 10 }}>
            <div className="kartu__kepala">
              <div>
                <b>Kontinuitas Prepast</b>
                <div className="bantuan">
                  {sebelumnya
                    ? `${sebelumnya.kode} selesai ${waktuSingkat(sebelumnya.finish)} di ${sebelumnya.siloName} · ${sebelumnya.status}`
                    : 'Belum ada record Prepast sebelumnya di plant.'}
                </div>
              </div>
              {sebelumnya && <Lencana nada={kontinu ? 'baik' : 'netral'}>{kontinu ? 'Kontinu' : 'Tidak Kontinu'}</Lencana>}
            </div>
            <label className="baris" style={{ alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={kontinu}
                disabled={!sebelumnya}
                onChange={(e) => {
                  setKontinu(e.target.checked);
                  if (e.target.checked) {
                    setProses((lama) => ({ ...lama, prepastStart: saranStart }));
                  }
                }}
              />
              Proses Kontinu — gunakan Waktu Selesai record Prepast terakhir sebagai Waktu Mulai
            </label>
        </div>

        {tempRendah && (
          <div className="pesan pesan--waspada">
            Temp after heater di bawah ambang OPRP {OPRP_MIN} °C. Data tetap dapat
            disimpan, tetapi penyimpangan ini akan tercatat.
          </div>
        )}
      </div>

      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Silo tujuan</h2>
          <span className="label">Boleh lebih dari satu</span>
        </div>

        {pecahan.map((p, i) => (
          <div className="pecahan-baris" key={i}>
            <Field label={`Silo ${i + 1}`} bantuan="Boleh dikosongkan dulu—record masuk Perlu dilengkapi">
              <select value={p.siloId} onChange={(e) => ubahPecahan(i, 'siloId', e.target.value)}>
                <option value="">Pilih silo</option>
                {siloTersedia(i).map((s) => (
                  <option key={s.silo_id} value={s.silo_id}>
                    {s.silo_name}{tampilkanSisaSilo ? ` · sisa ${fmt(s.vol_tersedia_ltr)} L` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Volume (L)"
              bantuan={sisaTidakDiketahui
                ? 'Lengkapi Berat Jenis Receiving ini dulu di Data List, baru Volume bisa diisi'
                : 'Boleh dikosongkan dulu—record masuk Perlu dilengkapi'}
            >
              <input
                className="angka-input"
                inputMode="decimal"
                value={p.volumeLtr}
                onChange={(e) => ubahPecahan(i, 'volumeLtr', e.target.value)}
                disabled={sisaTidakDiketahui}
              />
            </Field>
            {/* Spacer label kosong — bukan tombolnya langsung dalam grid —
                supaya turun sejajar dengan kotak Silo/Volume di sebelahnya
                (lihat catatan align-items pada .pecahan-baris di app.css). */}
            <div className="field">
              <span className="label">&nbsp;</span>
              <button
                type="button"
                className="btn btn--bahaya btn--kecil"
                onClick={() => setPecahan(pecahan.filter((_, idx) => idx !== i))}
                disabled={pecahan.length === 1}
                aria-label={`Hapus silo baris ${i + 1}`}
              >
                Hapus
              </button>
            </div>
          </div>
        ))}

        <div className="baris">
          <button
            type="button"
            className="btn btn--kedua btn--kecil"
            onClick={() => setPecahan([...pecahan, { siloId: '', volumeLtr: '' }])}
          >
            Tambah silo
          </button>
          {/* FR-29.4 — kasus paling umum: sisakan seluruhnya ke baris terakhir */}
          <button
            type="button"
            className="btn btn--kedua btn--kecil"
            disabled={sisaTidakDiketahui || sisaAlokasi <= 0}
            onClick={() => {
              const i = pecahan.length - 1;
              const lain = pecahan.reduce((s, p, idx) => (idx === i ? s : s + (angka(p.volumeLtr) || 0)), 0);
              ubahPecahan(i, 'volumeLtr', String(Math.round((sisaBatch - lain) * 100) / 100));
            }}
          >
            Sisakan ke baris terakhir
          </button>
        </div>

        {sisaTidakDiketahui ? (
          <div className="pesan pesan--info" role="status">
            Volume belum dapat dialokasikan — Berat Jenis Receiving {batch.kode} belum
            diisi. Silo tujuan tetap boleh dipilih sekarang; Volume menyusul lewat
            "Lengkapi" setelah Berat Jenis-nya tersedia.
          </div>
        ) : (
          <div className={`pecahan-total ${sisaAlokasi === 0 ? 'pecahan-total--pas' : sisaAlokasi < 0 ? 'pecahan-total--lebih' : ''}`}>
            <span className="label">Teralokasi</span>
            <b>{fmt(totalPecahan, 2)} / {fmt(sisaBatch, 2)} L</b>
            <span className="dorong">
              {sisaAlokasi === 0 ? 'Pas'
                : sisaAlokasi > 0 ? `Sisa ${fmt(sisaAlokasi, 2)} L tetap di buffer`
                : `Lebih ${fmt(-sisaAlokasi, 2)} L`}
            </span>
          </div>
        )}

        {(jumlahTanpaSilo > 0 || jumlahTanpaVolume > 0) && (
          <div className="pesan pesan--info" role="status">
            Record tetap dapat disimpan. Yang masih kosong:
            {jumlahTanpaSilo > 0 ? ` silo tujuan pada ${jumlahTanpaSilo} record` : ''}
            {jumlahTanpaSilo > 0 && jumlahTanpaVolume > 0 ? ';' : ''}
            {jumlahTanpaVolume > 0 ? ` volume pada ${jumlahTanpaVolume} record` : ''}.
            {' '}Data tersebut akan muncul di Dashboard bagian Perlu dilengkapi.
          </div>
        )}

        <div className="baris">
          <button
            className="btn btn--utama dorong"
            disabled={simpan.isPending || sisaAlokasi < 0}
          >
            {simpan.isPending ? 'Menyimpan…' : `Simpan ${pecahanSiap.length} record`}
          </button>
        </div>
      </div>
    </form>
  );
}
