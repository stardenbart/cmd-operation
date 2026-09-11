import { useEffect, useState } from 'react';
import { fmt, formatStandingTime, Lencana, Kosong } from './ui.jsx';

/*
 * Elemen visual dashboard yang dipakai bersama.
 *
 * Dashboard ber-login dan tautan publik read-only harus menampilkan bejana,
 * kartu silo, ringkasan stok, dan papan batch aktif yang SAMA PERSIS. Menaruh
 * markup-nya di satu tempat mencegah keduanya menyimpang - angka yang berbeda
 * untuk data yang sama adalah bug yang paling sulit disadari.
 *
 * `onPilih` opsional: bila diberikan, kartu/tombol dapat diklik (navigasi ke
 * detail); bila tidak, elemen dirender statis - itulah mode publik.
 */

/**
 * Bejana silo - elemen tanda tangan dashboard. Digambar tegak, terisi dari
 * bawah; pita bergaris di atas garis nominal adalah zona toleransi (BR-24).
 */
export function Bejana({ isi, nominal, toleransi }) {
  const batasKeras = nominal + toleransi;
  if (!batasKeras) return <div className="bejana" />;

  const pctTinggi = Math.min((isi / batasKeras) * 100, 100);
  const pctToleransi = (toleransi / batasKeras) * 100;
  const lampauiNominal = isi > nominal;
  const pctNominal = nominal ? Math.round((isi / nominal) * 100) : 0;

  return (
    <div className="bejana">
      {/* Elemen ini punya border-bottom sendiri (app.css) — pada height:0%
          border itu tetap tergambar sebagai garis tipis di puncak bejana.
          Toleransi yang dimatikan (switch off, migrasi 026 -> toleransi_ltr
          efektif 0) harus benar-benar TIDAK ADA di layar, bukan cuma setinggi
          0%, jadi elemen ini dilewati sama sekali saat toleransi <= 0. */}
      {toleransi > 0 && (
        <div className="bejana__toleransi" style={{ height: `${pctToleransi}%` }} />
      )}
      <div
        className={`bejana__isi${lampauiNominal ? ' bejana__isi--lampaui' : ''}${isi <= 0 ? ' bejana__isi--kosong' : ''}`}
        style={{ height: `${pctTinggi}%` }}
      />
      <div className="bejana__pct">{pctNominal}%</div>
    </div>
  );
}

const NADA_CEK = {
  OK: ['baik', 'Terpantau'],
  PERLU_DICEK: ['kritis', 'Perlu Dicek'],
  BELUM_PERNAH: ['waspada', 'Belum Dicek'],
  KOSONG: ['netral', 'Kosong'],
};

export function KartuSilo({ s, onPilih, besar = false }) {
  const [nada, teks] = NADA_CEK[s.status_cek] ?? ['netral', s.status_cek];
  const isi = Number(s.vol_aktual_ltr);
  const nominal = Number(s.kapasitas_maks_ltr);

  const isiKartu = (
    <>
      <Bejana isi={isi} nominal={nominal} toleransi={Number(s.toleransi_ltr)} />
      <div>
        <div className="silo__kepala">
          <div className="silo__nama">{s.silo_name}</div>
          {besar && <span className="silo__kelas">Kapasitas Besar</span>}
        </div>
        <div className="silo__vol">
          <b>{fmt(isi)}</b> <span>/ {fmt(nominal)} L</span>
        </div>

        <div className="silo__baris" style={{ marginTop: 10 }}>
          <Lencana nada={nada}>{teks}</Lencana>
        </div>

        <div className="silo__baris">
          <span className="label">Standing</span>
          <span className="angka">{formatStandingTime(s.standing_time_menit)}</span>
        </div>

        <div className="silo__baris">
          <span className="label">Batch</span>
          <span className="angka">{s.jumlah_batch_aktif}</span>
          {s.last_ph != null && (
            <>
              <span className="label" style={{ marginLeft: 6 }}>pH</span>
              <span className="angka">{Number(s.last_ph).toFixed(2)}</span>
            </>
          )}
        </div>

        {s.last_temp != null && (
          <div className="silo__baris silo__baris--suhu">
            <span className="label">Suhu</span>
            <span className="angka">{Number(s.last_temp).toFixed(1)}°</span>
          </div>
        )}

        {Boolean(s.dalam_toleransi) && (
          <div className="silo__baris">
            <Lencana nada="waspada">Melampaui Nominal</Lencana>
          </div>
        )}
      </div>
    </>
  );

  // Dapat diklik hanya bila ada tujuan; tanpa onPilih dirender statis (publik).
  if (!onPilih) {
    return <div className={`silo silo--statis${besar ? ' silo--besar' : ''}`}>{isiKartu}</div>;
  }
  return (
    <button type="button" className={`silo${besar ? ' silo--besar' : ''}`} onClick={() => onPilih(s)}>
      {isiKartu}
    </button>
  );
}

