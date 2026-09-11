import { Fragment, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { isoKeInputWib } from '../lib/waktu.js';
import {
  fmt, Field, Lencana, PesanGalat, Kosong,
} from './ui.jsx';

const OPRP_MIN = 81;
const angka = (v) => parseFloat(String(v).replace(',', '.'));

export default function DialogLengkapiPrepast({ target, onTutup, onSukses }) {
  const qc = useQueryClient();
  const [nilai, setNilai] = useState({});
  // Silo tambahan — pecahan batch yang sama ke silo lain, ditemukan operator
  // belakangan saat melengkapi. Tiap baris jadi record Prepast baru sendiri
  // (lihat prepast.js — lengkapiDraft), bukan bagian dari record ini.
  const [pecahanTambahan, setPecahanTambahan] = useState([]);

  const { data, isLoading } = useQuery({
    queryKey: ['prepast', 'complete-context', target.id],
    queryFn: () => api.get(`/prepast/${target.id}/complete-context`),
  });
  // Preferensi tampilan GLOBAL — sama seperti di Prepast.jsx.
  const { data: pengaturan } = useQuery({
    queryKey: ['pengaturan'],
    queryFn: () => api.get('/pengaturan'),
  });
  const tampilkanSisaSilo = pengaturan?.data?.tampilkanSisaSilo ?? true;

  useEffect(() => {
    if (!data?.data) return;
    const d = data.data;
    setNilai({
      siloId: d.siloId ?? '',
      volumeLtr: d.volumeLtr ?? '',
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
      const tambahan = d.pecahanTambahan ?? [];
      // BR-24 — kapasitas nominal tidak lagi memblokir Prepast; baris yang
      // melampauinya tetap tersimpan, ini murni pemberitahuan (sama seperti
      // Pindah Silo).
      const lewatKapasitas = [
        ...(d.melampauiKapasitas ? [d.kode] : []),
        ...tambahan.filter((t) => t.melampauiKapasitas).map((t) => t.kode),
      ];
      const pesan = (d.isGantung
        ? `${d.kode} tersimpan, masih perlu: ${d.fieldKosong.map((f) => f.label).join(', ')}.`
        : `${d.kode} sudah lengkap dan masuk antrean approval.`)
        + (tambahan.length > 0
          ? ` ${tambahan.length} silo tambahan dibuat: ${tambahan.map((t) => t.kode).join(', ')}.`
          : '')
        + (lewatKapasitas.length > 0
          ? ` Perhatian — melebihi kapasitas nominal silo tujuan: ${lewatKapasitas.join(', ')}.`
          : '');
      qc.invalidateQueries({ queryKey: ['data'] });
      qc.invalidateQueries({ queryKey: ['prepast'] });
      qc.invalidateQueries({ queryKey: ['approval'] });
      qc.invalidateQueries({ queryKey: ['silos'] });
      onSukses(pesan);
    },
  });

  const set = (key) => (e) => setNilai((lama) => ({ ...lama, [key]: e.target.value }));
  const ubahTambahan = (i, k, v) =>
    setPecahanTambahan(pecahanTambahan.map((p, idx) => (idx === i ? { ...p, [k]: v } : p)));

  const sisaIndukLtr = data?.data?.sisaIndukLtr ?? null;
  // Volume record utama yang SUDAH tersimpan sebelumnya (null bila belum
  // pernah). Dipakai untuk menghitung DELTA, bukan nilai penuh — sisaIndukLtr
  // dari server sudah memotong angka lama ini, jadi yang "memperebutkan" sisa
  // di pratinjau ini cuma selisih antara yang sedang diketik dan yang sudah
  // tersimpan (0 kalau tidak diubah sama sekali).
  const volumeAsliLtr = data?.data?.volumeLtr != null ? Number(data.data.volumeLtr) : null;
  const volumeUtamaDiketik = volumeAsliLtr != null
    ? (angka(nilai.volumeLtr) || 0) - volumeAsliLtr
    : (angka(nilai.volumeLtr) || 0);
  const totalTambahan = pecahanTambahan.reduce((s, p) => s + (angka(p.volumeLtr) || 0), 0);
  const totalDialokasikan = volumeUtamaDiketik + totalTambahan;
  const sisaAlokasi = sisaIndukLtr === null ? null
    : Math.round((sisaIndukLtr - totalDialokasikan) * 100) / 100;

  // Silo yang sudah dipakai (record utama maupun baris tambahan lain) tidak
  // muncul lagi di baris berikutnya — sama seperti form Prepast baru (FR-29.5).
  const siloTersedia = (idx) => {
    const dipakai = new Set([
      nilai.siloId,
      ...pecahanTambahan.filter((_, i) => i !== idx).map((p) => p.siloId),
    ].filter((v) => v !== '' && v != null).map(String));
    return (data?.data?.siloTujuan ?? []).filter((s) => !dipakai.has(String(s.silo_id)));
  };

  // Pratinjau kapasitas — sekadar peringatan, bukan penolakan (BR-24,
  // keputusan operasional sama seperti Pindah Silo). Dipakai untuk baris
  // utama maupun tiap baris silo tambahan.
  const pratinjauKapasitas = (siloId, volumeLtr) => {
    const silo = (data?.data?.siloTujuan ?? []).find((s) => String(s.silo_id) === String(siloId));
    const volume = angka(volumeLtr);
    if (!silo || !(volume > 0) || volume <= Number(silo.vol_tersedia_ltr)) return null;
    return {
      volumeLtr: volume,
      siloName: silo.silo_name,
      sisaNominalLtr: Number(silo.vol_tersedia_ltr),
      batasKerasLtr: Number(silo.vol_tersedia_toleransi_ltr),
      melebihiBatasKeras: volume > Number(silo.vol_tersedia_toleransi_ltr),
    };
  };

  const pesanPratinjau = (p) => (
    <div className="pesan pesan--waspada">
      Volume {fmt(p.volumeLtr)} L melebihi sisa nominal {p.siloName} ({fmt(p.sisaNominalLtr)} L).
      {p.melebihiBatasKeras
        ? ` Bahkan melewati batas keras (${fmt(p.batasKerasLtr)} L) — tetap dapat disimpan, tercatat sebagai pengecualian.`
        : ' Masih dalam toleransi — akan tercatat sebagai pengecualian nominal.'}
    </div>
  );

  function kirim() {
    const body = {};
    for (const [key, value] of Object.entries(nilai)) {
      if (value !== '') body[key] = value;
    }

    // Baris kosong sama sekali (belum diisi apa-apa) tidak dikirim — cuma
    // artefak UI dari "Tambah silo" yang belum sempat diisi.
    const tambahanSiap = pecahanTambahan
      .filter((p) => p.siloId !== '' || p.volumeLtr !== '')
      .map((p) => ({
        ...(p.siloId !== '' ? { siloId: Number(p.siloId) } : {}),
        ...(p.volumeLtr !== '' ? { volumeLtr: p.volumeLtr } : {}),
      }));
    if (tambahanSiap.length > 0) body.pecahanTambahan = tambahanSiap;

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
  // Berlaku juga saat Volume sudah pernah tersimpan — sekarang boleh diedit
  // ulang, jadi pratinjau kapasitasnya tetap relevan untuk nilai barunya.
  const pratinjauUtama = !isLoading ? pratinjauKapasitas(nilai.siloId, nilai.volumeLtr) : null;

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

      {data?.data?.bjIndukBelumDiisi && (
        <div className="pesan pesan--info">
          Menunggu Berat Jenis Receiving {data.data.indukKode} dilengkapi — Volume belum
          dapat diisi sampai saat itu.
        </div>
      )}

      <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />

      {isLoading ? <Kosong>Memuat nilai Prepast…</Kosong> : (
        <div className="form-grid">
          <Field label="Silo tujuan" bantuan="Boleh tetap kosong; record masih masuk Perlu dilengkapi">
            <select
              value={nilai.siloId ?? ''}
              onChange={set('siloId')}
              disabled={data?.data?.siloId != null}
            >
              <option value="">Pilih silo</option>
              {(data?.data?.siloTujuan ?? []).map((s) => (
                <option key={s.silo_id} value={s.silo_id}>
                  {s.silo_name}
                  {tampilkanSisaSilo ? ` · sisa ${Number(s.vol_tersedia_ltr).toLocaleString('id-ID')} L` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Volume (L)"
            bantuan={data?.data?.bjIndukBelumDiisi
              ? `Menunggu Berat Jenis Receiving ${data.data.indukKode}`
              : data?.data?.volumeLtr != null
                ? 'Sudah tersimpan — boleh diubah selama record masih Gantung/Pending'
                : 'Boleh tetap kosong; record masih masuk Perlu dilengkapi'}
          >
            <input
              className="angka-input"
              inputMode="decimal"
              value={nilai.volumeLtr ?? ''}
              onChange={set('volumeLtr')}
              // Silo tetap terkunci begitu tersimpan (beda tangki, beda anchor
              // standing time) — tapi Volume boleh diganti selama Berat Jenis
              // induknya sudah diketahui, selama record masih Gantung/Pending
              // (dijamin server, bukan di sini).
              disabled={data?.data?.bjIndukBelumDiisi}
            />
          </Field>
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

      {pratinjauUtama && pesanPratinjau(pratinjauUtama)}

      {/* Silo tambahan TIDAK digerbang oleh sisaIndukLtr saat ini — itu
          angka STATIS dari server, sedangkan Volume record utama sekarang
          boleh DITURUNKAN di form ini juga, yang baru membebaskan ruang
          setelah disimpan. Kalau digerbang begitu, kasus paling umum justru
          hilang: batch yang sudah habis teralokasi ke SATU silo (sisaIndukLtr
          = 0) tapi Volume-nya mau dikurangi supaya sisanya dipecah ke silo
          lain — "Sisakan ke baris akhir" & ringkasan Teralokasi di bawah
          sudah menghitung ruang yang SUNGGUH tersedia secara live (termasuk
          pengurangan yang sedang diketik), jadi cukup Berat Jenis induk yang
          jadi syarat tampil. */}
      {!isLoading && !data?.data?.bjIndukBelumDiisi && (
        <div className="tumpuk" style={{ gap: 10 }}>
          <div className="kartu__kepala">
            <h3 style={{ fontSize: 14, margin: 0 }}>Silo tambahan</h3>
            <span className="label">Pecahan batch yang sama ke silo lain</span>
          </div>

          {pecahanTambahan.map((p, i) => {
            const pratinjauTambahan = pratinjauKapasitas(p.siloId, p.volumeLtr);
            return (
              <Fragment key={i}>
                <div className="pecahan-baris">
                  <Field label={`Silo tambahan ${i + 1}`} bantuan="Boleh dikosongkan dulu—record baru masuk Perlu dilengkapi">
                    <select value={p.siloId} onChange={(e) => ubahTambahan(i, 'siloId', e.target.value)}>
                      <option value="">Pilih silo</option>
                      {siloTersedia(i).map((s) => (
                        <option key={s.silo_id} value={s.silo_id}>
                          {s.silo_name}{tampilkanSisaSilo ? ` · sisa ${fmt(s.vol_tersedia_ltr)} L` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Volume (L)" bantuan="Boleh dikosongkan dulu—record baru masuk Perlu dilengkapi">
                    <input
                      className="angka-input"
                      inputMode="decimal"
                      value={p.volumeLtr}
                      onChange={(e) => ubahTambahan(i, 'volumeLtr', e.target.value)}
                    />
                  </Field>
                  <div className="field">
                    <span className="label">&nbsp;</span>
                    <button
                      type="button"
                      className="btn btn--bahaya btn--kecil"
                      onClick={() => setPecahanTambahan(pecahanTambahan.filter((_, idx) => idx !== i))}
                      aria-label={`Hapus silo tambahan ${i + 1}`}
                    >
                      Hapus
                    </button>
                  </div>
                </div>
                {pratinjauTambahan && pesanPratinjau(pratinjauTambahan)}
              </Fragment>
            );
          })}

          <div className="baris">
            <button
              type="button"
              className="btn btn--kedua btn--kecil"
              onClick={() => setPecahanTambahan([...pecahanTambahan, { siloId: '', volumeLtr: '' }])}
            >
              Tambah silo
            </button>
            <button
              type="button"
              className="btn btn--kedua btn--kecil"
              disabled={pecahanTambahan.length === 0 || sisaIndukLtr === null || sisaAlokasi <= 0}
              onClick={() => {
                const i = pecahanTambahan.length - 1;
                const lain = pecahanTambahan.reduce(
                  (s, p, idx) => (idx === i ? s : s + (angka(p.volumeLtr) || 0)), 0,
                );
                ubahTambahan(i, 'volumeLtr', String(
                  Math.round((sisaIndukLtr - volumeUtamaDiketik - lain) * 100) / 100,
                ));
              }}
            >
              Sisakan ke baris akhir
            </button>
          </div>

          {sisaIndukLtr !== null && (
            <div className={`pecahan-total ${sisaAlokasi === 0 ? 'pecahan-total--pas' : sisaAlokasi < 0 ? 'pecahan-total--lebih' : ''}`}>
              <span className="label">Teralokasi</span>
              <b>{fmt(totalDialokasikan, 2)} / {fmt(sisaIndukLtr, 2)} L</b>
              <span className="dorong">
                {sisaAlokasi === 0 ? 'Pas'
                  : sisaAlokasi > 0 ? `Sisa ${fmt(sisaAlokasi, 2)} L tetap di buffer`
                  : `Lebih ${fmt(-sisaAlokasi, 2)} L`}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="baris">
        <Lencana nada="waspada">Gantung</Lencana>
        <button
          type="button"
          className="btn btn--utama dorong"
          disabled={simpan.isPending || isLoading || !nilai.prepastStart || (sisaAlokasi !== null && sisaAlokasi < 0)}
          onClick={kirim}
        >
          {simpan.isPending ? 'Menyimpan…' : 'Simpan kelengkapan'}
        </button>
      </div>
    </div>
  );
}
