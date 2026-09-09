import { Fragment, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, unduh } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fmt, Field, Lencana, PesanGalat, PesanSukses, Kosong } from '../components/ui.jsx';
import BerkasSiap from '../components/BerkasSiap.jsx';

/** Hari ini sebagai YYYY-MM-DD setempat, bukan lewat toISOString yang UTC. */
function hariIni() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function awalBulanIni() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), '01'].join('-');
}

const jam = (j) => (j ? `${String(j.jam).padStart(2, '0')}.${String(j.menit).padStart(2, '0')}` : '');

const angka = (v, desimal = 0) => (v === null || v === undefined ? '' : fmt(v, desimal));

const NADA_TEMUAN = { pemblokir: 'kritis', peringatan: 'waspada' };

/** Halaman 1 form: penerimaan dan prepasteurisasi. */
function Halaman1({ data }) {
  const kapasitas = data.kapasitas.barisHalaman1;
  const terbit = data.halaman1.slice(0, kapasitas);
  const terpotong = data.halaman1.slice(kapasitas);

  return (
    <div className="pratinjau">
      <table className="tabel tabel--form">
        <thead>
          <tr>
            <th rowSpan={2}>No</th>
            <th rowSpan={2}>Supplier FM</th>
            <th colSpan={2}>Waktu Penerimaan</th>
            <th colSpan={4}>Jumlah</th>
            <th colSpan={2}>Data Prepasteurisasi</th>
            <th rowSpan={2}>Flowrate</th>
            <th rowSpan={2}>Temp After Heater*</th>
            <th rowSpan={2}>Temp Output</th>
            <th rowSpan={2}>Silo</th>
            <th rowSpan={2}>Dikerjakan Oleh</th>
          </tr>
          <tr>
            <th>Mulai</th>
            <th>Selesai</th>
            <th>Kg</th>
            <th>BJ</th>
            <th>TS</th>
            <th>Lt</th>
            <th>Mulai</th>
            <th>Selesai</th>
          </tr>
        </thead>
        <tbody>
          {terbit.map((b) => (
            <tr key={b.receivingId} className={b.statusApproval !== 'Approved' ? 'baris--pending' : ''}>
              <td>{b.nomor}</td>
              <td>{b.supplier}</td>
              {/* Kolom "Mulai" memang kosong pada form: hanya ada satu waktu
                  penerimaan (WF-1), dan itu waktu selesainya. */}
              <td />
              <td className="num">{jam(b.terimaSelesai)}</td>
              <td className="num">{angka(b.qtyKg)}</td>
              <td className="num">{angka(b.beratJenis, 3)}</td>
              <td className="num">{angka(b.nilaiTs, 1)}</td>
              <td className="num">{angka(b.qtyLtr)}</td>
              <td className="num">{jam(b.prepastMulai)}</td>
              <td className="num">{jam(b.prepastSelesai)}</td>
              <td className="num">{angka(b.flowrate, 1)}</td>
              <td className="num">{angka(b.tempAfterHeater, 1)}</td>
              <td className="num">{angka(b.tempOutput, 1)}</td>
              <td>{b.silo}</td>
              <td>{b.operator}</td>
            </tr>
          ))}
          {/* Baris kosong ditampilkan supaya bentuk formnya terlihat utuh */}
          {Array.from({ length: Math.max(0, kapasitas - terbit.length) }, (_, i) => (
            <tr key={`kosong${i}`} className="baris--kosong">
              <td>{terbit.length + i + 1}</td>
              <td colSpan={14} />
            </tr>
          ))}
        </tbody>
      </table>

      <p className="bantuan">*) Setting Temp. : 90 C, Min Temp. : 81 C</p>

      {terpotong.length > 0 && (
        <div className="pesan pesan--galat">
          {terpotong.length} baris tidak muat di halaman ini dan tidak akan
          terbit: {terpotong.map((b) => b.kode).join(', ')}.
        </div>
      )}
    </div>
  );
}