/**
 * Jam lokal berdenyut untuk angka yang berubah tanpa data berubah (standing
 * time). Berhenti saat tab tak terlihat - menghitung ulang layar yang tidak
 * dilihat siapa pun hanya menghabiskan baterai.
 */
export function useDenyut(jeda = 30_000, aktif = true) {
  const [, setTik] = useState(0);
  useEffect(() => {
    let id = null;
    const mulai = () => { if (id === null) id = setInterval(() => setTik((n) => n + 1), jeda); };
    const henti = () => { if (id !== null) { clearInterval(id); id = null; } };
    const saatBerubah = () => {
      if (!aktif || document.hidden) henti();
      else { setTik((n) => n + 1); mulai(); }
    };
    if (aktif && !document.hidden) mulai();
    document.addEventListener('visibilitychange', saatBerubah);
    return () => { henti(); document.removeEventListener('visibilitychange', saatBerubah); };
  }, [jeda, aktif]);
}

/** Menit berlalu sejak suatu titik waktu, dihitung di peramban. */
export function menitSejak(iso, cadangan = null, berjalan = true) {
  if (!berjalan) return cadangan;
  if (!iso) return cadangan;
  const mulai = new Date(iso).getTime();
  if (Number.isNaN(mulai)) return cadangan;
  return Math.max(0, Math.floor((Date.now() - mulai) / 60_000));
}

/** Rata-rata TS DITIMBANG VOLUME (bukan rata-rata biasa); batch tanpa TS dikeluarkan. */
export function rataTsTertimbang(baris) {
  let bobot = 0;
  let jumlah = 0;
  let volTanpaTs = 0;
  for (const b of baris) {
    if (b.nilaiTs === null || !(b.volumeLtr > 0)) {
      volTanpaTs += b.volumeLtr > 0 ? b.volumeLtr : 0;
      continue;
    }
    bobot += b.volumeLtr;
    jumlah += b.nilaiTs * b.volumeLtr;
  }
  return { nilai: bobot > 0 ? jumlah / bobot : null, volTanpaTs };
}

