import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import {
  fmt, formatStandingTime, waktuSingkat, Field, Lencana, PesanGalat, Kosong,
} from '../components/ui.jsx';

const LABEL_TAB = {
  receiving: 'Penerimaan',
  prepast: 'Prepast',
  monitoring: 'Monitoring',
  transfer: 'Transfer',
  pengembalian: 'Pengembalian',
};

const NADA_STATUS = {
  'Pending Approval': 'waspada',
  Approved: 'baik',
  Rejected: 'kritis',
  REVISED: 'netral',
  VOIDED: 'netral',
};

const filterKosong = { status: '', supplierId: '', dariTanggal: '', sampaiTanggal: '' };

/** Tab mana yang mengenal filter supplier. Monitoring dan transfer tidak. */
const PAKAI_SUPPLIER = new Set(['receiving', 'prepast']);

/**
 * Tab yang punya konsep "aktif di silo" - masih menyimpan susu di silo ini.
 * Transfer & monitoring adalah peristiwa, bukan isi silo, jadi tidak relevan.
 */
const PAKAI_AKTIF = new Set(['receiving', 'prepast', 'pengembalian']);

function KepalaSilo({ s }) {
  const persen = Number(s.persen_isi);
  return (
    <div className="kartu">
      <div className="kartu__kepala">
        <h1 style={{ fontSize: 20 }}>{s.silo_name}</h1>
        <span className="label">{s.kode}</span>
        {/* MySQL mengembalikan 0/1; tanpa Boolean() React merender angka 0 itu */}
        {Boolean(s.dalam_toleransi) && <Lencana nada="waspada">Melampaui nominal</Lencana>}
        {s.status_cek === 'PERLU_DICEK' && <Lencana nada="kritis">Perlu dicek</Lencana>}
      </div>

      <div className="baris" style={{ gap: 32 }}>
        <div>
          <div className="angka-besar">{fmt(s.vol_aktual_ltr)} L</div>
          <div className="label">
            dari {fmt(s.kapasitas_maks_ltr)} L nominal · {persen.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="angka-besar">{fmt(s.vol_tersedia_toleransi_ltr)} L</div>
          <div className="label">
            {/* toleransi_ltr sudah nilai EFEKTIF dari v_silo_volume (migrasi
                026) — 0 saat switch-nya dimatikan di Master Data. Klausanya
                disembunyikan sepenuhnya di sini, bukan ditulis "toleransi 0 L". */}
            masih dapat diterima
            {Number(s.toleransi_ltr) > 0 && ` · toleransi ${fmt(s.toleransi_ltr)} L`}
          </div>
        </div>
        <div>
          <div className="angka-besar">{s.jumlah_batch_aktif}</div>
          <div className="label">batch aktif</div>
        </div>
      </div>

      {!Boolean(s.is_buffer) && (
        <div
          className="baris"
          /* Dipisahkan garis dan jarak: baris ini keterangan pemantauan,
             bukan lanjutan angka volume di atasnya. */
          style={{
            gap: 24,
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid var(--gridline)',
          }}
        >
          <div>
            <span className="label">Cek terakhir</span>
            <div>
              {s.last_check_at
                ? `${waktuSingkat(s.last_check_at)} · pH ${s.last_ph}, ${s.last_temp} C`
                : 'belum pernah dicek'}
            </div>
          </div>
          <div>
            <span className="label">Standing time</span>
            <div>{formatStandingTime(s.standing_time_menit)}</div>
          </div>
          <div>
            <span className="label">Interval monitoring</span>
            <div>{s.monitoring_interval_jam} jam</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DetailSilo() {
  const { id } = useParams();
  const [tab, setTab] = useState(null);
  const [filter, setFilter] = useState(filterKosong);
  const [aktifSaja, setAktifSaja] = useState(false);
  const [halaman, setHalaman] = useState(1);

  const { data: silo, isLoading, error } = useQuery({
    queryKey: ['silo', id],
    queryFn: () => api.get(`/silos/${id}`),
  });

  const tabAktif = tab ?? silo?.tab[0] ?? null;
  const pakaiAktif = PAKAI_AKTIF.has(tabAktif);

  const kueri = new URLSearchParams(
    Object.entries({
      ...filter,
      // Filter supplier tidak berlaku di tab yang tidak punya supplier;
      // mengirimnya akan menyaring habis seluruh baris tanpa alasan yang
      // terlihat oleh pengguna.
      supplierId: PAKAI_SUPPLIER.has(tabAktif) ? filter.supplierId : '',
      siloId: id,
      halaman,
      // Hanya yang masih aktif di silo - dikirim hanya bila dinyalakan dan tab
      // memang punya konsep isi silo.
      ...(aktifSaja && pakaiAktif ? { aktifSaja: 'true' } : {}),
    }).filter(([, v]) => v !== '' && v != null),
  ).toString();

  const { data: riwayat, isLoading: memuatRiwayat, error: galatRiwayat } = useQuery({
    queryKey: ['data', tabAktif, kueri],
    queryFn: () => api.get(`/data/${tabAktif}?${kueri}`),
    enabled: Boolean(tabAktif),
  });

  const set = (k) => (e) => {
    setFilter({ ...filter, [k]: e.target.value });
    setHalaman(1);
  };

  if (isLoading) return <Kosong>Memuat detail silo…</Kosong>;
  if (error) return <PesanGalat galat={error} />;

  const s = silo.data;

  return (
    <div className="tumpuk">
      <Link to="/" className="btn btn--hantu btn--kecil" style={{ alignSelf: 'flex-start' }}>
        Kembali ke dashboard
      </Link>

      <KepalaSilo s={s} />

      <div className="baris">
        {silo.tab.map((t) => (
          <button
            key={t}
            type="button"
            className={`btn btn--kecil ${tabAktif === t ? 'btn--utama' : 'btn--kedua'}`}
            onClick={() => { setTab(t); setHalaman(1); }}
          >
            {LABEL_TAB[t] ?? t}
          </button>
        ))}
      </div>

      <div className="kartu">
        <div className="form-grid">
          <Field label="Dari tanggal">
            <input type="date" value={filter.dariTanggal} onChange={set('dariTanggal')} />
          </Field>
          <Field label="Sampai tanggal" bantuan="Tanggal ini ikut tercakup penuh">
            <input type="date" value={filter.sampaiTanggal} onChange={set('sampaiTanggal')} />
          </Field>
          <Field label="Status">
            <select value={filter.status} onChange={set('status')}>
              <option value="">Semua status</option>
              <option value="Pending Approval">Pending Approval</option>
              <option value="Approved">Approved</option>
              <option value="Rejected">Rejected</option>
              <option value="REVISED">REVISED</option>
            </select>
          </Field>
          {PAKAI_SUPPLIER.has(tabAktif) && (
            <Field
              label="Supplier"
              bantuan={
                silo.suppliers.length === 0
                  ? 'Belum ada supplier yang masuk silo ini'
                  : 'Hanya supplier yang pernah masuk silo ini'
              }
            >
              <select value={filter.supplierId} onChange={set('supplierId')}>
                <option value="">Semua supplier</option>
                {silo.suppliers.map((sp) => (
                  <option key={sp.id} value={sp.id}>{sp.supplier_name}</option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {pakaiAktif && (
          <label className="baris" style={{ gap: 8, cursor: 'pointer', marginTop: 12 }}>
            <input
              type="checkbox"
              style={{ width: 20, height: 20, minHeight: 20 }}
              checked={aktifSaja}
              onChange={(e) => { setAktifSaja(e.target.checked); setHalaman(1); }}
            />
            <span className="label">Hanya yang masih aktif di silo (belum habis)</span>
          </label>
        )}
        {(Object.values(filter).some((v) => v !== '') || aktifSaja) && (
          <div className="baris kartu__aksi">
            <button
              type="button"
              className="btn btn--hantu btn--kecil"
              onClick={() => { setFilter(filterKosong); setAktifSaja(false); setHalaman(1); }}
            >
              Bersihkan Filter
            </button>
          </div>
        )}
      </div>

      <PesanGalat galat={galatRiwayat} />

      {memuatRiwayat ? (
        <Kosong>Memuat riwayat…</Kosong>
      ) : !riwayat ? null : riwayat.data.length === 0 ? (
        <Kosong>
          Tidak ada {LABEL_TAB[tabAktif]?.toLowerCase()} pada silo ini
          {(Object.values(filter).some((v) => v !== '') || aktifSaja) ? ' dengan filter tersebut' : ''}.
        </Kosong>
      ) : (
        <div className="kartu">
          <div className="kartu__kepala">
            <h2 style={{ fontSize: 16 }}>
              {LABEL_TAB[tabAktif]} · {riwayat.total} record
            </h2>
            {/*
              Aksi koreksi dan pembatalan sengaja TIDAK ada di sini. Halaman
              ini untuk membaca riwayat satu silo; menaruh tombol yang sama di
              dua tempat berarti dua tempat yang harus dijaga tetap sepaham
              soal wewenang, dan itulah yang membuat B-22 mungkin terjadi.
            */}
            <Link to="/data" className="btn btn--hantu btn--kecil dorong">
              Buka di Data untuk mengoreksi
            </Link>
          </div>

          <table className="tabel">
            <thead>
              <tr>
                <th>Kode</th>
                <th>Ringkasan</th>
                <th className="num">Volume</th>
                <th>Waktu</th>
                <th>Status</th>
                <th>Operator</th>
              </tr>
            </thead>
            <tbody>
              {riwayat.data.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.kode}
                    {b.isDraft && <> <Lencana nada="waspada">Draft</Lencana></>}
                  </td>
                  <td>{b.ringkasan}</td>
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
                </tr>
              ))}
            </tbody>
          </table>

          {riwayat.totalHalaman > 1 && (
            <div className="baris">
              <span className="label">
                Halaman {riwayat.halaman} dari {riwayat.totalHalaman}
              </span>
              <button
                type="button" className="btn btn--kedua btn--kecil dorong"
                disabled={halaman <= 1} onClick={() => setHalaman(halaman - 1)}
              >
                Sebelumnya
              </button>
              <button
                type="button" className="btn btn--kedua btn--kecil"
                disabled={halaman >= riwayat.totalHalaman}
                onClick={() => setHalaman(halaman + 1)}
              >
                Berikutnya
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
