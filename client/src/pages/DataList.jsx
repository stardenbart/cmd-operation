import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmt, waktuSingkat, Field, Lencana, PesanGalat, PesanSukses, Kosong } from '../components/ui.jsx';
import DialogKoreksi from '../components/DialogKoreksi.jsx';
import DialogLengkapiPrepast from '../components/DialogLengkapiPrepast.jsx';
import DialogLengkapiReceiving from '../components/DialogLengkapiReceiving.jsx';
import DialogAjukanKoreksi from '../components/DialogAjukanKoreksi.jsx';
import { PilihBanyakCari } from '../components/pilih.jsx';

const MODUL = [
  { key: 'receiving', label: 'Penerimaan' },
  { key: 'prepast', label: 'Prepast' },
  { key: 'pengembalian', label: 'Pengembalian' },
  { key: 'transfer', label: 'Transfer' },
  { key: 'monitoring', label: 'Monitoring' },
];

const NADA_STATUS = {
  'Pending Approval': 'waspada',
  Approved: 'baik',
  Rejected: 'kritis',
  'Edit Requested': 'waspada',
  REVISED: 'netral',
  VOIDED: 'netral',
};

const filterKosong = {
  statusIds: [], cari: '', dariTanggal: '', sampaiTanggal: '', draftSaja: false,
  // Hanya bermakna untuk modul receiving - lihat kartu "Menunggu Berat Jenis".
  bjKosong: false,
  // Hanya bermakna untuk modul transfer - Pindah Silo yang melebihi batas
  // keras silo tujuan (BR-24 kini soft cap).
  lewatKapasitas: false,
  // Kosong berarti SELURUH silo. Lihat catatan pada PilihBanyakCari.
  siloIds: [],
  // Filter tank/MT tujuan (banyak sekaligus) - hanya bermakna untuk transfer.
  tankIds: [],
};

const LABEL_MODUL = Object.fromEntries(MODUL.map((m) => [m.key, m.label]));

/**
 * Rincian tiap turunan, sesuai jenis recordnya.
 *
 * Operator perlu tahu APA yang ikut terbatalkan sebelum menekannya: prepast ke
 * silo mana, transfer batch apa dan ke MT/silo tujuan mana. Tanpa ini dialognya
 * hanya deret kode - tidak cukup untuk memutuskan dengan yakin.
 */
function rincianSimpul(s) {
  if (s.modul === 'transfer') {
    const bagian = [];
    if (s.batch) bagian.push(`batch ${s.batch}`);
    if (s.lokasi) bagian.push(`ke ${s.lokasi}`);
    return bagian.join(' · ') || null;
  }
  // prepast / pengembalian: silo tujuannya.
  return s.lokasi ? `ke ${s.lokasi}` : null;
}

/** Pohon turunan berjenjang, dipakai dialog pembatalan (FR-17.1). */
function Pohon({ pohon, tingkat = 0 }) {
  return pohon.map((s) => {
    const rincian = rincianSimpul(s);
    return (
      <div key={`${s.modul}${s.id}`}>
        <div className="baris" style={{ paddingLeft: tingkat * 20, gap: 8, padding: '6px 0', flexWrap: 'wrap' }}>
          <span className="label" style={{ minWidth: 96 }}>{LABEL_MODUL[s.modul] ?? s.modul}</span>
          <span className="angka">{s.kode}</span>
          <span className="angka" style={{ color: 'var(--text-secondary)' }}>{fmt(s.volumeLtr)} L</span>
          {rincian && <span style={{ color: 'var(--text-secondary)' }}>{rincian}</span>}
          {s.statusApproval && (
            <Lencana nada={NADA_STATUS[s.statusApproval] ?? 'netral'}>{s.statusApproval}</Lencana>
          )}
          {s.anak.length === 0 && <Lencana nada="netral">Tanpa turunan</Lencana>}
        </div>
        <Pohon pohon={s.anak} tingkat={tingkat + 1} />
      </div>
    );
  });
}

