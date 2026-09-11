import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unduh } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  fmt, waktuSingkat, Field, Lencana, PesanGalat, PesanSukses, Kosong, Sakelar,
} from '../components/ui.jsx';
import BerkasSiap from '../components/BerkasSiap.jsx';

/**
 * Halaman ini TIDAK tahu kolom apa yang dimiliki tiap master.
 *
 * Bentuknya datang dari server bersama datanya, dari definisi yang sama yang
 * dipakai validasi dan jejak audit. Menyalin daftar kolom ke sini berarti
 * menambah supplier baru menuntut perubahan di dua tempat, dan yang ditulis
 * dua kali akan menyimpang.
 */

// boolean dan sakelar mulai dari bawaannya sama-sama; keduanya cuma beda
// tampilan (checkbox vs switch), bukan beda makna nilainya.
const JENIS_BOOLEAN = ['boolean', 'sakelar'];

const nilaiKosong = (kolom) =>
  Object.fromEntries(
    kolom.map((k) => [k.k, JENIS_BOOLEAN.includes(k.jenis) ? (k.bawaan ?? false) : '']),
  );

function InputKolom({ kolom, nilai, onChange, nonaktif }) {
  const set = (v) => onChange(kolom.k, v);

  if (kolom.jenis === 'boolean') {
    return (
      <label className="baris" style={{ gap: 8 }}>
        <input
          type="checkbox" checked={Boolean(nilai)} disabled={nonaktif}
          onChange={(e) => set(e.target.checked)}
        />
        <span>{kolom.label}</span>
      </label>
    );
  }
  if (kolom.jenis === 'sakelar') {
    return (
      <Sakelar
        checked={Boolean(nilai)}
        disabled={nonaktif}
        onChange={set}
        label={Boolean(nilai) ? 'Aktif' : 'Nonaktif'}
      />
    );
  }
  if (kolom.jenis === 'pilihan') {
    return (
      <select value={nilai ?? ''} disabled={nonaktif} onChange={(e) => set(e.target.value)}>
        <option value="">Pilih…</option>
        {kolom.pilihan.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
    );
  }
  if (kolom.jenis === 'teksPanjang') {
    return (
      <textarea value={nilai ?? ''} disabled={nonaktif} onChange={(e) => set(e.target.value)} />
    );
  }
  if (kolom.jenis === 'tanggal') {
    return (
      <input
        type="date" disabled={nonaktif}
        value={nilai ? String(nilai).slice(0, 10) : ''}
        onChange={(e) => set(e.target.value)}
      />
    );
  }
  if (kolom.jenis === 'angka' || kolom.jenis === 'desimal') {
    return (
      <input
        className="angka-input" inputMode="decimal" disabled={nonaktif}
        value={nilai ?? ''} onChange={(e) => set(e.target.value)}
      />
    );
  }
  return (
    <input value={nilai ?? ''} disabled={nonaktif} onChange={(e) => set(e.target.value)} />
  );
}

function tampilNilai(kolom, baris) {
  const v = baris[kolom.k];
  if (JENIS_BOOLEAN.includes(kolom.jenis)) {
    return v ? <Lencana nada="baik">Ya</Lencana> : <span className="bantuan">tidak</span>;
  }
  if (v === null || v === undefined || v === '') return <span className="bantuan">-</span>;
  if (kolom.jenis === 'desimal') return fmt(v);
  if (kolom.jenis === 'tanggal') return String(v).slice(0, 10);
  return String(v);
}

/** Ringkasan master data - FR-26.1.7. */
function Ringkasan() {
  const { data, isLoading } = useQuery({
    queryKey: ['master-ringkasan'],
    queryFn: () => api.get('/master'),
  });

  if (isLoading) return <Kosong>Memuat ringkasan…</Kosong>;

  return (
    <div className="tumpuk">
      <div className="kartu__kepala"><h1>Master Data</h1></div>
      <p className="bantuan">
        Selama data berada di SharePoint, master data dapat disunting lewat
        antarmuka SharePoint. Setelah pindah ke MySQL antarmuka itu hilang,
        dan halaman inilah penggantinya. Entri yang pernah dipakai transaksi
        tidak dapat dihapus, hanya dinonaktifkan.
      </p>

      <div className="kartu">
        <table className="tabel">
          <thead>
            <tr>
              <th>Master</th>
              <th className="num">Entri</th>
              <th className="num">Nonaktif</th>
              <th>Perubahan terakhir</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((m) => (
              <tr key={m.master}>
                <td>{m.label}</td>
                <td className="num">{m.total}</td>
                <td className="num">
                  {m.nonaktif > 0 ? <Lencana nada="waspada">{m.nonaktif}</Lencana> : '0'}
                </td>
                <td>
                  {m.perubahanTerakhir
                    ? `${m.perubahanTerakhir.aksi} oleh ${m.perubahanTerakhir.aktor} · ${waktuSingkat(m.perubahanTerakhir.waktu)}`
                    : <span className="bantuan">belum ada</span>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <Link to={`/master/${m.master}`} className="btn btn--kedua btn--kecil">
                    Kelola
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Riwayat perubahan satu entri - FR-26.2.3. */
function Riwayat({ master, id, kode, onTutup }) {
  const { data, isLoading } = useQuery({
    queryKey: ['master-riwayat', master, id],
    queryFn: () => api.get(`/master/${master}/${id}/history`),
  });

  return (
    <div className="kartu tumpuk">
      <div className="kartu__kepala">
        <h2 style={{ fontSize: 16 }}>Riwayat {kode}</h2>
        <button type="button" className="btn btn--hantu btn--kecil dorong" onClick={onTutup}>
          Tutup
        </button>
      </div>
      {isLoading ? (
        <Kosong>Memuat riwayat…</Kosong>
      ) : data.data.length === 0 ? (
        <Kosong>Belum ada perubahan tercatat.</Kosong>
      ) : (
        <table className="tabel">
          <thead>
            <tr><th>Waktu</th><th>Aksi</th><th>Oleh</th><th>Perubahan</th></tr>
          </thead>
          <tbody>
            {data.data.map((r) => (
              <tr key={r.id}>
                <td>{waktuSingkat(r.waktu)}</td>
                <td><Lencana nada="netral">{r.aksi}</Lencana></td>
                <td>{r.aktor}</td>
                <td>
                  {r.sesudah?.perubahan
                    ? Object.entries(r.sesudah.perubahan).map(([k, v]) => (
                      <div key={k}>
                        <span className="label">{k}</span>{' '}
                        <span style={{ color: 'var(--text-secondary)' }}>{String(v.dari ?? '-')}</span>
                        {' → '}
                        <b>{String(v.menjadi ?? '-')}</b>
                      </div>
                    ))
                    : <span className="bantuan">{r.alasan}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Hak akses tambahan per user - FR-34.3. Menampilkan checkbox aksi yang BELUM
 * dimiliki peran user, dikelompokkan per kategori. Aditif saja (BR-27).
 */
function HakAksesTambahan({ userId, onSelesai, onGalat }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['master', 'permissions', userId],
    queryFn: () => api.get(`/master/users/${userId}/permissions`),
  });
  const [pilih, setPilih] = useState(null);

  useEffect(() => {
    if (data) setPilih(new Set(data.data.customPermissions));
  }, [data]);

  const simpan = useMutation({
    mutationFn: () => api.patch(`/master/users/${userId}/permissions`, { permissions: [...pilih] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['master'] });
      onSelesai('Hak akses tambahan disimpan. Berlaku pada sesi berikutnya user tersebut.');
    },
    onError: onGalat,
  });

  if (isLoading || !pilih) return <div className="bantuan">Memuat hak akses…</div>;
  const { tersedia } = data.data;
  if (tersedia.length === 0) {
    return <div className="bantuan">Peran ini sudah memiliki seluruh wewenang; tidak ada hak akses tambahan.</div>;
  }

  const kategori = [...new Set(tersedia.map((t) => t.kategori))];
  const toggle = (aksi) => setPilih((s) => {
    const n = new Set(s);
    if (n.has(aksi)) n.delete(aksi); else n.add(aksi);
    return n;
  });

  return (
    <div className="tumpuk hak-akses">
      <div className="bantuan">
        Wewenang di luar peran, khusus untuk user ini. Hanya menambah, tidak
        pernah mencabut yang sudah dimiliki peran.
      </div>
      <div className="hak-akses__grid">
        {kategori.map((kat) => (
          <div key={kat} className="hak-akses__grup">
            <div className="label">{kat}</div>
            {tersedia.filter((t) => t.kategori === kat).map((t) => (
              <label key={t.aksi} className="hak-akses__item">
                <input type="checkbox" checked={pilih.has(t.aksi)} onChange={() => toggle(t.aksi)} />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="baris">
        <button
          type="button" className="btn btn--utama btn--kecil"
          disabled={simpan.isPending} onClick={() => simpan.mutate()}
        >
          {simpan.isPending ? 'Menyimpan…' : 'Simpan Hak Akses'}
        </button>
      </div>
    </div>
  );
}

/**
 * Preferensi tampilan GLOBAL untuk dropdown pilih silo di Prepast/Lengkapi
 * Prepast — bukan atribut satu silo, jadi ditaruh di atas daftar, bukan
 * kolom per baris. Berlaku sama untuk semua orang begitu disimpan; hanya
 * Admin yang boleh mengubahnya (wewenang sesungguhnya ditegakkan di server).
 */
function PengaturanSiloGlobal({ bolehUbah }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['pengaturan'],
    queryFn: () => api.get('/pengaturan'),
  });

  const simpan = useMutation({
    mutationFn: (tampilkanSisaSilo) => api.patch('/pengaturan', { tampilkanSisaSilo }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pengaturan'] }),
  });

  const nilai = data?.data?.tampilkanSisaSilo ?? true;

  return (
    <div className="kartu baris" style={{ gap: 12 }}>
      <Sakelar
        checked={nilai}
        disabled={!bolehUbah || simpan.isPending}
        onChange={(v) => simpan.mutate(v)}
        label="Tampilkan sisa kapasitas di dropdown pilih silo Prepast"
      />
      <span className="bantuan dorong">
        Berlaku untuk semua orang — bukan cuma tampilan Anda sendiri.
      </span>
    </div>
  );
}

function DaftarMaster({ master }) {
  const qc = useQueryClient();
  const { boleh } = useAuth();
  const [cari, setCari] = useState('');
  const [status, setStatus] = useState('semua');
  const [sunting, setSunting] = useState(null);
  const [form, setForm] = useState({});
  const [riwayat, setRiwayat] = useState(null);
  const [sukses, setSukses] = useState(null);
  const [galat, setGalat] = useState(null);
  const [berkas, setBerkas] = useState(null);

  const bolehKelola = boleh('master:kelola');

  const kueri = new URLSearchParams(
    Object.entries({ cari, status }).filter(([, v]) => v !== '' && v !== 'semua'),
  ).toString();

  const { data, isLoading } = useQuery({
    queryKey: ['master', master, kueri],
    queryFn: () => api.get(`/master/${master}?${kueri}`),
  });

  useEffect(() => { setSunting(null); setRiwayat(null); setSukses(null); setGalat(null); }, [master]);

  const selesai = (pesan) => {
    setSukses(pesan);
    setGalat(null);
    setSunting(null);
    qc.invalidateQueries({ queryKey: ['master'] });
    qc.invalidateQueries({ queryKey: ['master-ringkasan'] });
    qc.invalidateQueries({ queryKey: ['master-riwayat'] });
    // Master Silo memengaruhi tampilan Dashboard ('silos', jamak — daftar
    // seluruh silo) dan Detail Silo ('silo', tunggal — satu silo by id),
    // dua kunci cache yang berbeda untuk kapasitas/toleransi/Bejana. Tanpa
    // ini, menyalakan/mematikan switch toleransi tersimpan dengan benar
    // tapi kedua halaman itu tetap menampilkan data lama sampai refresh
    // manual atau polling 30 detiknya kebetulan jalan.
    if (master === 'silos') {
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['silo'] });
    }
  };

  const simpan = useMutation({
    mutationFn: ({ id, isi }) =>
      id ? api.patch(`/master/${master}/${id}`, isi) : api.post(`/master/${master}`, isi),
    onSuccess: (res) => {
      selesai(
        res.passwordSementara
          ? `Entri dibuat. Password sementara: ${res.passwordSementara} — catat sekarang, ` +
            'password ini tidak ditampilkan lagi dan wajib diganti saat login pertama.'
          : res.catatan
            ? `Tersimpan. ${res.catatan}`
            : 'Tersimpan.',
      );
    },
    onError: (err) => { setGalat(err); setSukses(null); },
  });

  const resetPassword = useMutation({
    mutationFn: (id) => api.post(`/master/users/${id}/reset-password`),
    onSuccess: (res) =>
      selesai(
        `Password ${res.data.namaLengkap} (${res.data.username}) direset. ` +
        `Password sementara: ${res.data.passwordSementara} — catat sekarang, ` +
        'password ini tidak ditampilkan lagi. Sesi lamanya sudah dicabut.',
      ),
    onError: (err) => { setGalat(err); setSukses(null); },
  });

  const csv = useMutation({
    mutationFn: () => unduh(`/master/${master}/csv`),
    onSuccess: (h) => setBerkas(h),
    onError: (err) => setGalat(err),
  });

  if (isLoading) return <Kosong>Memuat master…</Kosong>;

  const kolom = data.kolom;
  const mulaiBuat = () => { setSunting({ id: null }); setForm(nilaiKosong(kolom)); setGalat(null); };
  const mulaiSunting = (b) => {
    setSunting({ id: b.id, kode: b.kode ?? b.tank_name ?? b.kode_form });
    setForm(Object.fromEntries(kolom.map((k) => [k.k, b[k.k] ?? (k.jenis === 'boolean' ? false : '')])));
    setGalat(null);
  };

  return (
    <div className="tumpuk">
      <div className="kartu__kepala master-kepala">
        <Link to="/master" className="btn btn--hantu btn--kecil">Master Data</Link>
        <h1 style={{ fontSize: 20 }}>{data.label}</h1>
        <span className="label">{data.total} entri</span>
      </div>

      <PesanSukses>{sukses}</PesanSukses>
      <BerkasSiap hasil={berkas} onTutup={() => setBerkas(null)} />
      <PesanGalat galat={galat} onTutup={() => setGalat(null)} />

      {master === 'silos' && <PengaturanSiloGlobal bolehUbah={bolehKelola} />}

      <div className="kartu master-filter">
        <div className="form-grid">
          <Field label="Cari">
            <input value={cari} onChange={(e) => setCari(e.target.value)} placeholder="Kode atau nama" />
          </Field>
          {!data.tanpaAktif && (
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="semua">Semua</option>
                <option value="aktif">Aktif</option>
                <option value="nonaktif">Nonaktif</option>
              </select>
            </Field>
          )}
        </div>
        <div className="baris kartu__aksi">
          <button
            type="button" className="btn btn--hantu btn--kecil"
            disabled={csv.isPending} onClick={() => csv.mutate()}
          >
            {csv.isPending ? 'Menyiapkan…' : 'Unduh CSV'}
          </button>
          {bolehKelola && (
            <button type="button" className="btn btn--utama btn--kecil dorong" onClick={mulaiBuat}>
              Tambah {data.label}
            </button>
          )}
        </div>
      </div>

      {sunting && (
        <div className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2 style={{ fontSize: 16 }}>
              {sunting.id ? `Sunting ${sunting.kode ?? ''}` : `${data.label} Baru`}
            </h2>
            <button
              type="button" className="btn btn--hantu btn--kecil dorong"
              onClick={() => setSunting(null)}
            >
              Batal
            </button>
          </div>

          {master === 'users' && !sunting.id && (
            <div className="pesan pesan--info">
              Password tidak ditentukan di sini. Sistem membangkitkan password
              sementara yang ditampilkan sekali setelah tersimpan, dan wajib
              diganti saat login pertama. Password adalah kredensial pemiliknya,
              jadi tidak ada yang boleh menentukannya untuk orang lain.
            </div>
          )}

          <div className="form-grid">
            {kolom.map((k) => {
              // Deklaratif, bukan hardcode nama kolom: master mana pun dapat
              // memakai nonaktifJika untuk mengunci satu field mengikuti
              // nilai field lain (mis. angka toleransi mengikuti switch-nya).
              const nonaktifKarenaAturan = k.nonaktifJika
                && form[k.nonaktifJika.kolom] === k.nonaktifJika.nilai;
              return (
                <Field key={k.k} label={k.label} wajib={k.wajib} bantuan={k.bantuan}>
                  <InputKolom
                    kolom={k}
                    nilai={form[k.k]}
                    nonaktif={!bolehKelola || nonaktifKarenaAturan}
                    onChange={(nama, v) => setForm({ ...form, [nama]: v })}
                  />
                </Field>
              );
            })}
          </div>

          <div className="baris">
            <button
              type="button" className="btn btn--utama dorong"
              disabled={simpan.isPending || !bolehKelola}
              onClick={() => simpan.mutate({ id: sunting.id, isi: form })}
            >
              {simpan.isPending ? 'Menyimpan…' : 'Simpan'}
            </button>
          </div>

          {master === 'users' && sunting.id && bolehKelola && (
            <div className="tumpuk" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Hak Akses Tambahan</h3>
              <HakAksesTambahan
                userId={sunting.id}
                onSelesai={selesai}
                onGalat={(err) => { setGalat(err); setSukses(null); }}
              />
            </div>
          )}
        </div>
      )}

      <div className="kartu">
        <table className="tabel">
          <thead>
            <tr>
              {kolom.map((k) => <th key={k.k}>{k.label}</th>)}
              <th className="num">Dipakai</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.data.map((b) => (
              <tr key={b.id} className={b.is_active === 0 ? 'baris--kosong' : ''}>
                {kolom.map((k) => {
                  const adaHak = master === 'users' && k.k === 'role'
                    && b.custom_permissions?.length > 0;
                  return (
                    <td key={k.k}>
                      {adaHak ? (
                        // FR-34.3.6: lencana hak akses custom pada kolom peran.
                        // Dibungkus flex ber-gap supaya lencana tidak menempel
                        // pada teks perannya.
                        <span className="sel-peran">
                          {tampilNilai(k, b)}
                          <Lencana nada="baik" title="hak akses tambahan di luar peran">
                            +{b.custom_permissions.length} hak
                          </Lencana>
                        </span>
                      ) : tampilNilai(k, b)}
                    </td>
                  );
                })}
                <td className="num">
                  {b.jumlahPemakaian > 0
                    ? <span title="transaksi yang merujuk entri ini">{b.jumlahPemakaian}</span>
                    : <span className="bantuan">0</span>}
                </td>
                <td className="tabel__aksi-sel">
                  <button
                    type="button" className="btn btn--hantu btn--kecil"
                    onClick={() => setRiwayat({ id: b.id, kode: b.kode ?? b.tank_name ?? b.kode_form })}
                  >
                    Riwayat
                  </button>
                  {bolehKelola && (
                    <button
                      type="button" className="btn btn--kedua btn--kecil"
                      onClick={() => mulaiSunting(b)}
                    >
                      Sunting
                    </button>
                  )}
                  {bolehKelola && master === 'users' && (
                    <button
                      type="button" className="btn btn--bahaya btn--kecil"
                      disabled={resetPassword.isPending}
                      onClick={() => resetPassword.mutate(b.id)}
                    >
                      Reset password
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {riwayat && (
        <Riwayat
          master={master}
          id={riwayat.id}
          kode={riwayat.kode}
          onTutup={() => setRiwayat(null)}
        />
      )}
    </div>
  );
}

export default function Master() {
  const { master } = useParams();
  return master ? <DaftarMaster master={master} /> : <Ringkasan />;
}
