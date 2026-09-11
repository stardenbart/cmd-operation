import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { fmt, Field, Lencana, PesanGalat, PesanSukses } from '../components/ui.jsx';

const angka = (v) => parseFloat(String(v).replace(',', '.'));

const MODE_BATCH = {
  SAMA: 'SAMA',
  MANUAL: 'MANUAL',
};

const barisKosong = () => ({
  trfTime: '', siloAsalId: '', jenis: 'PEMAKAIAN PRODUKSI', volumeLtr: '',
  tankId: '', siloTujuanId: '', batchPrefix: '', batchNomor: '',
});

/**
 * Satu baris transfer - satu silo asal ke satu tujuan.
 *
 * Beberapa baris dapat diisi sekaligus (seperti Prepast multi-silo): operator
 * memindahkan susu ke beberapa MT dari silo berbeda dalam satu kali submit.
 * Mode SAMA memakai waktu bersama; mode MANUAL menyimpan waktu tiap baris.
 */
function BarisTransfer({
  index, baris, silos, modeBatch, batchBersama,
  onUbah, onHapus, bisaHapus,
}) {
  const { data: ctx } = useQuery({
    queryKey: ['transfer', 'form-context', baris.siloAsalId],
    queryFn: () => api.get(`/transfer/form-context/${baris.siloAsalId}`),
    enabled: Boolean(baris.siloAsalId),
  });

  const asal = silos?.data.find((s) => String(s.silo_id) === String(baris.siloAsalId));
  const keProduksi = baris.jenis === 'PEMAKAIAN PRODUKSI';
  const tankTerpilih = ctx?.tanks.find((t) => String(t.id) === String(baris.tankId));
  const aturanBatch = tankTerpilih?.aturan_batch ?? null;

  // Pratinjau kapasitas Pindah Silo — sekadar peringatan, bukan penolakan
  // (lihat catatan di transfer.js). Dihitung dari data yang sudah dimuat
  // untuk pilihan silo tujuan, tanpa permintaan tambahan.
  const siloTujuanTerpilih = ctx?.siloTujuan.find((s) => String(s.silo_id) === String(baris.siloTujuanId));
  const volumeDiketik = angka(baris.volumeLtr);
  const pratinjauLewatKapasitas = (!keProduksi && siloTujuanTerpilih && volumeDiketik > 0
    && volumeDiketik > Number(siloTujuanTerpilih.vol_tersedia_ltr))
    ? {
      sisaNominalLtr: Number(siloTujuanTerpilih.vol_tersedia_ltr),
      batasKerasLtr: Number(siloTujuanTerpilih.vol_tersedia_toleransi_ltr),
      melebihiBatasKeras: volumeDiketik > Number(siloTujuanTerpilih.vol_tersedia_toleransi_ltr),
    }
    : null;

  const set = (k) => (e) => onUbah(index, { ...baris, [k]: e.target.value });

  return (
    <div className="transfer-baris kartu tumpuk">
      <div className="kartu__kepala">
        <h3 style={{ fontSize: 15, margin: 0 }}>Transfer {index + 1}</h3>
        <button
          type="button"
          className="btn btn--bahaya btn--kecil dorong"
          onClick={() => onHapus(index)}
          disabled={!bisaHapus}
          aria-label={`Hapus transfer baris ${index + 1}`}
        >
          Hapus
        </button>
      </div>

      <div className="form-grid">
        {modeBatch === MODE_BATCH.MANUAL && (
          <Field label="Waktu transfer" wajib bantuan={`Khusus Transfer ${index + 1}`}>
            <input
              type="datetime-local"
              value={baris.trfTime}
              onChange={set('trfTime')}
              required
            />
          </Field>
        )}

        <Field label="Silo asal" wajib>
          <select value={baris.siloAsalId} onChange={set('siloAsalId')} required>
            <option value="">Pilih silo</option>
            {silos?.data.filter((s) => !s.is_buffer && Number(s.vol_aktual_ltr) > 0).map((s) => (
              <option key={s.silo_id} value={s.silo_id}>
                {s.silo_name} · {fmt(s.vol_aktual_ltr)} L
              </option>
            ))}
          </select>
        </Field>

        <Field label="Jenis" wajib>
          <select value={baris.jenis} onChange={set('jenis')}>
            <option value="PEMAKAIAN PRODUKSI">Pemakaian produksi</option>
            <option value="PINDAH SILO">Pindah silo</option>
          </select>
        </Field>

        <Field label="Volume (L)" wajib bantuan={asal ? `Tersedia ${fmt(asal.vol_aktual_ltr)} L` : undefined}>
          <input className="angka-input" inputMode="decimal" value={baris.volumeLtr} onChange={set('volumeLtr')} required />
        </Field>

        {keProduksi ? (
          <>
            <Field label="Tank tujuan" wajib>
              <select value={baris.tankId} onChange={set('tankId')} required>
                <option value="">Pilih tank</option>
                {ctx?.tanks.map((t) => (
                  <option key={t.id} value={t.id}>{t.tank_name}</option>
                ))}
              </select>
            </Field>

            {aturanBatch === 'TETAP_CMD2' && (
              <Field label="Batch" bantuan="Ditentukan tangkinya, tidak dapat diubah">
                <input value="CMD2" readOnly disabled />
              </Field>
            )}
            {aturanBatch === 'TANPA_BATCH' && (
              <Field label="Batch" bantuan="Pengosongan silo bukan produksi, jadi tidak berbatch">
                <input value="Tidak berbatch" readOnly disabled />
              </Field>
            )}
            {aturanBatch === 'PILIH' && (
              <Field label="Batch" wajib bantuan="Prefiks dipilih, nomor diketik">
                {modeBatch === MODE_BATCH.SAMA ? (
                  <input
                    value={batchBersama.batchPrefix && batchBersama.batchNomor
                      ? `${batchBersama.batchPrefix}${batchBersama.batchNomor}`
                      : 'Isi Batch bersama di bagian atas'}
                    readOnly
                    disabled
                  />
                ) : (
                  <div className="baris" style={{ gap: 8, flexWrap: 'nowrap' }}>
                    <select value={baris.batchPrefix} onChange={set('batchPrefix')} required style={{ flex: 1 }}>
                      <option value="">Prefiks</option>
                      {ctx?.prefiksBatch.map((p) => (
                        <option key={p.kode} value={p.kode}>
                          {p.kode}{p.is_standar ? '' : ' (non-baku)'}
                        </option>
                      ))}
                    </select>
                    <input
                      className="angka-input" inputMode="numeric" style={{ width: 90 }}
                      value={baris.batchNomor} onChange={set('batchNomor')} placeholder="5"
                      required
                    />
                  </div>
                )}
              </Field>
            )}
          </>
        ) : (
          <Field label="Silo tujuan" wajib>
            <select value={baris.siloTujuanId} onChange={set('siloTujuanId')} required>
              <option value="">Pilih silo</option>
              {ctx?.siloTujuan.map((s) => (
                <option key={s.silo_id} value={s.silo_id}>
                  {s.silo_name} · sisa {fmt(s.vol_tersedia_ltr)} L
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {!keProduksi && pratinjauLewatKapasitas && (
        // Kapasitas nominal tidak lagi memblokir Pindah Silo (keputusan
        // operasional) — ini murni peringatan supaya operator sadar sebelum
        // submit, bukan penolakan. Transfer tetap bisa disimpan.
        <div className="pesan pesan--waspada">
          Volume {fmt(angka(baris.volumeLtr))} L melebihi sisa nominal {siloTujuanTerpilih.silo_name}
          {' '}({fmt(pratinjauLewatKapasitas.sisaNominalLtr)} L).
          {pratinjauLewatKapasitas.melebihiBatasKeras
            ? ` Bahkan melewati batas keras (${fmt(pratinjauLewatKapasitas.batasKerasLtr)} L) — tetap dapat disimpan, tercatat sebagai pengecualian.`
            : ' Masih dalam toleransi — akan tercatat sebagai pengecualian nominal.'}
        </div>
      )}
    </div>
  );
}

/** Apakah satu baris cukup lengkap untuk dikirim. */
function nomorBatchValid(nilai) {
  const nomor = Number(String(nilai ?? '').trim());
  return Number.isInteger(nomor) && nomor > 0;
}

function barisValid(b, tanks, modeBatch, batchBersama) {
  if (modeBatch === MODE_BATCH.MANUAL && !b.trfTime) return false;
  if (!b.siloAsalId || !(angka(b.volumeLtr) > 0)) return false;
  if (b.jenis === 'PEMAKAIAN PRODUKSI') {
    if (!b.tankId) return false;
    const tank = tanks?.find((t) => String(t.id) === String(b.tankId));
    if (!tank) return false;
    if (tank.aturan_batch === 'PILIH') {
      const sumber = modeBatch === MODE_BATCH.SAMA ? batchBersama : b;
      return Boolean(sumber.batchPrefix) && nomorBatchValid(sumber.batchNomor);
    }
    return true;
  }
  return Boolean(b.siloTujuanId);
}

export default function Transfer() {
  const qc = useQueryClient();
  const [trfTime, setTrfTime] = useState('');
  const [rows, setRows] = useState([barisKosong()]);
  const [modeBatch, setModeBatch] = useState(MODE_BATCH.SAMA);
  const [batchBersama, setBatchBersama] = useState({ batchPrefix: '', batchNomor: '' });
  const [sukses, setSukses] = useState(null);

  const { data: silos } = useQuery({ queryKey: ['silos'], queryFn: () => api.get('/silos') });
  // Prefiks batch dan aturan tank bersifat global. Form-context silo pertama
  // dipakai sebagai sumbernya agar endpoint baru tidak diperlukan.
  const siloKonteks = rows.find((r) => r.siloAsalId)?.siloAsalId;
  const { data: konteksBatch } = useQuery({
    queryKey: ['transfer', 'form-context', siloKonteks],
    queryFn: () => api.get(`/transfer/form-context/${siloKonteks}`),
    enabled: Boolean(siloKonteks),
  });

  const simpan = useMutation({
    mutationFn: (body) => api.post('/transfer/batch', body),
    onSuccess: (res) => {
      const t = res.data.transfers;
      const lewatKapasitas = t.filter((x) => x.melampauiNominalTujuan);
      setSukses(
        `${t.length} transfer tersimpan: ${t.map((x) => x.kode).join(', ')}. ` +
        `Total ${fmt(t.reduce((s, x) => s + Number(x.volumeLtr), 0))} L.` +
        (lewatKapasitas.length > 0
          ? ` Perhatian — ${lewatKapasitas.length} tercatat melebihi kapasitas nominal tujuan: ${
            lewatKapasitas.map((x) => `${x.melampauiNominalTujuan.siloName} (+${fmt(x.melampauiNominalTujuan.kelebihanLtr)} L${x.melampauiNominalTujuan.melebihiBatasKeras ? ', lewat batas keras' : ''})`).join('; ')
          }.`
          : ''),
      );
      setRows([barisKosong()]);
      setTrfTime('');
      setBatchBersama({ batchPrefix: '', batchNomor: '' });
      qc.invalidateQueries({ queryKey: ['silos'] });
      qc.invalidateQueries({ queryKey: ['transfer'] });
    },
  });

  const ubahBaris = (i, nilai) => setRows(rows.map((r, idx) => (idx === i ? nilai : r)));
  const hapusBaris = (i) => setRows(rows.filter((_, idx) => idx !== i));
  const tambahBaris = () => setRows([...rows, barisKosong()]);

  // Peringatan bila total volume per silo melampaui yang tersedia. Server tetap
  // menegakkan FIFO; ini hanya memberi tahu lebih awal sebelum submit.
  const totalPerSilo = new Map();
  for (const r of rows) {
    if (!r.siloAsalId) continue;
    totalPerSilo.set(r.siloAsalId, (totalPerSilo.get(r.siloAsalId) ?? 0) + (angka(r.volumeLtr) || 0));
  }
  const siloLebih = [...totalPerSilo.entries()].filter(([id, total]) => {
    const s = silos?.data.find((x) => String(x.silo_id) === String(id));
    return s && total > Number(s.vol_aktual_ltr);
  }).map(([id]) => silos?.data.find((x) => String(x.silo_id) === String(id))?.silo_name);

  const semuaValid = rows.length > 0 && rows.every((r) => barisValid(
    r, konteksBatch?.tanks, modeBatch, batchBersama,
  ));
  const waktuValid = modeBatch === MODE_BATCH.SAMA ? Boolean(trfTime) : true;
  const bisaKirim = waktuValid && semuaValid && siloLebih.length === 0 && !simpan.isPending;

  function kirim(e) {
    e.preventDefault();
    setSukses(null);
    simpan.mutate({
      modeBatch,
      ...(modeBatch === MODE_BATCH.SAMA ? { trfTime, batchBersama } : {}),
      baris: rows.map((r) => ({
        ...(modeBatch === MODE_BATCH.MANUAL ? { trfTime: r.trfTime } : {}),
        siloAsalId: Number(r.siloAsalId),
        jenis: r.jenis,
        volumeLtr: r.volumeLtr,
        ...(r.jenis === 'PEMAKAIAN PRODUKSI'
          ? {
            tankId: Number(r.tankId),
            ...(modeBatch === MODE_BATCH.MANUAL
              ? { batchPrefix: r.batchPrefix, batchNomor: r.batchNomor }
              : {}),
          }
          : { siloTujuanId: Number(r.siloTujuanId) }),
      })),
    });
  }

  return (
    <form className="tumpuk" onSubmit={kirim}>
      <div className="kartu tumpuk">
        <div className="kartu__kepala">
          <h2>Transfer keluar silo</h2>
          <span className="label">Beberapa transfer dalam satu kali submit</span>
        </div>

        <PesanSukses>{sukses}</PesanSukses>
        <PesanGalat galat={simpan.error} onTutup={() => simpan.reset()} />

        <div className="form-grid">
          <Field label="Cara pengisian transfer" wajib>
            <select value={modeBatch} onChange={(e) => setModeBatch(e.target.value)}>
              <option value={MODE_BATCH.SAMA}>Batch sama untuk transfer tambahan</option>
              <option value={MODE_BATCH.MANUAL}>Isi manual setiap transfer</option>
            </select>
          </Field>
          {modeBatch === MODE_BATCH.SAMA && (
            <>
              <Field label="Waktu transfer" wajib bantuan="Berlaku untuk semua baris">
                <input
                  type="datetime-local"
                  value={trfTime}
                  onChange={(e) => setTrfTime(e.target.value)}
                  required
                />
              </Field>
              <Field
                label="Batch bersama"
                bantuan="Dipakai semua transfer ke tank yang aturan batch-nya PILIH"
              >
                <div className="baris" style={{ gap: 8, flexWrap: 'nowrap' }}>
                  <select
                    value={batchBersama.batchPrefix}
                    onChange={(e) => setBatchBersama((lama) => ({
                      ...lama, batchPrefix: e.target.value,
                    }))}
                    disabled={!siloKonteks}
                    style={{ flex: 1 }}
                  >
                    <option value="">{siloKonteks ? 'Prefiks' : 'Pilih silo asal dahulu'}</option>
                    {konteksBatch?.prefiksBatch.map((p) => (
                      <option key={p.kode} value={p.kode}>
                        {p.kode}{p.is_standar ? '' : ' (non-baku)'}
                      </option>
                    ))}
                  </select>
                  <input
                    className="angka-input"
                    inputMode="numeric"
                    style={{ width: 90 }}
                    value={batchBersama.batchNomor}
                    onChange={(e) => setBatchBersama((lama) => ({
                      ...lama, batchNomor: e.target.value,
                    }))}
                    placeholder="5"
                    disabled={!siloKonteks}
                  />
                </div>
              </Field>
            </>
          )}
        </div>
      </div>

      {rows.map((r, i) => (
        <BarisTransfer
          key={i}
          index={i}
          baris={r}
          silos={silos}
          modeBatch={modeBatch}
          batchBersama={batchBersama}
          onUbah={ubahBaris}
          onHapus={hapusBaris}
          bisaHapus={rows.length > 1}
        />
      ))}

      {siloLebih.length > 0 && (
        <div className="pesan pesan--waspada">
          Total volume melebihi yang tersedia di: {siloLebih.join(', ')}. Kurangi
          volumenya sebelum menyimpan.
        </div>
      )}

      <div className="baris">
        <button type="button" className="btn btn--kedua btn--kecil" onClick={tambahBaris}>
          Tambah transfer
        </button>
        <button className="btn btn--utama dorong" disabled={!bisaKirim}>
          {simpan.isPending ? 'Menyimpan…' : `Simpan ${rows.length} transfer`}
        </button>
      </div>
    </form>
  );
}