/** Kartu ringkasan stok: total tersimpan + isi buffer. */
export function RingkasanStok({ ringkasan, buffer, onBuffer, onKgBelumTerkonversi }) {
  const isiBuffer = buffer && (
    <>
      <div className="angka-besar">{fmt(buffer.vol_aktual_ltr)} L</div>
      <div className="label">Di buffer · {buffer.jumlah_batch_aktif} batch</div>
    </>
  );
  // Kg yang belum dapat dikonversi ke liter karena Berat Jenis Receiving-nya
  // masih kosong (lihat receivingGantung.js). Hanya tampil selagi ada backlog
  // — begitu Berat Jenis diisi, angka ini otomatis berkurang lewat polling
  // yang sudah berjalan, bukan lewat logic tambahan di sini.
  const adaKgBelumTerkonversi = Number(ringkasan.kgBelumTerkonversi) > 0;
  const isiKgBelumTerkonversi = (
    <>
      <div className="angka-besar">{fmt(ringkasan.kgBelumTerkonversi)} Kg</div>
      <div className="label">
        Menunggu Berat Jenis · {ringkasan.jumlahReceivingBelumTerkonversi} Receiving
      </div>
    </>
  );
  return (
    <div className="kartu dashboard-ringkasan">
      <div className="kartu__kepala">
        <h2>Stok tersimpan</h2>
        {ringkasan.perluDicek > 0 && (
          <Lencana nada="kritis">{ringkasan.perluDicek} Silo perlu dicek</Lencana>
        )}
        {ringkasan.melampauiNominal > 0 && (
          <Lencana nada="waspada">{ringkasan.melampauiNominal} Melampaui nominal</Lencana>
        )}
        {adaKgBelumTerkonversi && (
          <Lencana nada="waspada">
            {ringkasan.jumlahReceivingBelumTerkonversi} Receiving belum dikonversi
          </Lencana>
        )}
      </div>
      <div className="baris" style={{ gap: 32 }}>
        <div>
          <div className="angka-besar">{fmt(ringkasan.totalVolLtr)} L</div>
          <div className="label">Dari {fmt(ringkasan.totalKapasitasLtr)} L kapasitas</div>
        </div>
        {buffer && (onBuffer ? (
          <button
            type="button"
            className="btn btn--hantu"
            style={{ display: 'block', textAlign: 'left', height: 'auto', padding: 0 }}
            onClick={() => onBuffer(buffer)}
          >
            {isiBuffer}
          </button>
        ) : (
          <div>{isiBuffer}</div>
        ))}
        {adaKgBelumTerkonversi && (onKgBelumTerkonversi ? (
          <button
            type="button"
            className="btn btn--hantu"
            style={{ display: 'block', textAlign: 'left', height: 'auto', padding: 0 }}
            onClick={onKgBelumTerkonversi}
          >
            {isiKgBelumTerkonversi}
          </button>
        ) : (
          <div>{isiKgBelumTerkonversi}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * Grid silo penyimpanan. Komposisi visual diturunkan dari KAPASITAS (jurang
 * terbesar antar kapasitas), bukan daftar nama tetap, supaya tampilan ikut apa
 * pun isi master silo.
 */
export function SiloPenyimpanan({ penyimpanan, onPilih }) {
  const kapasitas = (s) => Number(s.kapasitas_maks_ltr) || 0;
  const terurut = [...penyimpanan].sort((a, b) => (a.urutan ?? 0) - (b.urutan ?? 0));
  const nilaiKapasitas = [...new Set(terurut.map(kapasitas).filter((n) => n > 0))]
    .sort((a, b) => a - b);

  let ambangBesar = 0;
  let lompatanTerbesar = 1;
  for (let i = 1; i < nilaiKapasitas.length; i += 1) {
    const lompatan = nilaiKapasitas[i] / nilaiKapasitas[i - 1];
    if (lompatan > lompatanTerbesar) {
      lompatanTerbesar = lompatan;
      ambangBesar = nilaiKapasitas[i];
    }
  }
  if (lompatanTerbesar < 2) ambangBesar = 0;

  const siloBesar = terurut.filter((s) => ambangBesar > 0 && kapasitas(s) >= ambangBesar);
  const siloKecil = terurut.filter((s) => !siloBesar.includes(s));
  const terkelompok = siloKecil.length > 0 && siloBesar.length > 0;

  return (
    <div>
      <div className="kartu__kepala"><h2>Silo penyimpanan</h2></div>
      {terkelompok ? (
        <div className="silo-layout silo-layout--kapasitas">
          <div className="silo-grid silo-grid--ringkas">
            {siloKecil.map((s) => <KartuSilo key={s.silo_id} s={s} onPilih={onPilih} />)}
          </div>
          <div className="silo-grid silo-grid--besar">
            {siloBesar.map((s) => <KartuSilo key={s.silo_id} s={s} besar onPilih={onPilih} />)}
          </div>
        </div>
      ) : (
        <div className="silo-grid">
          {penyimpanan.map((s) => <KartuSilo key={s.silo_id} s={s} onPilih={onPilih} />)}
        </div>
      )}
    </div>
  );
}

/** Papan batch aktif per silo (murni; data diberikan pemanggil). */
export function PapanBatchAktif({ baris, live = true }) {
  useDenyut(30_000, live);

  if (!baris || baris.length === 0) {
    return <Kosong>Tidak ada batch aktif di silo mana pun.</Kosong>;
  }

  const perSilo = [];
  for (const b of baris) {
    const akhir = perSilo[perSilo.length - 1];
    if (akhir && akhir.siloId === b.siloId) akhir.baris.push(b);
    else {
      perSilo.push({
        siloId: b.siloId,
        siloName: b.siloName,
        standingSiloMenit: b.standingSiloMenit,
        standingSiloSejak: b.standingSiloSejak,
        baris: [b],
      });
    }
  }

  const totalLtr = baris.reduce((s, b) => s + b.volumeLtr, 0);
  const tsSemua = rataTsTertimbang(baris);
  const ts = (v) => (v === null ? '—' : v.toFixed(2));
  const st = (v) => (v === null ? '—' : formatStandingTime(v));

  return (
    <div className="kartu tumpuk">
      <table className="tabel">
        <thead>
          <tr>
            <th>Silo</th>
            <th>Nama supplier</th>
            <th>Batch</th>
            <th className="num">Volume (L)</th>
            <th className="num">Nilai TS</th>
            <th className="num">Standing time batch</th>
            <th className="num">Standing time silo</th>
          </tr>
        </thead>

        {perSilo.map((s) => {
          const subLtr = s.baris.reduce((n, b) => n + b.volumeLtr, 0);
          const subTs = rataTsTertimbang(s.baris);
          return (
            <tbody key={s.siloId}>
              {s.baris.map((b, i) => (
                <tr key={b.prepastId}>
                  <td style={{ fontWeight: i === 0 ? 600 : 400 }}>
                    {i === 0 ? s.siloName : ''}
                  </td>
                  <td>{b.supplierName ?? 'Tidak diketahui'}</td>
                  <td className="angka">{b.batchKode}</td>
                  <td className="num">{fmt(b.volumeLtr)}</td>
                  <td className="num">{b.nilaiTs === null ? '—' : b.nilaiTs}</td>
                  <td className="num">
                    {st(menitSejak(b.prepastFinishIso, b.standingMenit, live))}
                  </td>
                  <td className="num">
                    {i === 0 ? st(menitSejak(s.standingSiloSejak, s.standingSiloMenit, live)) : ''}
                  </td>
                </tr>
              ))}

              <tr style={{ background: 'var(--gridline, #f2f2f2)' }}>
                <th colSpan={3} style={{ textAlign: 'right' }}>
                  Subtotal {s.siloName} · {s.baris.length} batch
                </th>
                <th className="num">{fmt(subLtr)}</th>
                <th className="num" title="Rata-rata ditimbang volume">
                  {ts(subTs.nilai)}
                  {subTs.volTanpaTs > 0 && (
                    <span className="bantuan"> ({fmt(subTs.volTanpaTs)} L tanpa TS)</span>
                  )}
                </th>
                <th />
                <th className="num">
                  {st(menitSejak(s.standingSiloSejak, s.standingSiloMenit, live))}
                </th>
              </tr>
            </tbody>
          );
        })}

        <tfoot>
          <tr>
            <th colSpan={3} style={{ textAlign: 'right' }}>
              Total keseluruhan · {baris.length} batch di {perSilo.length} silo
            </th>
            <th className="num">{fmt(totalLtr)}</th>
            <th className="num" title="Rata-rata ditimbang volume">
              {ts(tsSemua.nilai)}
              {tsSemua.volTanpaTs > 0 && (
                <span className="bantuan"> ({fmt(tsSemua.volTanpaTs)} L tanpa TS)</span>
              )}
            </th>
            <th colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
