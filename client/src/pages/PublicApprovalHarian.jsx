import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Kosong, Lencana } from '../components/ui.jsx';

/**
 * Halaman PUBLIK "Diperiksa Oleh" - dituju QR pada sel A46 Halaman 2 form
 * GMP (services/approvalShare.js di backend, fungsi *Harian).
 *
 * Berbasis TANGGAL, menampilkan RINGKASAN (bukan jejak audit mentah) - satu
 * tanda tangan "Diperiksa Oleh" di form mewakili SELURUH approval SPV hari
 * itu: Receiving & Prepast (Halaman 1) plus Monitoring & Transfer
 * (Halaman 2), bisa puluhan record. (Kolom Paraf Halaman 1 dulu QR serupa
 * per-Receiving; sekarang tanda tangan digital, lihat DialogTandaTangan.jsx
 * - halaman publik untuknya sudah dihapus. Approval SPV atas Receiving itu
 * sendiri beda hal dari paraf operatornya, dan tetap tercakup di sini.)
 */
async function ambilRiwayat(tanggal, token) {
  const res = await fetch(`/api/v1/public/approval-harian/${tanggal}/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const badan = await res.json().catch(() => ({}));
    throw new Error(badan?.error?.message || badan?.message || 'Tautan tidak berlaku.');
  }
  return (await res.json()).data;
}

const NADA_STATUS = {
  Approved: 'baik',
  'Pending Approval': 'waspada',
};

const waktuId = (iso) => (iso
  ? new Date(iso).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  : '');

const angkaId = (n) => Number(n ?? 0).toLocaleString('id-ID');

/** Warna aksen per jenis record - dipakai garis kiri kartu & label badge. */
const WARNA_JENIS = {
  Receiving: 'var(--series-1)',
  Prepast: 'var(--series-3)',
  Monitoring: 'var(--warna-monitoring)',
  Transfer: 'var(--series-2)',
};

const TAB_JENIS = ['Semua', 'Receiving', 'Prepast', 'Monitoring', 'Transfer'];

/** Fakta ringkas sebagai potongan kecil ("chip"), bukan satu kalimat panjang
 * bertitik - jauh lebih mudah dipindai mata, terutama di layar HP. */
function Fakta({ list, catatan }) {
  return (
    <div className="tumpuk" style={{ gap: 4 }}>
      <div className="approval-item__fakta">
        {list.filter(Boolean).map((f, i) => <span key={i} className="fakta">{f}</span>)}
      </div>
      {catatan && <p className="approval-item__catatan">{catatan}</p>}
    </div>
  );
}

/** Detail domain per jenis record - beda isi antar Receiving/Prepast/Monitoring/Transfer. */
function DetailItem({ it }) {
  if (it.jenis === 'Receiving') {
    const { supplier, qtyKg, beratJenis, qtyLtr, nilaiTs } = it.detail;
    return (
      <Fakta list={[supplier, `${angkaId(qtyKg)} Kg`, `BJ ${beratJenis}`, `${angkaId(qtyLtr)} L`, `TS ${nilaiTs}%`]} />
    );
  }
  if (it.jenis === 'Prepast') {
    const {
      jenisBatch, supplier, volume, flowrate, tempAfterHeater, tempOutput, nilaiTs, receivingKode,
    } = it.detail;
    return (
      <Fakta
        list={[
          jenisBatch, supplier, `${angkaId(volume)} L`, `Flow ${flowrate}`,
          `${tempAfterHeater}°C → ${tempOutput}°C`, `TS ${nilaiTs}%`,
        ]}
        catatan={receivingKode ? `Dari ${receivingKode}` : null}
      />
    );
  }
  if (it.jenis === 'Monitoring') {
    const { ph, suhu, volume, supplier } = it.detail;
    return (
      <Fakta
        list={[`pH ${ph}`, `${suhu}°C`, `${angkaId(volume)} L`]}
        catatan={supplier.length > 0 ? supplier.map((s) => `${s.nama} (${angkaId(s.alokasiLiter)} L)`).join(', ') : null}
      />
    );
  }
  const { tankTujuan, batch, volume, jenis: jenisTransfer, caraPengisian, baris } = it.detail;
  return (
    <Fakta
      list={[jenisTransfer, `Tank ${tankTujuan}`, `Batch ${batch}`, `${angkaId(volume)} L`]}
      catatan={caraPengisian === 'Batch bersama'
        ? `Gabungan: ${baris.map((b) => `${b.siloAsal} (${angkaId(b.volume)} L)`).join(', ')}`
        : null}
    />
  );
}

const tanggalId = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', {
  weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
});

export default function PublicApprovalHarian({ tanggal, token }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['publik-approval-harian', tanggal, token],
    queryFn: () => ambilRiwayat(tanggal, token),
    enabled: Boolean(tanggal && token),
  });
  const [terbuka, setTerbuka] = useState(() => new Set());
  const toggle = (nama) => setTerbuka((s) => {
    const baru = new Set(s);
    if (baru.has(nama)) baru.delete(nama); else baru.add(nama);
    return baru;
  });
  const [jenisAktif, setJenisAktif] = useState('Semua');

  const konten = () => {
    if (!tanggal || !token || error) {
      return (
        <div className="kartu">
          <Kosong>Tautan tidak berlaku. Pindai ulang QR pada form aslinya.</Kosong>
        </div>
      );
    }
    if (isLoading || !data) return <Kosong>Memuat riwayat…</Kosong>;

    const belumDisetujui = data.riwayat.filter((r) => !r.diperiksaOleh);
    const cocok = (jenis) => jenisAktif === 'Semua' || jenis === jenisAktif;

    // Jumlah per jenis untuk badge tab - dari SELURUH riwayat (disetujui +
    // menunggu), bukan cuma yang tampil di kartu Approval, supaya angkanya
    // konsisten dipakai dua-duanya (Approval & Belum Disetujui).
    const jumlahPerJenis = data.riwayat.reduce((peta, r) => {
      peta[r.jenis] = (peta[r.jenis] ?? 0) + 1;
      return peta;
    }, {});

    const breakdownTersaring = data.breakdownApproval
      .map((a) => ({ ...a, item: a.item.filter((it) => cocok(it.jenis)) }))
      .filter((a) => a.item.length > 0);
    const belumDisetujuiTersaring = belumDisetujui.filter((r) => cocok(r.jenis));

    const tabBar = (
      <div className="segmen" role="tablist" aria-label="Jenis record" style={{ flexWrap: 'wrap' }}>
        {TAB_JENIS.map((j) => (
          <button
            key={j}
            type="button"
            role="tab"
            aria-selected={jenisAktif === j}
            className={`btn btn--kecil ${jenisAktif === j ? 'btn--utama' : 'btn--kedua'}`}
            onClick={() => setJenisAktif(j)}
          >
            {j}{j !== 'Semua' && jumlahPerJenis[j] ? ` (${jumlahPerJenis[j]})` : ''}
          </button>
        ))}
      </div>
    );

    return (
      <div className="tumpuk">
        <div className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2>{tanggalId(data.tanggal)}</h2>
            <span className="label">Halaman 2 — Monitoring &amp; Pemakaian</span>
          </div>
        </div>

        {tabBar}

        <div className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2>Approval</h2>
            <span className="label">Klik nama untuk lihat rincian yang disetujui</span>
          </div>
          {breakdownTersaring.length === 0 ? (
            <Kosong>
              {jenisAktif === 'Semua' ? 'Belum ada approval pada hari ini.' : `Belum ada approval ${jenisAktif} pada hari ini.`}
            </Kosong>
          ) : (
            <div className="tumpuk" style={{ gap: 8 }}>
              {breakdownTersaring.map((a) => {
                const buka = terbuka.has(a.nama);
                return (
                  <div key={a.nama} className="tumpuk" style={{ gap: 0 }}>
                    <button
                      type="button"
                      className="btn btn--hantu baris"
                      style={{ width: '100%', justifyContent: 'flex-start' }}
                      aria-expanded={buka}
                      onClick={() => toggle(a.nama)}
                    >
                      <strong>{a.nama}</strong>
                      <span className="label">{a.item.length} approval</span>
                      <div className="dorong" />
                      <span aria-hidden="true">{buka ? '▾' : '▸'}</span>
                    </button>
                    {buka && (
                      <div className="tumpuk" style={{ gap: 6 }}>
                        {a.item.map((it, i) => (
                          <div key={i} className="approval-item" style={{ '--aksen': WARNA_JENIS[it.jenis] }}>
                            <div className="approval-item__kepala">
                              <span className="approval-item__jenis">{it.jenis}</span>
                              <strong className="approval-item__kode">{it.kode}</strong>
                            </div>
                            <div className="approval-item__meta">
                              <span>{it.silo}</span>
                              <span className="approval-item__waktu">
                                {waktuId(it.waktu)} → disetujui {waktuId(it.disetujuiPada)}
                              </span>
                            </div>
                            <DetailItem it={it} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2>Belum Disetujui</h2>
            <span className="label">Record hari ini yang masih menunggu approval</span>
          </div>
          {belumDisetujui.length === 0 ? (
            <Kosong>Semua record hari ini sudah disetujui.</Kosong>
          ) : belumDisetujuiTersaring.length === 0 ? (
            <Kosong>{`Semua record ${jenisAktif} hari ini sudah disetujui.`}</Kosong>
          ) : (
            <table className="tabel">
              <thead>
                <tr>
                  <th>Kode</th>
                  <th>Jenis</th>
                  <th>Silo</th>
                  <th>Waktu</th>
                  <th>Dikerjakan Oleh</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {belumDisetujuiTersaring.map((r, i) => (
                  <tr key={i}>
                    <td className="angka">{r.kode}</td>
                    <td>
                      <span className="approval-item__jenis" style={{ '--aksen': WARNA_JENIS[r.jenis] }}>
                        {r.jenis}
                      </span>
                    </td>
                    <td>{r.silo}</td>
                    <td>{waktuId(r.waktu)}</td>
                    <td>{r.dikerjakanOleh}</td>
                    <td><Lencana nada={NADA_STATUS[r.status] ?? 'netral'}>{r.status}</Lencana></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="publik">
      <header className="topbar">
        <div className="topbar__identitas">
          <img className="topbar__logo" src="/Logo_Cimory.png" alt="Cimory" />
          <div className="topbar__judul">
            <div className="topbar__merek">CMD 1 Operation</div>
            <div className="topbar__sub">Diperiksa Oleh · Plant Sentul 1</div>
          </div>
        </div>
      </header>
      <main className="isi">{konten()}</main>
    </div>
  );
}