/** Halaman 2 form: monitoring dan pemakaian. */
function Halaman2({ data }) {
  const { slotMonitoring, transferPerSilo } = data.kapasitas;
  const romawi = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

  return (
    <div className="pratinjau">
      <h3>Interval Pengecekan Suhu &amp; pH</h3>
      <table className="tabel tabel--form">
        <thead>
          <tr>
            <th rowSpan={2}>Interval</th>
            {data.halaman2.monitoring.map((s) => (
              <th key={s.siloKode} colSpan={3}>SILO No. {s.siloKode}</th>
            ))}
          </tr>
          <tr>
            {data.halaman2.monitoring.map((s) => (
              <Fragment key={s.siloKode}>
                <th>Jam</th>
                <th>Suhu</th>
                <th>pH</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: slotMonitoring }, (_, i) => (
            <tr key={i}>
              <td>4 jam {romawi[i]}</td>
              {data.halaman2.monitoring.map((s) => {
                const cek = s.slot[i];
                return (
                  <Fragment key={s.siloKode}>
                    <td className="num">{jam(cek?.jam)}</td>
                    <td className="num">{angka(cek?.suhu, 1)}</td>
                    <td className="num">{angka(cek?.ph, 2)}</td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
          <tr>
            <td>Nama Operator</td>
            {data.halaman2.monitoring.map((s) => (
              <td key={`${s.siloKode}op`} colSpan={3}>{s.operator ?? ''}</td>
            ))}
          </tr>
        </tbody>
      </table>

      <h3>Data Pemakaian Susu Segar</h3>
      <table className="tabel tabel--form">
        <thead>
          <tr>
            <th>Silo</th>
            <th>Jam</th>
            <th>Batch</th>
            <th className="num">Volume (lt)</th>
          </tr>
        </thead>
        <tbody>
          {data.halaman2.transfer.map((s) => {
            const terbit = s.slot.slice(0, transferPerSilo);
            const terpotong = s.slot.length - terbit.length;
            if (terbit.length === 0) {
              return (
                <tr key={s.siloKode} className="baris--kosong">
                  <td>Silo {s.siloKode}</td>
                  <td colSpan={3} />
                </tr>
              );
            }
            return terbit.map((t, i) => (
              <tr
                key={`${s.siloKode}${t.id}`}
                className={
                  t.penanda === 'KOSONG'
                    ? 'baris--penanda'
                    : t.statusApproval !== 'Approved' ? 'baris--pending' : ''
                }
              >
                {i === 0 && <td rowSpan={terbit.length}>Silo {s.siloKode}</td>}
                {/*
                  Penanda silo kosong tampil sebagai 0 / 0 / 0 seperti pada
                  form, disertai keterangan. Menampilkannya hanya sebagai
                  keterangan akan membuat pratinjau berbeda dari berkasnya;
                  menampilkan nolnya saja akan membuat pembaca menyangka itu
                  data yang salah.
                */}
                {t.penanda === 'KOSONG' ? (
                  <>
                    <td className="num">0</td>
                    <td>
                      0 <span className="bantuan">silo kosong setelah {t.setelahKode}</span>
                    </td>
                    <td className="num">0</td>
                  </>
                ) : (
                  <>
                    <td className="num">{jam(t.jam)}</td>
                    <td>{t.batch}</td>
                    <td className="num">
                      {angka(t.volume)}
                      {i === terbit.length - 1 && terpotong > 0 && (
                        <div className="bantuan" style={{ color: 'var(--status-critical)' }}>
                          {terpotong} transfer lain tidak muat
                        </div>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ));
          })}
        </tbody>
      </table>

      {(data.catatan.pindahSilo.length > 0 || data.catatan.pengembalian.length > 0) && (
        <>
          <h3>Catatan</h3>
          <p className="bantuan">
            Pindah silo dan susu kembali tidak masuk blok pemakaian, sebab
            keduanya bukan pemakaian produksi. Keduanya dicatat di sini.
          </p>
          <ul>
            {data.catatan.pindahSilo.map((t) => (
              <li key={t.kode}>
                {jam(t.jam)} pindah silo {fmt(t.volumeLtr)} L dari SILO{t.asal}
                {t.tujuan ? ` ke SILO${t.tujuan}` : ''}
              </li>
            ))}
            {data.catatan.pengembalian.map((p) => (
              <li key={p.kode}>
                {jam(p.jam)} susu kembali {fmt(p.volumeLtr)} L ke SILO{p.silo}
                {p.keteranganAsal ? ` (${p.keteranganAsal})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function KepalaExport() {
  return (
    <div className="kartu__kepala halaman-kepala">
      <div>
        <span className="halaman-kepala__eyebrow">Arsip Operasional</span>
        <h1>Export</h1>
      </div>
    </div>
  );
}

function PilihanExport({ nilai, onChange }) {
  const pilihan = [
    {
      key: 'gmp',
      judul: 'Form GMP',
      deskripsi: 'Dokumen resmi harian dengan tata letak form produksi.',
    },
    {
      key: 'data',
      judul: 'Data Tabel Raw',
      deskripsi: 'Workbook datar untuk filter, pivot, dan analisis lanjutan.',
    },
  ];

  return (
    <div className="export-pilihan" role="tablist" aria-label="Jenis Export">
      {pilihan.map((p) => (
        <button
          key={p.key}
          type="button"
          role="tab"
          aria-selected={nilai === p.key}
          className={`export-pilihan__item${nilai === p.key ? ' aktif' : ''}`}
          onClick={() => onChange(p.key)}
        >
          <span>{p.judul}</span>
          <small>{p.deskripsi}</small>
        </button>
      ))}
    </div>
  );
}

function DataTabelExport() {
  const { boleh } = useAuth();
  const [dari, setDari] = useState(awalBulanIni());
  const [sampai, setSampai] = useState(hariIni());
  const [hasil, setHasil] = useState(null);
  const bolehUnduh = boleh('export:jalankan');

  const unduhData = useMutation({
    mutationFn: () => unduh(`/export/download-table?dari=${dari}&sampai=${sampai}`),
    onSuccess: (berkas) => setHasil(berkas),
  });

  return (
    <div className="tumpuk">
      <div className="kartu__kepala">
        <h2>Data Tabel Raw</h2>
        <Lencana nada="netral">3 Sheet</Lencana>
      </div>

      <p className="bantuan halaman-deskripsi">
        Seluruh status record ikut diunduh. Jika satu Receiving dipecah menjadi
        beberapa Prepast, data Receiving diulang pada setiap baris agar setiap
        pecahan silo tetap dapat ditelusuri tanpa penggabungan nilai.
      </p>

      <BerkasSiap hasil={hasil} onTutup={() => setHasil(null)} />
      <PesanGalat galat={unduhData.error} onTutup={() => unduhData.reset()} />

      <div className="export-sheet-grid" aria-label="Isi Workbook">
        <div className="kartu export-sheet">
          <span className="export-sheet__nomor">01</span>
          <div><b>Receiving–Prepast</b><small>Data Receiving dan setiap pecahan Prepast dalam satu tabel.</small></div>
        </div>
        <div className="kartu export-sheet">
          <span className="export-sheet__nomor">02</span>
          <div><b>Transfer</b><small>Transfer produksi dan pindah silo beserta alokasi supplier.</small></div>
        </div>
        <div className="kartu export-sheet">
          <span className="export-sheet__nomor">03</span>
          <div><b>Monitoring</b><small>Data pH, suhu, volume, dan snapshot supplier per pengecekan.</small></div>
        </div>
      </div>

      <div className="kartu export-data-filter">
        <div className="form-grid">
          <Field label="Dari Tanggal" wajib>
            <input
              type="date" value={dari} max={sampai}
              onChange={(e) => {
                setDari(e.target.value);
                setHasil(null);
                unduhData.reset();
              }}
            />
          </Field>
          <Field label="Sampai Tanggal" wajib>
            <input
              type="date" value={sampai} min={dari}
              onChange={(e) => {
                setSampai(e.target.value);
                setHasil(null);
                unduhData.reset();
              }}
            />
          </Field>
        </div>
        <div className="baris kartu__aksi">
          <span className="bantuan">
            Berkas berbentuk .xlsx dengan filter kolom dan baris kepala yang dibekukan.
          </span>
          {bolehUnduh && (
            <button
              type="button"
              className="btn btn--utama dorong"
              disabled={!dari || !sampai || sampai < dari || unduhData.isPending}
              onClick={() => unduhData.mutate()}
            >
              {unduhData.isPending ? 'Menyiapkan…' : 'Unduh Data Tabel (.xlsx)'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Export() {
  const { boleh } = useAuth();
  const [jenisExport, setJenisExport] = useState('gmp');
  const [tanggal, setTanggal] = useState(hariIni());
  const [sampai, setSampai] = useState('');
  const [halaman, setHalaman] = useState(1);
  const [sukses, setSukses] = useState(null);

  const bolehUnduh = boleh('export:jalankan');

  const pratinjau = useQuery({
    queryKey: ['export-preview', tanggal],
    queryFn: () => api.get(`/export/preview?tanggal=${tanggal}`),
    enabled: Boolean(tanggal) && jenisExport === 'gmp',
  });

  const rentang = useQuery({
    queryKey: ['export-validate', tanggal, sampai],
    queryFn: () => api.get(`/export/validate?tanggal=${tanggal}&sampai=${sampai}`),
    enabled: Boolean(sampai) && jenisExport === 'gmp',
  });

  // Hasil unduhan disimpan apa adanya supaya tautan cadangannya dapat
  // ditampilkan; lihat BerkasSiap.jsx untuk alasannya.
  const turun = useMutation({
    mutationFn: (t) => unduh(`/export/download?tanggal=${t}`),
    onSuccess: (h) => setSukses(h),
  });

  const arsip = useMutation({
    mutationFn: ({ dari, sampai: akhir }) =>
      unduh(`/export/download-zip?tanggal=${dari}&sampai=${akhir}`),
    onSuccess: (h) => setSukses(h),
  });

  const data = pratinjau.data?.data;
  const validasi = pratinjau.data?.validasi;

  if (jenisExport === 'data') {
    return (
      <div className="tumpuk">
        <KepalaExport />
        <PilihanExport nilai={jenisExport} onChange={setJenisExport} />
        <DataTabelExport />
      </div>
    );
  }

  return (
    <div className="tumpuk">
      <KepalaExport />
      <PilihanExport nilai={jenisExport} onChange={setJenisExport} />

      <div className="kartu__kepala">
        <h2>Form GMP</h2>
        {data && <Lencana nada="netral">{data.dokumen.nomor} Rev {data.dokumen.revisi}</Lencana>}
      </div>

      <p className="bantuan">
        Pratinjau ini dibangun dari sumber yang sama dengan berkas xlsx-nya, jadi
        yang Anda lihat di sini adalah yang akan terbit. Tanggal patokannya
        waktu selesai penerimaan: batch yang selesai malam ini lalu diprepast
        besok pagi tetap terbit di form hari ini.
      </p>

      <BerkasSiap hasil={sukses} onTutup={() => setSukses(null)} />

      <div className="kartu">
        <div className="form-grid">
          <Field label="Tanggal form" wajib>
            <input
              type="date" value={tanggal}
              onChange={(e) => { setTanggal(e.target.value); setSukses(null); }}
            />
          </Field>
          <Field
            label="Sampai tanggal"
            bantuan="Kosongkan untuk satu hari. Diisi untuk memeriksa rentang lebih dulu."
          >
            <input
              type="date" value={sampai} min={tanggal}
              onChange={(e) => setSampai(e.target.value)}
            />
          </Field>
        </div>
      </div>

      <PesanGalat
        galat={pratinjau.error ?? turun.error ?? arsip.error}
        onTutup={() => { turun.reset(); arsip.reset(); }}
      />

      {rentang.data && (
        <div className="kartu">
          <div className="kartu__kepala">
            <h2 style={{ fontSize: 16 }}>Pemeriksaan rentang</h2>
            <span className="label">
              {rentang.data.ringkasan.jumlahBerkas} berkas dari{' '}
              {rentang.data.ringkasan.jumlahHari} hari
            </span>
            {bolehUnduh && (
              <button
                type="button"
                className="btn btn--utama btn--kecil dorong"
                disabled={rentang.data.ringkasan.jumlahBerkas === 0 || arsip.isPending}
                onClick={() => arsip.mutate({ dari: tanggal, sampai })}
              >
                {arsip.isPending
                  ? 'Menyiapkan arsip…'
                  : `Unduh ${rentang.data.ringkasan.jumlahBerkas} berkas sebagai ZIP`}
              </button>
            )}
          </div>
          {rentang.data.ringkasan.jumlahPemblokir > 0 && (
            <div className="pesan pesan--waspada">
              Hari yang punya temuan pemblokir dilewati di dalam arsip, dan
              alasannya tercatat di berkas <code>_indeks.csv</code>. Satu hari
              yang bermasalah tidak menghentikan sisanya.
            </div>
          )}
          <table className="tabel">
            <thead>
              <tr>
                <th>Tanggal</th>
                <th className="num">Baris</th>
                <th>Berkas</th>
                <th className="num">Pemblokir</th>
                <th className="num">Peringatan</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rentang.data.data.map((h) => (
                <tr key={h.tanggal}>
                  <td>{h.tanggal}</td>
                  <td className="num">{h.jumlahBaris}</td>
                  <td>{h.kosong ? <span className="bantuan">tidak terbit</span> : h.namaBerkas}</td>
                  <td className="num">
                    {h.jumlahPemblokir > 0
                      ? <Lencana nada="kritis">{h.jumlahPemblokir}</Lencana>
                      : '0'}
                  </td>
                  <td className="num">{h.jumlahPeringatan}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      type="button" className="btn btn--hantu btn--kecil"
                      onClick={() => { setTanggal(h.tanggal); setHalaman(1); }}
                    >
                      Lihat
                    </button>
                    {bolehUnduh && !h.kosong && h.jumlahPemblokir === 0 && (
                      <button
                        type="button" className="btn btn--kedua btn--kecil"
                        disabled={turun.isPending}
                        onClick={() => turun.mutate(h.tanggal)}
                      >
                        Unduh
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pratinjau.isLoading ? (
        <Kosong>Menyusun pratinjau…</Kosong>
      ) : !data ? null : (
        <>
          {validasi.temuan.length > 0 && (
            <div className="kartu">
              <div className="kartu__kepala">
                <h2 style={{ fontSize: 16 }}>Panel validasi</h2>
                {validasi.jumlahPemblokir > 0 && (
                  <Lencana nada="kritis">{validasi.jumlahPemblokir} pemblokir</Lencana>
                )}
                {validasi.jumlahPeringatan > 0 && (
                  <Lencana nada="waspada">{validasi.jumlahPeringatan} peringatan</Lencana>
                )}
              </div>
              <p className="bantuan" style={{ marginTop: -4 }}>
                Pemblokir menghentikan export. Peringatan tidak: menghentikan
                form harian karena satu record masih pending lebih merugikan
                daripada menerbitkannya.
              </p>
              <ul className="daftar-temuan">
                {validasi.temuan.map((t, i) => (
                  <li key={i}>
                    <Lencana nada={NADA_TEMUAN[t.jenis]}>{t.kode}</Lencana>{' '}
                    {t.pesan}
                    {t.baris ? <span className="bantuan"> (baris {t.baris})</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="kartu">
            <div className="kartu__kepala">
              <div className="baris" style={{ gap: 8 }}>
                <button
                  type="button"
                  className={`btn btn--kecil ${halaman === 1 ? 'btn--utama' : 'btn--kedua'}`}
                  onClick={() => setHalaman(1)}
                >
                  Halaman 1
                </button>
                <button
                  type="button"
                  className={`btn btn--kecil ${halaman === 2 ? 'btn--utama' : 'btn--kedua'}`}
                  onClick={() => setHalaman(2)}
                >
                  Halaman 2
                </button>
              </div>
              <span className="label dorong">{data.namaBerkas}</span>
              {bolehUnduh && (
                <button
                  type="button"
                  className="btn btn--utama btn--kecil"
                  disabled={data.kosong || validasi.adaPemblokir || turun.isPending}
                  onClick={() => turun.mutate(tanggal)}
                >
                  {turun.isPending ? 'Menyiapkan…' : 'Unduh xlsx'}
                </button>
              )}
            </div>

            <div className="kop-form">
              <div>
                <b>PT CISARUA MOUNTAIN DAIRY TBK</b><br />
                PLANT SENTUL 1
              </div>
              <div>
                {data.dokumen.judul}<br />
                <span className="bantuan">
                  {data.dokumen.nomor} · Rev {data.dokumen.revisi} · Berlaku{' '}
                  {data.dokumen.berlaku}
                </span>
              </div>
              <div>
                Hari / Tanggal: <b>{data.tanggal}</b><br />
                <span className="bantuan">Halaman {halaman} dari 2</span>
              </div>
            </div>

            {data.kosong ? (
              <Kosong>
                Tidak ada data pada tanggal ini, jadi tidak ada berkas yang terbit.
              </Kosong>
            ) : halaman === 1 ? (
              <Halaman1 data={data} />
            ) : (
              <Halaman2 data={data} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
