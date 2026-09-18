import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, unduh } from '../lib/api.js';
import { formatRentangWib, inputWibKeIso, tambahHariInputWib } from '../lib/waktu.js';
import { fmt, waktuSingkat, Field, Lencana, PesanGalat, Kosong } from '../components/ui.jsx';
import BerkasSiap from '../components/BerkasSiap.jsx';
import { PilihBanyakCari } from '../components/pilih.jsx';
import {
  Panel, Garis, GarisWaktu, Batang, BatangBertumpuk, Heatmap, TabelGrafik,
} from '../components/grafik.jsx';

const iso = (d) => [
  d.getFullYear(),
  String(d.getMonth() + 1).padStart(2, '0'),
  String(d.getDate()).padStart(2, '0'),
].join('-');

const geser = (hari) => {
  const d = new Date();
  d.setDate(d.getDate() - hari);
  return iso(d);
};

const awalBulan = () => {
  const d = new Date();
  return iso(new Date(d.getFullYear(), d.getMonth(), 1));
};
const isoWaktu = (d = new Date()) => {
  const lokal = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return lokal.toISOString().slice(0, 16);
};

/** FR-27.1.3 - rentang berlaku serentak ke seluruh panel. */
const PRESET = [
  { kunci: 'hari-ini', label: 'Hari ini', dari: () => iso(new Date()) },
  { kunci: '7hari', label: '7 hari', dari: () => geser(6) },
  { kunci: '30hari', label: '30 hari', dari: () => geser(29) },
  { kunci: 'bulan', label: 'Bulan berjalan', dari: awalBulan },
];

const jamMenit = (menit) => {
  if (menit === null || menit === undefined) return '-';
  const j = Math.floor(menit / 60);
  return j >= 24 ? `${Math.floor(j / 24)} hari ${j % 24} jam` : `${j} jam ${Math.round(menit % 60)} m`;
};

const kapitalAwal = (nilai) => {
  const teks = String(nilai || '');
  return teks ? `${teks.charAt(0).toUpperCase()}${teks.slice(1)}` : '';
};

/** Satu angka besar pada baris ringkasan - FR-27.2. */
function Statistik({ label, nilai, satuan, delta, bantuan, anak }) {
  return (
    <div className="statistik">
      <div className="label">{label}</div>
      <div className="angka-besar">
        {nilai}
        {satuan && <span style={{ fontSize: 14, marginLeft: 4 }}>{satuan}</span>}
      </div>
      {delta !== null && delta !== undefined && (
        <div className={`statistik__delta ${delta >= 0 ? 'naik' : 'turun'}`}>
          {delta >= 0 ? '▲' : '▼'} {fmt(Math.abs(delta), 1)}% dari periode sebelumnya
        </div>
      )}
      {bantuan && <div className="bantuan">{bantuan}</div>}
      {anak}
    </div>
  );
}

