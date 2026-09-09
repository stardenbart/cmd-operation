import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  fmt, waktuSingkat, Field, Lencana, PesanGalat, PesanSukses, Kosong,
} from '../components/ui.jsx';

const LABEL_KATEGORI = {
  receiving: 'Receiving', prepast: 'Prepast', switching: 'Switching',
  buffer: 'Buffer', penarikan: 'Penarikan',
};
const LABEL_SATUAN = { per_penarikan: 'Per penarikan', per_transfer: 'Per transfer' };
const LABEL_CALC = {
  fixed_per_record: 'Per record',
  fixed_per_frequency_prepast: 'Per frekuensi prepast',
  manual_input: 'Input manual',
};

/** Riwayat perubahan satu loss point. */
function Riwayat({ id, kode, onTutup }) {
  const { data, isLoading } = useQuery({
    queryKey: ['losses', 'detail', id],
    queryFn: () => api.get(`/losses/points/${id}`),
  });
  return (
    <div className="kartu tumpuk">
      <div className="kartu__kepala">
        <h2 style={{ fontSize: 16 }}>Riwayat {kode}</h2>
        <button type="button" className="btn btn--hantu btn--kecil dorong" onClick={onTutup}>Tutup</button>
      </div>
      {isLoading ? <Kosong>Memuat…</Kosong> : (data.data.riwayat.length === 0
        ? <div className="bantuan">Belum ada perubahan.</div>
        : (
          <div className="tabel-bungkus">
            <table className="tabel">
              <thead><tr><th>Waktu</th><th>Oleh</th><th>Perubahan</th></tr></thead>
              <tbody>
                {data.data.riwayat.map((h) => (
                  <tr key={h.id}>
                    <td>{waktuSingkat(h.created_at)}</td>
                    <td>{h.aktor_nama ?? '-'}</td>
                    <td className="bantuan">{JSON.stringify(h.after_json?.perubahan ?? {})}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

export default function LossesManagement() {
  const qc = useQueryClient();
  const { boleh } = useAuth();
  const bolehKelola = boleh('master:kelola');
  const [sunting, setSunting] = useState(null); // { id, volume_liter, satuan }
  const [konfirmasi, setKonfirmasi] = useState(null); // { id, kode, aktif }
  const [riwayat, setRiwayat] = useState(null);
  const [sukses, setSukses] = useState(null);
  const [galat, setGalat] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['losses', 'points'],
    queryFn: () => api.get('/losses/points'),
  });

  const patch = useMutation({
    mutationFn: ({ id, isi }) => api.patch(`/losses/points/${id}`, isi),
    onSuccess: (res) => {
      setSukses(res.versiId
        ? 'Tersimpan. Snapshot versi baru dibuat - laporan berikutnya memakai konfigurasi ini.'
        : 'Tersimpan.');
      setGalat(null); setSunting(null); setKonfirmasi(null);
      qc.invalidateQueries({ queryKey: ['losses'] });
    },
    onError: (err) => { setGalat(err); setSukses(null); },
  });

  if (isLoading) return <Kosong>Memuat titik losses…</Kosong>;

  return (
    <div className="tumpuk">
      <div className="kartu__kepala halaman-kepala">
        <div>
          <span className="halaman-kepala__eyebrow">Konfigurasi</span>
          <h1>Losses Setting</h1>
        </div>
        <span className="label">{data.total} titik loss</span>
      </div>
      <p className="bantuan halaman-deskripsi">
        Master {data.total} titik losses proses FM. Mengubah volume, satuan, atau
        status aktif membuat snapshot versi baru - laporan losses ke depan memakai
        konfigurasi terkini, sementara laporan lama tetap merujuk versinya sendiri.
      </p>

      <PesanSukses>{sukses}</PesanSukses>
      <PesanGalat galat={galat} onTutup={() => setGalat(null)} />

      {data.perKategori.map((grup) => (
        <div key={grup.kategori} className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2 style={{ fontSize: 16 }}>{LABEL_KATEGORI[grup.kategori] ?? grup.kategori}</h2>
            <Lencana>{grup.titik.length} titik</Lencana>
          </div>
          <div className="tabel-bungkus">
            <table className="tabel">
              <thead>
                <tr>
                  <th>Kode</th><th>Nama</th><th className="num">Volume (L)</th>
                  <th>Satuan</th><th>Perhitungan</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {grup.titik.map((lp) => {
                  const sedang = sunting?.id === lp.id;
                  return (
                    <tr key={lp.id} className={lp.aktif ? '' : 'baris--kosong'}>
                      <td><b>{lp.kode}</b></td>
                      <td>{lp.nama}</td>
                      <td className="num">
                        {sedang ? (
                          <input
                            className="angka-input" inputMode="decimal" style={{ width: 90 }}
                            value={sunting.volume_liter}
                            onChange={(e) => setSunting({ ...sunting, volume_liter: e.target.value })}
                          />
                        ) : fmt(lp.volume_liter, 1)}
                      </td>
                      <td>
                        {sedang ? (
                          <select
                            value={sunting.satuan}
                            onChange={(e) => setSunting({ ...sunting, satuan: e.target.value })}
                          >
                            <option value="per_penarikan">Per penarikan</option>
                            <option value="per_transfer">Per transfer</option>
                          </select>
                        ) : (LABEL_SATUAN[lp.satuan] ?? lp.satuan)}
                      </td>
                      <td className="bantuan">{LABEL_CALC[lp.calculation_type] ?? lp.calculation_type}</td>
                      <td>
                        <Lencana nada={lp.aktif ? 'baik' : 'netral'}>
                          {lp.aktif ? 'Aktif' : 'Nonaktif'}
                        </Lencana>
                      </td>
                      <td className="tabel__aksi-sel">
                        <button
                          type="button" className="btn btn--hantu btn--kecil"
                          onClick={() => setRiwayat({ id: lp.id, kode: lp.kode })}
                        >
                          Riwayat
                        </button>
                        {bolehKelola && (sedang ? (
                          <>
                            <button
                              type="button" className="btn btn--utama btn--kecil"
                              disabled={patch.isPending}
                              onClick={() => patch.mutate({
                                id: lp.id,
                                isi: {
                                  volume_liter: Number(String(sunting.volume_liter).replace(',', '.')),
                                  satuan: sunting.satuan,
                                },
                              })}
                            >
                              Simpan
                            </button>
                            <button
                              type="button" className="btn btn--hantu btn--kecil"
                              onClick={() => setSunting(null)}
                            >
                              Batal
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button" className="btn btn--kedua btn--kecil"
                              onClick={() => setSunting({ id: lp.id, volume_liter: lp.volume_liter, satuan: lp.satuan })}
                            >
                              Sunting
                            </button>
                            <button
                              type="button"
                              className={`btn btn--kecil ${lp.aktif ? 'btn--bahaya' : 'btn--kedua'}`}
                              onClick={() => setKonfirmasi({ id: lp.id, kode: lp.kode, aktif: !lp.aktif })}
                            >
                              {lp.aktif ? 'Nonaktifkan' : 'Aktifkan'}
                            </button>
                          </>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* FR-35.4.4: toggle aktif butuh konfirmasi - berdampak ke kalkulasi */}
      {konfirmasi && (
        <div className="kartu tumpuk">
          <h2 style={{ fontSize: 16 }}>
            {konfirmasi.aktif ? 'Aktifkan' : 'Nonaktifkan'} {konfirmasi.kode}?
          </h2>
          <div className="pesan pesan--waspada">
            Perubahan status memengaruhi kalkulasi losses berikutnya dan membuat
            snapshot versi baru. Laporan yang sudah dibuat tidak berubah.
          </div>
          <div className="baris">
            <button
              type="button" className="btn btn--utama"
              disabled={patch.isPending}
              onClick={() => patch.mutate({ id: konfirmasi.id, isi: { aktif: konfirmasi.aktif } })}
            >
              Ya, {konfirmasi.aktif ? 'aktifkan' : 'nonaktifkan'}
            </button>
            <button type="button" className="btn btn--hantu" onClick={() => setKonfirmasi(null)}>
              Batal
            </button>
          </div>
        </div>
      )}

      {riwayat && (
        <Riwayat id={riwayat.id} kode={riwayat.kode} onTutup={() => setRiwayat(null)} />
      )}
    </div>
  );
}
