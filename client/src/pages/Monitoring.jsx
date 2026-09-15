import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmt, Field, Lencana, PesanGalat, PesanSukses, Kosong } from '../components/ui.jsx';

const angka = (v) => parseFloat(String(v).replace(',', '.'));

const NADA = {
  OK: ['baik', 'Terpantau'],
  PERLU_DICEK: ['kritis', 'Lewat jadwal'],
  BELUM_PERNAH: ['waspada', 'Belum dicek'],
  KOSONG: ['netral', 'Kosong'],
};

/** Waktu sekarang dalam bentuk yang diterima input datetime-local. */
function sekarangLokal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Ronde monitoring - FR-30.1
 *
 * Operator berkeliling sekali, mengisi pH dan suhu seluruh silo, lalu
 * mengirim satu kali. Power Apps memaksa satu form per silo: 8 silo x 7
 * kali cek berarti sampai 56 pengisian per hari.
 */
export default function Monitoring() {
  const qc = useQueryClient();
  const [timeCheck, setTimeCheck] = useState(sekarangLokal);
  const [isian, setIsian] = useState({});
  const [sukses, setSukses] = useState(null);
  // Terpisah dari pesan sukses (BR-10) — sebelumnya ditempel jadi satu
  // paragraf di dalam banner hijau biasa dan gampang tidak terlihat.
  // Sekarang alert waspada sendiri, sama seperti pH di luar rentang.
  const [lewatJadwalTerakhir, setLewatJadwalTerakhir] = useState([]);

  const { data, isLoading } = useQuery({
    queryKey: ['monitoring', 'round-context'],
    queryFn: () => api.get('/monitoring/round-context'),
  });

  useEffect(() => { setTimeCheck(sekarangLokal()); }, []);

  const simpan = useMutation({
    mutationFn: (body) => api.post('/monitoring/round', body),
    onSuccess: (res) => {
      const d = res.data;
      let pesan = `${d.dibuat.length} silo tercatat: ${d.dibuat.map((x) => x.siloName).join(', ')}.`;
      if (d.diLuarRentang.length > 0) {
        pesan += ` pH di luar rentang pada ${d.diLuarRentang.map((x) => `${x.siloName} (${x.ph})`).join(', ')}.`;
      }
      setSukses(pesan);
      // BR-10 — tetap tersimpan (tidak ditolak), tapi ditandai lewat alert
      // waspada TERPISAH supaya celah jadwal tidak lewat tanpa disadari
      // operator sendiri (sebelumnya ditempel di pesan sukses dan gampang
      // tidak terlihat).
      setLewatJadwalTerakhir(d.lewatJadwal);
      setIsian({});
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['monitoring'] });
    },
  });

  if (isLoading) return <Kosong>Memuat daftar silo…</Kosong>;

  const { data: silos, rentangPh } = data;
  const ubah = (siloId, k, v) =>
    setIsian({ ...isian, [siloId]: { ...isian[siloId], [k]: v } });

  const terisi = silos.filter(
    (s) => isian[s.silo_id]?.ph && isian[s.silo_id]?.temp,
  );

  const phDiLuar = terisi.filter((s) => {
    const p = angka(isian[s.silo_id].ph);
    return p < rentangPh.min || p > rentangPh.maks;
  });

  function kirim(e) {
    e.preventDefault();
    setSukses(null);
    setLewatJadwalTerakhir([]);
    simpan.mutate({
      timeCheck,
      hasil: terisi.map((s) => ({
        siloId: s.silo_id,
        ph: isian[s.silo_id].ph,
        temp: isian[s.silo_id].temp,
      })),
    });
  }

  return (
    <form className="tumpuk" onSubmit={kirim}>
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Ronde pengecekan</h2>
          <span className="label">Satu waktu berlaku untuk semua silo</span>
        </div>

        <PesanSukses>{sukses}</PesanSukses>
        {lewatJadwalTerakhir.length > 0 && (
          <div className="pesan pesan--waspada" role="alert">
            Perhatian — lewat jadwal: {lewatJadwalTerakhir.map((x) => `${x.siloName} (+${x.jamSejakCekSebelumnya} jam dari ambang ${x.ambangJam} jam)`).join(', ')}.
            {' '}Data tetap tersimpan, tetapi celah ini tercatat dan dapat ditinjau lewat Data List.
          </div>
        )}
        <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />

        <div style={{ maxWidth: 280 }}>
          <Field label="Waktu cek" wajib>
            <input
              type="datetime-local"
              value={timeCheck}
              onChange={(e) => setTimeCheck(e.target.value)}
              required
            />
          </Field>
        </div>
      </div>

      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Silo</h2>
          <span className="label">
            pH wajar {rentangPh.min.toFixed(1)} sampai {rentangPh.maks.toFixed(1)}
          </span>
        </div>

        <table className="tabel">
          <thead>
            <tr>
              <th>Silo</th>
              <th className="num">Volume</th>
              <th>Status</th>
              <th style={{ width: 130 }}>pH</th>
              <th style={{ width: 130 }}>Suhu (°C)</th>
            </tr>
          </thead>
          <tbody>
            {silos.map((s) => {
              const [nada, teks] = NADA[s.status_cek] ?? ['netral', s.status_cek];
              const ph = isian[s.silo_id]?.ph;
              const phLuar = ph && (angka(ph) < rentangPh.min || angka(ph) > rentangPh.maks);
              return (
                <tr key={s.silo_id} style={{ opacity: s.volumeKosongSaatIni ? 0.6 : 1 }}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.silo_name}</div>
                    {s.supplierList && (
                      <div className="bantuan" style={{ maxWidth: 320 }}>{s.supplierList}</div>
                    )}
                  </td>
                  <td className="num">{fmt(s.vol_aktual_ltr)} L</td>
                  <td>
                    <Lencana nada={nada}>{teks}</Lencana>
                    <div className="bantuan" style={{ marginTop: 4 }}>
                      tiap {s.monitoring_interval_jam} jam
                    </div>
                  </td>
                  <td>
                    <input
                      className="angka-input"
                      inputMode="decimal"
                      value={ph ?? ''}
                      onChange={(e) => ubah(s.silo_id, 'ph', e.target.value)}
                      placeholder="6,7"
                      style={phLuar ? { borderColor: 'var(--status-critical)' } : undefined}
                    />
                  </td>
                  <td>
                    <input
                      className="angka-input"
                      inputMode="decimal"
                      value={isian[s.silo_id]?.temp ?? ''}
                      onChange={(e) => ubah(s.silo_id, 'temp', e.target.value)}
                      placeholder="4,5"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Volume kosong SEKARANG tidak lagi mengunci input — operator yang
            mencatat jam mundur (mis. jam 9 tadi) tahu kondisi fisiknya saat
            itu lebih baik daripada angka volume saat ini. Sekadar pengingat,
            bukan penolakan. */}
        {silos.some((s) => s.volumeKosongSaatIni && isian[s.silo_id]?.ph) && (
          <div className="pesan pesan--info">
            Volume beberapa silo yang diisi menunjukkan 0 L saat ini — pastikan waktu cek yang
            dipilih di atas sudah sesuai kondisi fisik silo pada saat itu.
          </div>
        )}

        {phDiLuar.length > 0 && (
          <div className="pesan pesan--waspada">
            pH di luar rentang wajar pada {phDiLuar.map((s) => s.silo_name).join(', ')}.
            Data tetap dapat disimpan, tetapi penyimpangan ini akan tercatat.
          </div>
        )}

        <div className="baris">
          <span className="label">{terisi.length} dari {silos.length} silo terisi</span>
          <button className="btn btn--utama dorong" disabled={simpan.isPending || terisi.length === 0}>
            {simpan.isPending ? 'Menyimpan…' : `Simpan ronde (${terisi.length} silo)`}
          </button>
        </div>
      </div>
    </form>
  );
}