export default function DataList() {
  const qc = useQueryClient();
  /*
   * Modul dan kata pencarian dapat datang dari URL.
   *
   * Dipakai pengingat "Perlu dilengkapi" di Home, yang mengarahkan ke baris
   * tertentu. Dibaca SEKALI sebagai nilai awal, bukan disinkronkan terus:
   * kalau ia terus mengikuti URL, filter yang diubah pengguna akan tertimpa
   * kembali oleh parameter lama setiap kali komponennya dirender.
   */
  const [paramUrl] = useSearchParams();
  const modulAwal = paramUrl.get('modul');
  const cariAwal = paramUrl.get('cari') ?? '';
  // Dituju kartu Dashboard "Menunggu Berat Jenis" - lihat RingkasanStok.
  const bjKosongAwal = paramUrl.get('bjKosong') === 'true';

  const [modul, setModul] = useState(
    ['receiving', 'prepast', 'pengembalian', 'transfer', 'monitoring'].includes(modulAwal)
      ? modulAwal
      : 'receiving',
  );
  const [filter, setFilter] = useState({
    ...filterKosong,
    ...(cariAwal ? { cari: cariAwal } : {}),
    ...(bjKosongAwal ? { bjKosong: true } : {}),
  });
  const [halaman, setHalaman] = useState(1);
  const [voidTarget, setVoidTarget] = useState(null);
  const [koreksiTarget, setKoreksiTarget] = useState(null);
  const [ajukanTarget, setAjukanTarget] = useState(null);
  const [alasan, setAlasan] = useState('');
  const [riwayatTarget, setRiwayatTarget] = useState(null);
  const [lihatTarget, setLihatTarget] = useState(null);
  const [sukses, setSukses] = useState(null);

  // Panel Lihat/Riwayat/Koreksi/Ajukan/Batalkan dirender di bawah tabel. Pada
  // tabel panjang, tombol aksi baris bawah membuka panel di luar layar -
  // operator harus scroll lagi. Begitu salah satu terbuka, bawa panelnya ke
  // tampilan. Semuanya saling meniadakan, jadi ref selalu menunjuk yang terbuka.
  const panelRef = useRef(null);
  useEffect(() => {
    if (lihatTarget || riwayatTarget || koreksiTarget || ajukanTarget || voidTarget) {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [lihatTarget, riwayatTarget, koreksiTarget, ajukanTarget, voidTarget]);

  const { data: lihat } = useQuery({
    queryKey: ['data', 'detail', lihatTarget?.modul, lihatTarget?.id],
    queryFn: () => api.get(`/data/${lihatTarget.modul}/${lihatTarget.id}/detail`),
    enabled: Boolean(lihatTarget),
  });

  const kueri = new URLSearchParams(
    Object.entries({ ...filter, halaman })
      .filter(([, v]) => v !== '' && v !== false)
      // Array kosong harus ikut dibuang, kalau tidak ia terkirim sebagai
      // `siloIds=` dan tersaring menjadi "tidak ada silo".
      .filter(([, v]) => !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]),
  ).toString();

  // Daftar silo untuk filternya. Dipakai bersama dashboard, jadi kuncinya sama
  // dan tidak menimbulkan permintaan tambahan.
  const { data: silos } = useQuery({
    queryKey: ['silos'],
    queryFn: () => api.get('/silos'),
  });

  // Daftar tank untuk filter MT tujuan - hanya diambil saat modul transfer.
  const { data: tanks } = useQuery({
    queryKey: ['transfer', 'tanks'],
    queryFn: () => api.get('/transfer/tanks'),
    enabled: modul === 'transfer',
  });

  const { data, isLoading } = useQuery({
    queryKey: ['data', modul, kueri],
    queryFn: () => api.get(`/data/${modul}?${kueri}`),
  });

  const { data: ringkasan } = useQuery({
    queryKey: ['data', modul, 'summary'],
    queryFn: () => api.get(`/data/${modul}/summary`),
  });

  // Pratinjau dampak dibaca lebih dulu: pembatalan berjenjang bersifat
  // merusak, jadi jumlah dan volumenya harus terlihat sebelum dikonfirmasi.
  const { data: pratinjau } = useQuery({
    queryKey: ['void', 'preview', voidTarget?.modul, voidTarget?.id],
    queryFn: () => api.get(`/void/${voidTarget.modul}/${voidTarget.id}/preview`),
    enabled: Boolean(voidTarget),
  });

  const { data: riwayat } = useQuery({
    queryKey: ['data', 'history', riwayatTarget?.modul, riwayatTarget?.id],
    queryFn: () => api.get(`/data/${riwayatTarget.modul}/${riwayatTarget.id}/history`),
    enabled: Boolean(riwayatTarget),
  });

  const segarkan = () => {
    qc.invalidateQueries({ queryKey: ['data'] });
    qc.invalidateQueries({ queryKey: ['silos'] });
    qc.invalidateQueries({ queryKey: ['approval'] });
  };

  const batalkan = useMutation({
    mutationFn: ({ berjenjang }) =>
      api.post(
        `/void/${voidTarget.modul}/${voidTarget.id}${berjenjang ? '/cascade' : ''}`,
        { alasan },
      ),
    onSuccess: (res) => {
      const d = res.data;
      setSukses(
        d.jumlah
          ? `${d.jumlah} record dibatalkan, total ${fmt(d.totalVolumeLtr)} L.`
          : `${d.kode} dibatalkan.`,
      );
      setVoidTarget(null);
      setAlasan('');
      segarkan();
    },
  });

  const gantiModul = (k) => {
    setModul(k);
    setFilter(filterKosong);
    setHalaman(1);
    setVoidTarget(null);
    setRiwayatTarget(null);
    setKoreksiTarget(null);
  };

  const setF = (k) => (e) => {
    setFilter({ ...filter, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
    setHalaman(1);
  };

  const punyaTurunan = (pratinjau?.jumlah ?? 1) > 1;

  return (
    <div className="tumpuk">
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Data</h2>
          {data && <span className="label">{fmt(data.total)} record</span>}
        </div>

        <PesanSukses>{sukses}</PesanSukses>

        <div className="baris">
          {MODUL.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`btn btn--kecil ${modul === m.key ? 'btn--utama' : 'btn--kedua'}`}
              onClick={() => gantiModul(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <Field label="Status">
            <PilihBanyakCari
              opsi={Object.entries(ringkasan?.perStatus ?? {}).map(([s, n]) => ({
                id: s,
                label: `${s} (${n})`,
              }))}
              nilai={filter.statusIds}
              onChange={(v) => { setFilter({ ...filter, statusIds: v }); setHalaman(1); }}
              placeholder="Cari Status"
              labelSemua="Semua Status"
              ariaLabel="Pilihan Status"
            />
          </Field>
          <Field label="Silo" bantuan="Boleh lebih dari satu, dapat dicari">
            <PilihBanyakCari
              opsi={(silos?.data ?? []).map((s) => ({ id: s.silo_id, label: s.silo_name }))}
              nilai={filter.siloIds}
              onChange={(v) => { setFilter({ ...filter, siloIds: v }); setHalaman(1); }}
              placeholder="Cari nama silo"
              labelSemua="Semua Silo"
              ariaLabel="Pilihan Silo"
            />
          </Field>
          {modul === 'transfer' && (
            <Field label="MT / Tank tujuan" bantuan="Boleh lebih dari satu, dapat dicari">
              <PilihBanyakCari
                opsi={(tanks?.data ?? []).map((t) => ({ id: t.id, label: t.tank_name }))}
                nilai={filter.tankIds}
                onChange={(v) => { setFilter({ ...filter, tankIds: v }); setHalaman(1); }}
                placeholder="Cari tank"
                labelSemua="Semua Tank"
                ariaLabel="Pilihan Tank"
              />
            </Field>
          )}
          <Field label="Cari kode atau supplier">
            <input value={filter.cari} onChange={setF('cari')} placeholder="RCV-2026" />
          </Field>
          <Field label="Dari tanggal">
            <input type="date" value={filter.dariTanggal} onChange={setF('dariTanggal')} />
          </Field>
          <Field label="Sampai tanggal">
            <input type="date" value={filter.sampaiTanggal} onChange={setF('sampaiTanggal')} />
          </Field>
        </div>

        {(modul === 'prepast' || modul === 'transfer' || modul === 'receiving') && (
          <label className="baris" style={{ gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 20, height: 20, minHeight: 20 }}
              checked={filter.draftSaja}
              onChange={setF('draftSaja')}
            />
            <span className="label">Hanya draft yang belum lengkap</span>
          </label>
        )}

        {modul === 'receiving' && (
          <label className="baris" style={{ gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 20, height: 20, minHeight: 20 }}
              checked={filter.bjKosong}
              onChange={setF('bjKosong')}
            />
            <span className="label">Hanya Berat Jenis kosong</span>
          </label>
        )}

        {(modul === 'transfer' || modul === 'prepast') && (
          <label className="baris" style={{ gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ width: 20, height: 20, minHeight: 20 }}
              checked={filter.lewatKapasitas}
              onChange={setF('lewatKapasitas')}
            />
            <span className="label">Hanya yang melebihi batas keras tujuan</span>
          </label>
        )}
      </div>

      {isLoading ? (
        <Kosong>Memuat data…</Kosong>
      ) : data.data.length === 0 ? (
        <div className="kartu"><Kosong>Tidak ada record yang cocok dengan filter ini.</Kosong></div>
      ) : (
        <div className="kartu tumpuk">
          <table className="tabel">
            <thead>
              <tr>
                <th>Kode</th>
                <th>Ringkasan</th>
                <th className="num">Volume</th>
                <th>Waktu</th>
                <th>Status</th>
                <th>Operator</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((b) => (
                <tr key={b.id}>
                  <td>
                    <span className="angka">{b.kode}</span>
                    {b.isDraft && <> <Lencana nada="waspada">Draft</Lencana></>}
                    {/* Sama seperti badge di kartu Silo Dashboard — kapasitas
                        nominal tidak lagi memblokir, hanya ditandai. */}
                    {b.melampauiKapasitas && <> <Lencana nada="waspada">Melampaui Nominal</Lencana></>}
                  </td>
                  <td>
                    {b.ringkasan}
                    {b.komentarPenolakan && (
                      <div className="bantuan" style={{ color: 'var(--status-critical)' }}>
                        Ditolak: {b.komentarPenolakan}
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {b.volumeLtr === null ? '-' : `${fmt(b.volumeLtr)} L`}
                    {b.sisaLtr !== null && b.sisaLtr !== b.volumeLtr && (
                      <div className="bantuan">sisa {fmt(b.sisaLtr)} L</div>
                    )}
                  </td>
                  <td>{waktuSingkat(b.waktu)}</td>
                  <td>
                    <Lencana nada={NADA_STATUS[b.statusApproval] ?? 'netral'}>
                      {b.statusApproval}
                    </Lencana>
                  </td>
                  <td>{b.operatorNama}</td>
                  <td className="tabel__aksi">
                    <button
                      type="button"
                      className="btn btn--kedua btn--kecil"
                      onClick={() => { setLihatTarget(b); setRiwayatTarget(null); setKoreksiTarget(null); setAjukanTarget(null); setVoidTarget(null); }}
                    >
                      Lihat
                    </button>
                    <button
                      type="button"
                      className="btn btn--hantu btn--kecil"
                      onClick={() => { setRiwayatTarget(b); setLihatTarget(null); setKoreksiTarget(null); setAjukanTarget(null); setVoidTarget(null); }}
                    >
                      Riwayat
                    </button>
                    {b.bolehSunting && (
                      <button
                        type="button"
                        className="btn btn--kedua btn--kecil"
                        onClick={() => { setKoreksiTarget(b); setVoidTarget(null); setAjukanTarget(null); setRiwayatTarget(null); setLihatTarget(null); }}
                      >
                        {b.bolehLengkapi ? 'Lengkapi' : 'Koreksi'}
                      </button>
                    )}
                    {b.bolehAjukanKoreksi && (
                      <button
                        type="button"
                        className="btn btn--kedua btn--kecil"
                        onClick={() => { setAjukanTarget(b); setKoreksiTarget(null); setVoidTarget(null); setRiwayatTarget(null); setLihatTarget(null); }}
                      >
                        Ajukan koreksi
                      </button>
                    )}
                    {b.bolehVoid && (
                      <button
                        type="button"
                        className="btn btn--bahaya btn--kecil"
                        onClick={() => { setVoidTarget(b); setKoreksiTarget(null); setAjukanTarget(null); setRiwayatTarget(null); setLihatTarget(null); setAlasan(''); batalkan.reset(); }}
                      >
                        Batalkan
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.totalHalaman > 1 && (
            <div className="baris">
              <span className="label">Halaman {data.halaman} dari {data.totalHalaman}</span>
              <button
                type="button" className="btn btn--kedua btn--kecil dorong"
                disabled={halaman <= 1} onClick={() => setHalaman(halaman - 1)}
              >
                Sebelumnya
              </button>
              <button
                type="button" className="btn btn--kedua btn--kecil"
                disabled={halaman >= data.totalHalaman} onClick={() => setHalaman(halaman + 1)}
              >
                Berikutnya
              </button>
            </div>
          )}
        </div>
      )}

      {lihatTarget && (
        <div className="kartu tumpuk" ref={panelRef}>
          <div className="kartu__kepala">
            <div>
              <span className="halaman-kepala__eyebrow">Detail {MODUL.find((m) => m.key === lihatTarget.modul)?.label ?? lihatTarget.modul}</span>
              <h2 style={{ fontSize: 18 }}>{lihatTarget.kode}</h2>
            </div>
            {lihat?.data && (
              <Lencana nada={NADA_STATUS[lihat.data.status] ?? 'netral'}>{lihat.data.status}</Lencana>
            )}
            <button
              type="button" className="btn btn--hantu btn--kecil dorong"
              onClick={() => setLihatTarget(null)}
            >
              Tutup
            </button>
          </div>

          {!lihat?.data ? <Kosong>Memuat detail…</Kosong> : (
            <>
              {lihat.data.komentarPenolakan && (
                <div className="pesan pesan--waspada">Ditolak: {lihat.data.komentarPenolakan}</div>
              )}
              <dl className="detail-grid">
                {lihat.data.field.map((f) => (
                  <div className="detail-grid__item" key={f.label}>
                    <dt>{f.label}</dt>
                    <dd>{f.tipe === 'waktu' ? waktuSingkat(f.nilai) : String(f.nilai)}</dd>
                  </div>
                ))}
                <div className="detail-grid__item">
                  <dt>Operator</dt><dd>{lihat.data.operatorNama}</dd>
                </div>
                <div className="detail-grid__item">
                  <dt>Dibuat</dt><dd>{waktuSingkat(lihat.data.dibuat)}</dd>
                </div>
                <div className="detail-grid__item">
                  <dt>Diperbarui</dt><dd>{waktuSingkat(lihat.data.diperbarui)}</dd>
                </div>
              </dl>

              {lihat.data.alokasi?.length > 0 && (
                <div className="tumpuk" style={{ gap: 8 }}>
                  <h3 style={{ fontSize: 14, margin: 0 }}>Alokasi FIFO</h3>
                  <div className="tabel-bungkus">
                    <table className="tabel">
                      <thead>
                        <tr><th>#</th><th>Batch</th><th>Supplier</th><th className="num">Diambil (L)</th></tr>
                      </thead>
                      <tbody>
                        {lihat.data.alokasi.map((a) => (
                          <tr key={a.prepastKode}>
                            <td className="angka">{a.urutanFifo}</td>
                            <td className="angka">{a.prepastKode}</td>
                            <td>{a.supplierName}</td>
                            <td className="num">{fmt(a.qtyAllocated)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {koreksiTarget && (
        <div ref={panelRef}>
          {koreksiTarget.bolehLengkapi && koreksiTarget.modul === 'receiving' ? (
            <DialogLengkapiReceiving
              target={koreksiTarget}
              onTutup={() => setKoreksiTarget(null)}
              onSukses={(pesan) => { setSukses(pesan); setKoreksiTarget(null); }}
            />
          ) : koreksiTarget.bolehLengkapi ? (
            <DialogLengkapiPrepast
              target={koreksiTarget}
              onTutup={() => setKoreksiTarget(null)}
              onSukses={(pesan) => { setSukses(pesan); setKoreksiTarget(null); }}
            />
          ) : (
            <DialogKoreksi
              target={koreksiTarget}
              onTutup={() => setKoreksiTarget(null)}
              onSukses={(pesan) => { setSukses(pesan); setKoreksiTarget(null); }}
            />
          )}
        </div>
      )}

      {ajukanTarget && (
        <div ref={panelRef}>
          <DialogAjukanKoreksi
            target={ajukanTarget}
            onTutup={() => setAjukanTarget(null)}
            onSukses={(pesan) => { setSukses(pesan); setAjukanTarget(null); }}
          />
        </div>
      )}

      {riwayatTarget && (
        <div className="kartu tumpuk" ref={panelRef}>
          <div className="kartu__kepala">
            <h2>Riwayat {riwayatTarget.kode}</h2>
            <button
              type="button" className="btn btn--hantu btn--kecil dorong"
              onClick={() => setRiwayatTarget(null)}
            >
              Tutup
            </button>
          </div>
          {riwayat?.data.length === 0 ? (
            <Kosong>Belum ada perubahan tercatat.</Kosong>
          ) : (
            <table className="tabel">
              <thead>
                <tr><th>Waktu</th><th>Tindakan</th><th>Oleh</th><th>Alasan</th></tr>
              </thead>
              <tbody>
                {riwayat?.data.map((r) => (
                  <tr key={r.id}>
                    <td>{waktuSingkat(r.created_at)}</td>
                    <td><span className="label">{r.action}</span></td>
                    <td>{r.actor_nama}</td>
                    <td>{r.reason ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {voidTarget && (
        <div className="kartu tumpuk" ref={panelRef}>
          <div className="kartu__kepala">
            <h2>Batalkan {voidTarget.kode}</h2>
            <button
              type="button" className="btn btn--hantu btn--kecil dorong"
              onClick={() => setVoidTarget(null)}
            >
              Batal
            </button>
          </div>

          <p className="bantuan" style={{ marginTop: -8 }}>{voidTarget.ringkasan}</p>

          <PesanGalat galat={batalkan.error} onTutup={() => batalkan.reset()} />

          {punyaTurunan && (
            <>
              <div className="pesan pesan--waspada">
                Record ini punya {pratinjau.jumlah - 1} turunan aktif. Membatalkannya
                sendiri tidak mungkin: turunannya harus dibatalkan lebih dulu.
                Pembatalan berjenjang akan membatalkan {pratinjau.jumlah} record
                sekaligus, total {fmt(pratinjau.totalVolumeLtr + (voidTarget.volumeLtr ?? 0))} L.
              </div>
              <h3>Urutan pembatalan, turunan paling ujung lebih dulu</h3>
              <div style={{ borderLeft: '2px solid var(--gridline)', paddingLeft: 12 }}>
                <Pohon pohon={pratinjau.pohon} />
              </div>
            </>
          )}

          <Field label="Alasan pembatalan" wajib bantuan="Tercatat di jejak audit">
            <textarea
              value={alasan} onChange={(e) => setAlasan(e.target.value)}
              placeholder="Salah silo tujuan, seluruh rantai dibatalkan" autoFocus
            />
          </Field>

          <div className="baris">
            {punyaTurunan ? (
              /* Operator pun boleh berjenjang, sepanjang SELURUH rantai masih
                 miliknya dan belum disetujui. Syarat itu hanya dapat diperiksa
                 server, jadi tombolnya ditampilkan dan penolakannya menyebut
                 record mana yang menghalangi. */
              <button
                type="button" className="btn btn--bahaya dorong"
                disabled={alasan.trim().length < 3 || batalkan.isPending}
                onClick={() => batalkan.mutate({ berjenjang: true })}
              >
                {batalkan.isPending
                  ? 'Membatalkan…'
                  : `Batalkan ${pratinjau.jumlah} record sekaligus`}
              </button>
            ) : (
              <button
                type="button" className="btn btn--bahaya dorong"
                disabled={alasan.trim().length < 3 || batalkan.isPending}
                onClick={() => batalkan.mutate({ berjenjang: false })}
              >
                {batalkan.isPending ? 'Membatalkan…' : 'Batalkan record ini'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
