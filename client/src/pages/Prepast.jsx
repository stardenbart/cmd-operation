import { Fragment, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import {
  fmt, waktuSingkat, Field, Lencana, PesanGalat, PesanSukses, Kosong,
} from '../components/ui.jsx';
import DialogLengkapiPrepast from '../components/DialogLengkapiPrepast.jsx';

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
  const [paramUrl] = useSearchParams();
  // Dituju tombol "Lengkapi" di Dashboard (BR-23) — dulu mengarahkan ke Data
  // List, operator masih harus cari barisnya lagi di sana. Sekarang mendarat
  // di sini dengan dialognya langsung terbuka.
  const lengkapiAwal = paramUrl.get('lengkapi');
  // Tab "Lengkapi" - kalau datang lewat link Dashboard, langsung buka di
  // tab itu (bukan di tab Prepast lalu harus pindah tab sendiri).
  const [tab, setTab] = useState(lengkapiAwal ? 'lengkapi' : 'prepast');
  const [lengkapiTarget, setLengkapiTarget] = useState(null);
  const [autoBukaSelesai, setAutoBukaSelesai] = useState(false);
  const panelLengkapiRef = useRef(null);
  const [batch, setBatch] = useState(null);
  const [pecahan, setPecahan] = useState([{ siloId: '', volumeLtr: '' }]);
  // Selesai disimpan sebagai TANGGAL dan JAM terpisah, bukan satu
  // datetime-local — supaya tanggalnya bisa disarankan dari Mulai sementara
  // jamnya benar-benar kosong (bukan dipalsukan 00.00), sesuatu yang tidak
  // bisa direpresentasikan oleh satu <input type="datetime-local"> saja.
  const [proses, setProses] = useState({
    prepastStart: '', prepastFinishTanggal: '', prepastFinishJam: '',
    flowrate: '', tempAfterHeater: '', tempOutput: '', remarks: '',
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

  // Ambang "masih terasa nyambung" untuk Proses Kontinu — bukan aturan
  // keras (kontinu() di backend tetap definisi resminya, cocok persis ke
  // menit), sekadar peringatan: mesin yang sudah nganggur lama sejak
  // record terakhir selesai kemungkinan bukan sambungan proses yang sama
  // lagi. Dicek berkala dari jam nyata (bukan sekali saat form dibuka),
  // sama seperti pola peringatan pergantian shift — supaya tidak macet di
  // tab yang dibiarkan terbuka lama.
  const AMBANG_KONTINU_MENIT = 45;
  const [sekarang, setSekarang] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setSekarang(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const gapKontinuMenit = sebelumnya
    ? (sekarang - new Date(sebelumnya.finish).getTime()) / 60_000
    : null;
  const lewatAmbangKontinu = gapKontinuMenit !== null && gapKontinuMenit > AMBANG_KONTINU_MENIT;

  // Prepast milik operator ini (atau siapa pun bila SPV) yang masih
  // menggantung — BR-23. Query key sama persis dengan PengingatGantung di
  // Dashboard, jadi kalau sudah ter-cache dari sana tidak ada request kedua.
  const { data: gantung } = useQuery({
    queryKey: ['data', 'gantung'],
    queryFn: () => api.get('/data/gantung'),
    refetchInterval: 60_000,
  });
  const perluDilengkapi = (gantung?.data ?? []).filter((d) => d.modul === 'prepast');

  // Datang dari tombol "Lengkapi" Dashboard (?lengkapi=<id>) — begitu daftar
  // di atas termuat, buka panelnya otomatis. Sekali saja: kalau id-nya tidak
  // ketemu (sudah dilengkapi orang lain, atau salah wewenang), tidak dicoba
  // lagi terus-menerus.
  useEffect(() => {
    if (autoBukaSelesai || !lengkapiAwal || !gantung) return;
    const target = perluDilengkapi.find((d) => String(d.id) === String(lengkapiAwal));
    if (target) setLengkapiTarget(target);
    setAutoBukaSelesai(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gantung, lengkapiAwal, autoBukaSelesai]);

  useEffect(() => {
    if (lengkapiTarget) panelLengkapiRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [lengkapiTarget]);

  const simpan = useMutation({
    mutationFn: (body) => api.post('/prepast', body),
    onSuccess: (res) => {
      const d = res.data;
      // BR-24 — kapasitas nominal tidak lagi memblokir Prepast (keputusan
      // operasional, sama seperti Pindah Silo): baris yang melampauinya tetap
      // tersimpan, ini murni pemberitahuan supaya operator tahu sebelum
      // meninggalkan form.
      const melampaui = d.melampauiNominal ?? [];
      setSukses(
        `${d.dibuat.length} record dibuat: ${d.dibuat.map((x) => x.kode).join(', ')}. ` +
        (d.sisaBatchIndukLtr === null
          ? 'Volume belum dapat dihitung — Berat Jenis Receiving induk belum diisi.'
          : `Total ${fmt(d.totalLtr)} L. Sisa batch induk ${fmt(d.sisaBatchIndukLtr)} L.`) +
        (d.gantung
          ? ` Perlu dilengkapi: ${d.fieldKosong.map((f) => f.label).join(', ')}.`
          : ' Data proses lengkap.') +
        (melampaui.length > 0
          ? ` Perhatian — ${melampaui.length} baris melebihi kapasitas nominal silo tujuan: ${
            melampaui.map((m) => `silo id ${m.siloId} (+${fmt(m.kelebihanLtr)} L${m.melebihiBatasKeras ? ', lewat batas keras' : ''})`).join('; ')
          }.`
          : ''),
      );
      setBatch(null);
      setPecahan([{ siloId: '', volumeLtr: '' }]);
      setProses({
        prepastStart: '', prepastFinishTanggal: '', prepastFinishJam: '',
        flowrate: '', tempAfterHeater: '', tempOutput: '', remarks: '',
      });
      setKontinu(false);
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['prepast'] });
      // BR-23 — record yang baru disimpan bisa langsung menggantung (mis.
      // Waktu Selesai belum diisi). Tanpa ini, tab "Lengkapi" di halaman
      // ini sendiri (dan kartu Perlu Dilengkapi di Dashboard) masih
      // menampilkan data lama sampai refetch berkala 60 detik berikutnya —
      // operator yang langsung pindah tab tidak melihat record barunya.
      qc.invalidateQueries({ queryKey: ['data'] });
    },
  });

  const setP = (k) => (e) => {
    const nilai = e.target.value;
    const perubahan = { [k]: nilai };
    // Tanggal Selesai ikut Mulai — sekadar memudahkan, bukan patokan nilai
    // aslinya. Jam Selesai TIDAK ikut sama sekali (tetap kosong, field
    // terpisah) — operator mengisi sendiri. Tidak menimpa tanggal Selesai
    // yang sudah pernah diisi sendiri oleh operator.
    if (k === 'prepastStart' && !proses.prepastFinishTanggal && nilai.length >= 10) {
      perubahan.prepastFinishTanggal = nilai.slice(0, 10);
    }
    setProses({ ...proses, ...perubahan });
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
    // Digabung hanya kalau DUA-DUANYA terisi — tanggal saja tanpa jam bukan
    // waktu yang bisa dikirim (persis alasan keduanya field terpisah).
    const prepastFinish = (proses.prepastFinishTanggal && proses.prepastFinishJam)
      ? `${proses.prepastFinishTanggal}T${proses.prepastFinishJam}`
      : '';
    let konfirmasiRollover = false;
    if (prepastFinish && proses.prepastStart
      && prepastFinish <= proses.prepastStart) {
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
    const { prepastFinishTanggal, prepastFinishJam, ...prosesTanpaFinish } = proses;
    simpan.mutate({
      receivingId: batch.id,
      pecahan: pecahanSiap,
      ...prosesTanpaFinish,
      ...(prepastFinish ? { prepastFinish } : {}),
      // BR-16 — Tanggal Selesai yang sempat diisi tapi Jam-nya belum. Tanpa
      // ini, tanggal itu hanya ada di layar dan hilang begitu record
      // tersimpan — lihat prepastFinishDraftTanggal di prepast.js.
      ...(!prepastFinish && prepastFinishTanggal ? { prepastFinishDraftTanggal: prepastFinishTanggal } : {}),
      konfirmasiRollover,
      konfirmasiOprp,
      kontinu,
      continuityPreviousId: kontinu ? sebelumnya?.id : undefined,
    });
  }

  if (isLoading) return <Kosong>Memuat antrean buffer…</Kosong>;

  const panelLengkapi = lengkapiTarget && (
    <div ref={panelLengkapiRef}>
      <DialogLengkapiPrepast
        target={lengkapiTarget}
        onTutup={() => setLengkapiTarget(null)}
        onSukses={(pesan) => { setSukses(pesan); setLengkapiTarget(null); }}
      />
    </div>
  );

  // Dua tab: "Prepast" (antrean buffer, alur biasa) dan "Lengkapi" (record
  // yang masih menggantung - BR-23). Terpisah dari alur utama supaya
  // keduanya tidak berebut baris di tabel yang sama.
  const tablist = (
    <div className="segmen" role="tablist" aria-label="Prepast">
      <button
        type="button" role="tab" aria-selected={tab === 'prepast'}
        className={`btn btn--kecil ${tab === 'prepast' ? 'btn--utama' : 'btn--kedua'}`}
        onClick={() => setTab('prepast')}
      >
        Prepast
      </button>
      <button
        type="button" role="tab" aria-selected={tab === 'lengkapi'}
        className={`btn btn--kecil ${tab === 'lengkapi' ? 'btn--utama' : 'btn--kedua'}`}
        onClick={() => setTab('lengkapi')}
      >
        Lengkapi{perluDilengkapi.length > 0 ? ` (${perluDilengkapi.length})` : ''}
      </button>
    </div>
  );

  if (tab === 'lengkapi') {
    return (
      <div className="tumpuk">
        {tablist}
        <div className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2>Perlu dilengkapi</h2>
            <span className="label">Record Prepast yang masih separuh — klik Lengkapi untuk mengisi</span>
          </div>
          {perluDilengkapi.length === 0 && <Kosong>Tidak ada yang perlu dilengkapi. Semua catatan sudah lengkap.</Kosong>}
          {perluDilengkapi.length > 0 && (
            <table className="tabel">
              <thead>
                <tr>
                  <th>Kode</th><th>Silo</th><th className="num">Volume (L)</th>
                  <th>Diinput oleh</th><th className="num">Menggantung</th><th />
                </tr>
              </thead>
              <tbody>
                {perluDilengkapi.map((d) => (
                  <tr key={d.id}>
                    <td className="angka">{d.kode}</td>
                    <td>
                      {d.tempat}
                      {d.fieldKosong?.length > 0 && (
                        <div className="bantuan">Kurang: {d.fieldKosong.map((f) => f.label).join(', ')}</div>
                      )}
                    </td>
                    <td className="num">{d.volumeLtr === null ? '—' : fmt(d.volumeLtr)}</td>
                    <td>{d.operatorNama}</td>
                    <td className="num">{d.usiaJam} jam</td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn--utama btn--kecil"
                        onClick={() => setLengkapiTarget(d)}
                        disabled={!d.bolehSayaLengkapi}
                        title={d.bolehSayaLengkapi
                          ? 'Buka untuk dilengkapi'
                          : 'Hanya yang menginputnya atau SPV yang dapat melengkapi'}
                      >
                        Lengkapi
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {panelLengkapi}
      </div>
    );
  }

  if (!batch) {
    return (
      <div className="tumpuk">
        {tablist}
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
      </div>
    );
  }

  return (
    <div className="tumpuk">
      {tablist}
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
            <div style={{ gridColumn: 'span 2' }}>
              <Field label="Selesai" bantuan="Tanggal ikut Mulai, jam diisi sendiri - atau kosongkan dulu, record menggantung sampai dilengkapi">
                <div className="baris" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="date"
                    value={proses.prepastFinishTanggal}
                    onChange={setP('prepastFinishTanggal')}
                    style={{ flex: 1, minWidth: 150 }}
                  />
                  <input
                    type="time"
                    value={proses.prepastFinishJam}
                    onChange={setP('prepastFinishJam')}
                    style={{ flex: 1, minWidth: 130 }}
                  />
                </div>
              </Field>
            </div>
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
                      // Cuma saran — bukan patokan. Nilai proses (Flowrate, Temp
                      // after heater, Temp output) langsung terisi dari record
                      // sebelumnya supaya tidak perlu ketik ulang bila memang
                      // sama, tapi tetap bebas diubah sebelum submit.
                      setProses((lama) => ({
                        ...lama,
                        prepastStart: saranStart,
                        // Tanggal Selesai ikut Mulai (jamnya tetap kosong) — sama
                        // seperti saat Mulai diketik manual. Jalur checkbox ini
                        // mengisi Mulai lewat cara berbeda dari pengetikan biasa,
                        // jadi aturannya perlu diulang di sini juga, bukan cuma
                        // di setP().
                        prepastFinishTanggal: (!lama.prepastFinishTanggal && saranStart?.length >= 10)
                          ? saranStart.slice(0, 10)
                          : lama.prepastFinishTanggal,
                        flowrate: sebelumnya.flowrate ?? lama.flowrate,
                        tempAfterHeater: sebelumnya.tempAfterHeater ?? lama.tempAfterHeater,
                        tempOutput: sebelumnya.tempOutput ?? lama.tempOutput,
                      }));
                    }
                  }}
                />
                Proses Kontinu — sarankan Waktu Mulai, Flowrate, Temp After Heater &amp; Temp Output dari record Prepast terakhir
              </label>
              {lewatAmbangKontinu && (
                <div className="pesan pesan--waspada">
                  Sudah {fmt(gapKontinuMenit, 0)} menit sejak {sebelumnya.kode} selesai — lebih dari
                  {' '}{AMBANG_KONTINU_MENIT} menit. Kemungkinan ini bukan sambungan proses yang sama lagi.
                  Tetap boleh ditandai Kontinu bila memang benar menyambung, tapi periksa dulu.
                </div>
              )}
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

          {pecahan.map((p, i) => {
            // Pratinjau kapasitas — sekadar peringatan, bukan penolakan (BR-24,
            // keputusan operasional sama seperti Pindah Silo). Dicari langsung
            // dari ctx.siloTujuan, bukan siloTersedia(i): silo yang sudah
            // dipilih baris ini disingkirkan dari daftar itu untuk baris LAIN.
            const siloPilihan = (ctx?.siloTujuan ?? [])
              .find((s) => String(s.silo_id) === String(p.siloId));
            const volumeDiketik = angka(p.volumeLtr);
            const pratinjauLewatKapasitas = (siloPilihan && volumeDiketik > 0
              && volumeDiketik > Number(siloPilihan.vol_tersedia_ltr))
              ? {
                sisaNominalLtr: Number(siloPilihan.vol_tersedia_ltr),
                batasKerasLtr: Number(siloPilihan.vol_tersedia_toleransi_ltr),
                melebihiBatasKeras: volumeDiketik > Number(siloPilihan.vol_tersedia_toleransi_ltr),
              }
              : null;

            return (
              <Fragment key={i}>
                <div className="pecahan-baris">
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

                {pratinjauLewatKapasitas && (
                  // Kapasitas nominal tidak lagi memblokir Prepast (keputusan
                  // operasional) — ini murni peringatan supaya operator sadar
                  // sebelum submit, bukan penolakan. Baris tetap dapat disimpan.
                  <div className="pesan pesan--waspada">
                    Volume {fmt(volumeDiketik)} L melebihi sisa nominal {siloPilihan.silo_name}
                    {' '}({fmt(pratinjauLewatKapasitas.sisaNominalLtr)} L).
                    {pratinjauLewatKapasitas.melebihiBatasKeras
                      ? ` Bahkan melewati batas keras (${fmt(pratinjauLewatKapasitas.batasKerasLtr)} L) — tetap dapat disimpan, tercatat sebagai pengecualian.`
                      : ' Masih dalam toleransi — akan tercatat sebagai pengecualian nominal.'}
                  </div>
                )}
              </Fragment>
            );
          })}

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
    </div>
  );
}