/** Sparkline kecil: bentuk tren, tanpa sumbu. */
function Sparkline({ data }) {
  if (data.length < 2) return null;
  const maks = Math.max(...data.map((d) => d.ltr), 1);
  const titik = data
    .map((d, i) => `${(i / (data.length - 1)) * 100},${24 - (d.ltr / maks) * 22}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 26" preserveAspectRatio="none" className="sparkline">
      <polyline points={titik} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * Panel perhatian - FR-27.3.
 *
 * Panel yang kosong ditampilkan sebagai keadaan bersih, BUKAN disembunyikan
 * (FR-27.3.8): ketiadaan peringatan adalah informasi, dan panel yang hilang
 * saat bersih membuat pembacanya tidak tahu apakah pemeriksaannya berjalan.
 */
function PanelPerhatian({ judul, jumlah, nada, kosongPesan, tautan, children }) {
  return (
    <div className="kartu perhatian">
      <div className="kartu__kepala">
        <h3 style={{ margin: 0, fontSize: 14 }}>{judul}</h3>
        {jumlah > 0
          ? <Lencana nada={nada}>{jumlah}</Lencana>
          : <Lencana nada="baik">Bersih</Lencana>}
        {tautan && jumlah > 0 && (
          <Link to={tautan} className="btn btn--hantu btn--kecil dorong">Buka</Link>
        )}
      </div>
      {jumlah === 0 ? <div className="bantuan">{kosongPesan}</div> : children}
    </div>
  );
}

const durasiJam = (menit) => {
  if (menit == null) return '-';
  const j = Math.floor(menit / 60);
  const m = Math.round(menit % 60);
  return j > 0 ? `${j}j ${m}m` : `${m}m`;
};

/** Mode dropdown Analitik (FR-33.1) - tambah opsi baru di sini saja. */
const MODE = [
  { kunci: 'ringkasan', label: 'Ringkasan & Tren' },
  { kunci: 'sesi', label: 'Sesi Prepast' },
];

/**
 * Mode "Sesi Prepast" - FR-33.3. Satu kartu per sesi (terbaru di atas), dengan
 * DUA tabel terpisah: IN (masuk ke silo) dan OUT (keluar dari silo).
 */
function SesiPrepast({ sesi }) {
  if (!sesi || sesi.length === 0) {
    return <Kosong>Tidak ada sesi prepast pada rentang &amp; silo ini.</Kosong>;
  }
  const urut = [...sesi].sort((a, b) => new Date(b.start) - new Date(a.start));

  // Ringkasan atas seluruh sesi yang tampil - murni dijumlahkan dari data
  // sesi yang sudah dimuat untuk kartu & tabel di bawah, tanpa permintaan
  // tambahan (angkanya sudah ada di s.jumlahRecord/s.volumeLtr/s.keluar).
  const berjalan = sesi.filter((s) => s.sedangBerjalan).length;
  const totalMasukLtr = sesi.reduce((total, s) => total + s.volumeLtr, 0);
  const totalRecordPrepast = sesi.reduce((total, s) => total + s.jumlahRecord, 0);
  const totalKeluar = sesi.flatMap((s) => s.keluar);
  const totalKeluarLtr = totalKeluar.reduce((total, o) => total + Number(o.volume), 0);

  return (
    <div className="tumpuk analitik-sesi">
      <div className="statistik-grid">
        <Statistik
          label="Sesi Prepast"
          nilai={fmt(sesi.length)}
          bantuan={berjalan > 0 ? `${berjalan} sedang berjalan` : 'Semua sudah selesai'}
        />
        <Statistik
          label="Record Prepast"
          nilai={fmt(totalMasukLtr)} satuan="L"
          bantuan={`${totalRecordPrepast} record masuk`}
        />
        <Statistik
          label="Record Transfer"
          nilai={fmt(totalKeluarLtr)} satuan="L"
          bantuan={`${totalKeluar.length} record keluar`}
        />
      </div>
      {urut.map((s) => (
        <div key={s.id} className="kartu tumpuk analitik-sesi__kartu">
          <div className="analitik-sesi__kepala">
            <h3 style={{ margin: 0, fontSize: 15 }}>{s.siloName}</h3>
            <span className="bantuan">
              {s.id} · {waktuSingkat(s.start)}–{s.finish ? waktuSingkat(s.finish) : '…'}
              {' · '}{fmt(s.volumeLtr)} L · {s.jumlahRecord} record
            </span>
            {s.sedangBerjalan && <Lencana nada="waspada">Sedang Berjalan</Lencana>}
          </div>
          <div className="analitik-sesi__grid">
            <div className="analitik-sesi__blok">
              <div className="label">Masuk ke {s.siloName}</div>
              <TabelGrafik
                kolom={[
                  { k: 'volume', label: 'Volume (L)', num: true },
                  { k: 'masuk', label: 'Masuk' },
                  { k: 'selesai', label: 'Selesai' },
                  { k: 'supplier', label: 'Supplier' },
                ]}
                baris={s.masuk.map((m) => ({
                  volume: m.volumeLtr,
                  masuk: waktuSingkat(m.jam),
                  selesai: m.selesai ? waktuSingkat(m.selesai) : '-',
                  supplier: m.supplier,
                }))}
              />
            </div>
            <div className="analitik-sesi__blok">
              <div className="label">Keluar dari {s.siloName}</div>
              {s.keluar.length === 0 ? (
                <div className="bantuan">Belum ada transfer keluar dari sesi ini.</div>
              ) : (
                <TabelGrafik
                  kolom={[
                    { k: 'volume', label: 'Volume (L)', num: true },
                    { k: 'standing', label: 'Standing' },
                    { k: 'ts', label: 'TS (%)' },
                    { k: 'jam', label: 'Jam' },
                    { k: 'kemana', label: 'Kemana?' },
                  ]}
                  baris={s.keluar.map((o) => ({
                    volume: o.volume,
                    standing: durasiJam(o.standingMenit),
                    ts: o.tsPersen != null ? fmt(o.tsPersen, 1) : '-',
                    jam: waktuSingkat(o.jam),
                    kemana: o.kemana ?? '-',
                  }))}
                />
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Analitik() {
  const [sp, setSp] = useSearchParams();
  const mode = sp.get('mode') === 'sesi' ? 'sesi' : 'ringkasan';
  const gantiMode = (m) => setSp((lama) => {
    const n = new URLSearchParams(lama);
    if (m === 'ringkasan') n.delete('mode'); else n.set('mode', m);
    return n;
  }, { replace: true });

  const [preset, setPreset] = useState(null);
  const [filterAktif, setFilterAktif] = useState(false);
  const [dari, setDari] = useState(`${iso(new Date())}T00:00`);
  const [sampai, setSampai] = useState(isoWaktu());
  const [filter, setFilter] = useState(null);
  const [versiFilter, setVersiFilter] = useState(0);
  const [siloIds, setSiloIds] = useState([]);
  const [sukses, setSukses] = useState(null);

  const pilihPreset = (p) => {
    const awal = `${p.dari()}T00:00`;
    const akhir = isoWaktu();
    setPreset(p.kunci);
    setFilterAktif(true);
    setDari(awal);
    setSampai(akhir);
    setFilter({ dari: awal, sampai: akhir });
    setVersiFilter((lama) => lama + 1);
  };

  const parameter = new URLSearchParams(filterAktif
    ? { dari: inputWibKeIso(filter.dari), sampai: inputWibKeIso(filter.sampai), mode: 'historis' }
    : { mode: 'realtime' });
  if (siloIds.length > 0) parameter.set('siloIds', siloIds.join(','));
  const kueri = parameter.toString();

  // FR-33.4: mode "sesi" memakai endpoint sesi; filternya sama persis.
  const endpoint = mode === 'sesi' ? '/analitik/sesi' : '/analitik';
  const { data, isLoading, error } = useQuery({
    queryKey: ['analitik', mode, kueri, versiFilter],
    queryFn: () => api.get(`${endpoint}?${kueri}`),
    placeholderData: (sebelumnya) => sebelumnya,
    refetchInterval: !filterAktif ? 30_000 : false,
  });

  const excel = useMutation({
    mutationFn: () => unduh(`/analitik/excel?${kueri}`),
    onSuccess: (h) => setSukses(h),
  });

  const g = data?.grafik;
  const p = data?.perhatian;
  const r = data?.ringkasan;

  return (
    <div className="tumpuk">
      <div className="kartu__kepala halaman-kepala">
        <div>
          <span className="halaman-kepala__eyebrow">Insight Operasional</span>
          <h1>Analitik</h1>
        </div>
        {data && (
          <span className="label">
            {formatRentangWib(data.rentang.dari, data.rentang.sampai)}
            {data.rentang.siloName ? ` · ${data.rentang.siloName}` : ''}
          </span>
        )}
      </div>

      <p className="bantuan halaman-deskripsi">
        Aplikasi lama hanya menampilkan keadaan saat ini. Halaman ini
        memperlihatkan tren dan penyimpangan lintas waktu dari data yang sudah
        tersimpan sejak awal. Susunannya mengikuti urutan mendesak: keadaan
        sekarang, lalu yang perlu ditindak, baru trennya.
      </p>

      <BerkasSiap hasil={sukses} onTutup={() => setSukses(null)} />
      <PesanGalat galat={error ?? excel.error} onTutup={() => excel.reset()} />

      {/* FR-33.1: pemilih mode. Mengubah mode TIDAK mereset filter. */}
      <div className="baris analitik-mode" role="tablist" aria-label="Mode Analitik">
        {MODE.map((m) => (
          <button
            key={m.kunci} type="button" role="tab" aria-selected={mode === m.kunci}
            className={`btn btn--kecil ${mode === m.kunci ? 'btn--utama' : 'btn--kedua'}`}
            onClick={() => gantiMode(m.kunci)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="kartu tumpuk analitik-filter">
        <div className="baris">
          <button
            type="button"
            className={`btn btn--kecil ${!filterAktif ? 'btn--utama' : 'btn--kedua'}`}
            onClick={() => { setFilterAktif(false); setFilter(null); setPreset(null); }}
          >
            Real-Time
          </button>
          {PRESET.map((x) => (
            <button
              key={x.kunci} type="button"
              className={`btn btn--kecil ${preset === x.kunci ? 'btn--utama' : 'btn--kedua'}`}
              onClick={() => pilihPreset(x)}
            >
              {x.label}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <Field label="Dari Waktu">
            <input
              type="datetime-local" value={dari}
              onChange={(e) => { setDari(e.target.value); setPreset(null); }}
            />
          </Field>
          <Field label="Sampai Waktu" bantuan="Maksimum 90 hari · WIB">
            <input
              type="datetime-local" value={sampai} min={dari}
              max={tambahHariInputWib(dari, 90)}
              onChange={(e) => { setSampai(e.target.value); setPreset(null); }}
            />
          </Field>
          <Field
            label="Silo"
            bantuan="Menyaring seluruh panel yang memang terikat silo"
          >
            <PilihBanyakCari
              opsi={(data?.siloTersedia ?? []).map((s) => ({ id: s.id, label: s.siloName }))}
              nilai={siloIds}
              onChange={setSiloIds}
              placeholder="Cari Nama Silo"
              labelSemua="Seluruh Silo"
              ariaLabel="Pilihan Silo Analitik"
            />
          </Field>
        </div>

        <div className="baris">
          {siloIds.length > 0 && (
            <span className="bantuan">
              Panel yang tidak terikat silo, seperti waktu tunggu approval,
              tetap menampilkan angka seluruh pabrik dan menyatakannya sendiri.
            </span>
          )}
          <button
            type="button"
            className="btn btn--kedua btn--kecil dorong"
            disabled={!dari || !sampai || sampai < dari || !inputWibKeIso(dari) || !inputWibKeIso(sampai)}
            onClick={() => {
              setFilter({ dari, sampai });
              setFilterAktif(true);
              setVersiFilter((lama) => lama + 1);
            }}
          >
            Terapkan Filter
          </button>
          <button
            type="button"
            className="btn btn--utama btn--kecil"
            disabled={excel.isPending || isLoading}
            onClick={() => excel.mutate()}
          >
            {excel.isPending ? 'Menyiapkan…' : 'Unduh Excel'}
          </button>
        </div>
      </div>

      {isLoading || !data ? (
        <Kosong>Menghitung…</Kosong>
      ) : mode === 'sesi' ? (
        <SesiPrepast sesi={data.sesi} />
      ) : (
        <>
          {/* ---- Keadaan sekarang ---- */}
          <div className="statistik-grid">
            <Statistik
              label={r.labelMasuk}
              nilai={fmt(r.penerimaan.ltr)} satuan="L"
              delta={r.penerimaan.deltaPersen}
              bantuan={`${r.penerimaan.jumlah} record`}
              anak={<Sparkline data={r.penerimaan.sparkline} />}
            />
            <Statistik
              label={r.labelKeluar}
              nilai={fmt(r.pemakaian.ltr)} satuan="L"
              delta={r.pemakaian.deltaPersen}
              bantuan={`${r.pemakaian.jumlah} record`}
            />
            <Statistik
              label="Tersimpan di silo"
              nilai={fmt(r.saldo.siloLtr)} satuan="L"
              bantuan={`Ditambah ${fmt(r.saldo.bufferLtr)} L di buffer`}
            />
            <Statistik
              label="Utilisasi kapasitas"
              nilai={fmt(r.utilisasi.persen, 1)} satuan="%"
              bantuan={`${fmt(r.utilisasi.terisiLtr)} dari ${fmt(r.utilisasi.kapasitasLtr)} L`}
            />
            <Statistik
              label="Rata-rata TS"
              nilai={r.mutu.rataTs === null ? '-' : fmt(r.mutu.rataTs, 2)} satuan="%"
              delta={r.mutu.deltaPersen}
              bantuan="Mutu susu masuk"
            />
          </div>

          {/* ---- Yang perlu ditindak ---- */}
          <div className="kartu__kepala"><h2 style={{ fontSize: 16 }}>Perlu Ditindak</h2></div>
          <div className="perhatian-grid">
            <PanelPerhatian
              judul="Silo Lewat Jadwal Cek" jumlah={p.lewatJadwal.length} nada="kritis"
              kosongPesan="Seluruh silo dicek sesuai intervalnya." tautan="/monitoring"
            >
              {p.lewatJadwal.map((s) => (
                <div key={s.siloId} className="baris baris--rapat">
                  <b>{s.siloName}</b>
                  <span className="bantuan">
                    interval {s.intervalJam} jam · terakhir {jamMenit(s.menitSejakCek)} lalu
                  </span>
                </div>
              ))}
            </PanelPerhatian>

            <PanelPerhatian
              judul="Penyimpangan OPRP" jumlah={p.oprp.length} nada="kritis"
              kosongPesan="Tidak ada Temp After Heater di bawah 81 C."
            >
              {p.oprp.slice(0, 6).map((o) => (
                <div key={o.id} className="baris baris--rapat">
                  <b>{o.kode}</b>
                  <span className="bantuan">
                    {o.siloName} · {fmt(o.tempAfterHeater, 1)} C (ambang {o.ambang}) ·{' '}
                    {waktuSingkat(o.waktu)}
                  </span>
                </div>
              ))}
            </PanelPerhatian>

            <PanelPerhatian
              judul="pH Di Luar Rentang" jumlah={p.ph.length} nada="waspada"
              kosongPesan="Seluruh pengecekan berada di rentang 6,0 sampai 7,0."
            >
              {p.ph.slice(0, 6).map((m) => (
                <div key={m.id} className="baris baris--rapat">
                  <b>{m.siloName}</b>
                  <span className="bantuan">
                    pH {fmt(m.ph, 2)} · {waktuSingkat(m.waktu)}
                  </span>
                </div>
              ))}
            </PanelPerhatian>

            <PanelPerhatian
              judul="Standing Time Terlama" jumlah={p.standingTime.length} nada="waspada"
              kosongPesan="Tidak ada silo berisi."
            >
              {p.standingTime.slice(0, 6).map((s) => (
                <div key={s.siloId} className="baris baris--rapat">
                  <b>{s.siloName}</b>
                  <span className="bantuan">
                    {jamMenit(s.menit)} · {fmt(s.volumeLtr)} L
                  </span>
                </div>
              ))}
            </PanelPerhatian>

            <PanelPerhatian
              judul="Draft Belum Lengkap" jumlah={p.draft.length} nada="waspada"
              kosongPesan="Tidak ada draft menggantung." tautan="/data"
            >
              {p.draft.slice(0, 6).map((d) => (
                <div key={`${d.modul}${d.id}`} className="baris baris--rapat">
                  <b>{d.kode}</b>
                  <span className="bantuan">{kapitalAwal(d.modul)} · Dibuat {waktuSingkat(d.dibuat)}</span>
                </div>
              ))}
            </PanelPerhatian>

            <PanelPerhatian
              judul="Menunggu Approval"
              jumlah={p.antrean.reduce((s, a) => s + a.jumlah, 0)} nada="waspada"
              kosongPesan="Antrean approval kosong." tautan="/approval"
            >
              {p.antrean.map((a) => (
                <div key={a.modul} className="baris baris--rapat">
                  <b>{kapitalAwal(a.modul)}</b>
                  <span className="bantuan">
                    {a.jumlah} Record · Tertua {fmt(a.usiaTertuaJam ?? 0)} jam
                  </span>
                </div>
              ))}
            </PanelPerhatian>
          </div>

          {/* ---- Tren ---- */}
          <div className="kartu__kepala"><h2 style={{ fontSize: 16 }}>Tren</h2></div>

          <Panel
            judul={g['neraca-harian'].judul} pertanyaan={g['neraca-harian'].pertanyaan}
            kosong={g['neraca-harian'].data.length === 0}
            anakGrafik={<Garis {...g['neraca-harian']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Tanggal' },
                  { k: 'masuk', label: 'Penerimaan (L)', num: true },
                  { k: 'keluar', label: 'Pemakaian (L)', num: true },
                ]}
                baris={g['neraca-harian'].data}
              />
            }
          />

          {/* Frekuensi: berapa KALI, bukan berapa liter. Panel lain di halaman
              ini seluruhnya mengukur volume, dan volume tidak menjawab beban
              kerja - dua puluh penerimaan kecil dan dua penerimaan besar dapat
              berjumlah liter yang sama. */}
          {/* Dijaga keberadaannya, bukan diasumsikan.
              Halaman ini membaca panel lewat kunci tetap, sehingga satu kunci
              yang belum dikenal server - misalnya karena API belum ikut
              dimuat ulang setelah panel baru ditambahkan - membuat SELURUH
              halaman Analitik gagal dirender, bukan hanya panel itu. */}
          {g['frekuensi-record'] && (
          <Panel
            judul={g['frekuensi-record'].judul}
            pertanyaan={g['frekuensi-record'].pertanyaan}
            kosong={g['frekuensi-record'].data.length === 0}
            anakGrafik={<BatangBertumpuk {...g['frekuensi-record']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Tanggal' },
                  { k: 'Penerimaan', label: 'Penerimaan', num: true },
                  { k: 'Transfer produksi', label: 'Transfer produksi', num: true },
                  { k: 'Pindah silo', label: 'Pindah silo', num: true },
                  { k: 'Prepast', label: 'Total Prepast', num: true },
                  { k: 'volumePrepastLtr', label: 'Volume Prepast (L)', num: true },
                  { k: 'total', label: 'Total', num: true },
                ]}
                baris={g['frekuensi-record'].data.map((d) => ({
                  ...d,
                  total: d.Penerimaan + d['Transfer produksi'] + d['Pindah silo'] + d.Prepast,
                }))}
              />
            }
          />
          )}

          {/* Detail sesi kini punya mode tersendiri: "Sesi Prepast" (FR-33). */}
          {g['frekuensi-record']?.sesiPrepast?.length > 0 && (
            <div className="bantuan" style={{ marginTop: -4 }}>
              Rincian tiap sesi (masuk/keluar per silo) ada di mode{' '}
              <button
                type="button" className="tautan-teks"
                onClick={() => gantiMode('sesi')}
              >
                Sesi Prepast
              </button>.
            </div>
          )}

          <Panel
            judul={g['pola-jam'].judul} pertanyaan={g['pola-jam'].pertanyaan}
            kosong={g['pola-jam'].data.length === 0}
            anakGrafik={<Heatmap {...g['pola-jam']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'jam', label: 'Jam', num: true },
                  { k: 'jumlah', label: 'Penerimaan', num: true },
                  { k: 'ltr', label: 'Volume (L)', num: true },
                ]}
                baris={g['pola-jam'].data}
              />
            }
          />

          <Panel
            judul={g['aktivitas-silo'].judul} pertanyaan={g['aktivitas-silo'].pertanyaan}
            kosong={g['aktivitas-silo'].data.length === 0}
            anakGrafik={<BatangBertumpuk {...g['aktivitas-silo']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Silo' },
                  { k: 'masuk', label: 'Prepast masuk (L)', num: true },
                  { k: 'keluar', label: 'Transfer keluar (L)', num: true },
                ]}
                baris={g['aktivitas-silo'].data}
              />
            }
          />

          {['suhu-silo', 'ph-silo', 'oprp', 'temp-output'].map((kunci) => (
            <Panel
              key={kunci}
              judul={g[kunci].judul} pertanyaan={g[kunci].pertanyaan}
              kosong={g[kunci].seri.length === 0}
              anakGrafik={<GarisWaktu {...g[kunci]} />}
              anakTabel={
                <TabelGrafik
                  kolom={[
                    { k: 'seri', label: 'Seri' },
                    { k: 'waktu', label: 'Waktu' },
                    { k: 'nilai', label: `Nilai (${g[kunci].satuan})`, num: true, desimal: 2 },
                  ]}
                  baris={g[kunci].seri.flatMap((s) =>
                    s.titik.map((t) => ({
                      seri: t.siloName ?? s.label,
                      waktu: waktuSingkat(t.waktu),
                      nilai: t.nilai,
                    })),
                  )}
                />
              }
            />
          ))}

          <Panel
            judul={g['ts-supplier'].judul} pertanyaan={g['ts-supplier'].pertanyaan}
            kosong={g['ts-supplier'].data.length === 0}
            anakGrafik={<Batang {...g['ts-supplier']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Supplier' },
                  { k: 'nilai', label: 'Rata-rata TS (%)', num: true, desimal: 2 },
                  { k: 'jumlah', label: 'Penerimaan', num: true },
                ]}
                baris={g['ts-supplier'].data}
              />
            }
          />

          <Panel
            judul={g['volume-supplier'].judul} pertanyaan={g['volume-supplier'].pertanyaan}
            kosong={g['volume-supplier'].data.length === 0}
            anakGrafik={<Batang {...g['volume-supplier']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Supplier' },
                  { k: 'nilai', label: 'Volume (L)', num: true },
                  { k: 'jumlah', label: 'Penerimaan', num: true },
                ]}
                baris={g['volume-supplier'].data}
              />
            }
          />

          <Panel
            judul={g['standing-time'].judul} pertanyaan={g['standing-time'].pertanyaan}
            kosong={g['standing-time'].data.length === 0}
            anakGrafik={<Batang {...g['standing-time']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Silo' },
                  { k: 'nilai', label: 'Standing time (jam)', num: true, desimal: 1 },
                  { k: 'volumeLtr', label: 'Volume (L)', num: true },
                ]}
                baris={g['standing-time'].data}
              />
            }
          />

          <Panel
            judul={g['tujuan-transfer'].judul} pertanyaan={g['tujuan-transfer'].pertanyaan}
            kosong={g['tujuan-transfer'].data.length === 0}
            anakGrafik={<BatangBertumpuk {...g['tujuan-transfer']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Tanggal' },
                  { k: 'CMD1', label: 'CMD1 (L)', num: true },
                  { k: 'CMD2', label: 'CMD2 (L)', num: true },
                  { k: 'Pindah silo', label: 'Pindah silo (L)', num: true },
                ]}
                baris={g['tujuan-transfer'].data}
              />
            }
          />

          <Panel
            judul={g['waktu-tunggu-approval'].judul}
            pertanyaan={g['waktu-tunggu-approval'].pertanyaan}
            kosong={g['waktu-tunggu-approval'].data.length === 0}
            anakGrafik={<Batang {...g['waktu-tunggu-approval']} />}
            anakTabel={
              <TabelGrafik
                kolom={[
                  { k: 'label', label: 'Modul' },
                  { k: 'nilai', label: 'Rata-rata tunggu (jam)', num: true, desimal: 1 },
                  { k: 'maksJam', label: 'Terlama (jam)', num: true },
                  { k: 'jumlah', label: 'Record', num: true },
                ]}
                baris={g['waktu-tunggu-approval'].data}
              />
            }
          />
        </>
      )}
    </div>
  );
}
