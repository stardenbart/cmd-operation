import { useId, useState } from 'react';
import { fmt } from './ui.jsx';

/**
 * Perangkat grafik SVG - FR-27.4, FR-27.5
 *
 * Digambar sendiri, tanpa pustaka grafik. Dua alasan, dan keduanya bukan
 * penghematan:
 *
 *  1. Sistem ini dipasang on-prem dan tidak boleh bergantung pada jaringan
 *     luar pada jalur kritisnya. Satu pustaka grafik berarti satu dependensi
 *     besar lagi yang harus ikut dibawa, diperbarui, dan diaudit.
 *  2. FR-27.5 menuntut aturan warna yang ketat: seri diwarnai menurut
 *     ENTITAS bukan peringkat, palet dipakai berurutan dan tidak pernah
 *     diputar, dan warna status tidak pernah menjadi warna seri. Pustaka
 *     umumnya memutar paletnya sendiri, dan melawan perilaku itu biasanya
 *     lebih rumit daripada menggambar sumbu sendiri.
 */

/**
 * Palet Okabe-Ito.
 *
 * Dipilih karena memang dirancang agar terbedakan pada ketiga jenis buta warna
 * yang umum (FR-27.5.6), bukan karena enak dilihat. Urutannya disusun ulang
 * supaya warna yang kontrasnya rendah di atas latar terang tidak kebagian
 * giliran pertama.
 */
const PALET = [
  '#0072B2', // biru
  '#E69F00', // oranye
  '#009E73', // hijau kebiruan
  '#CC79A7', // ungu kemerahan
  '#56B4E9', // biru langit
  '#D55E00', // vermilion
  '#8C6D31', // cokelat
  '#5A5A5A', // abu tua
];

/**
 * Warna seri menurut KUNCI, bukan menurut urutan tampil - FR-27.5.2.
 *
 * Peta ini hidup selama halaman terbuka, jadi menyaring satu silo tidak
 * mengecat ulang silo lainnya. Warna yang berpindah saat filter berubah
 * membuat pembacanya menyimpulkan hal yang salah dari grafik yang sama.
 */
const petaWarna = new Map();
export function warnaSeri(kunci) {
  if (!petaWarna.has(kunci)) {
    petaWarna.set(kunci, PALET[petaWarna.size % PALET.length]);
  }
  return petaWarna.get(kunci);
}

/** Warna keadaan. TIDAK PERNAH dipakai sebagai warna seri (FR-27.5.4). */
const NADA = {
  baik: 'var(--status-good, #2f855a)',
  waspada: 'var(--status-warning, #d69e2e)',
  kritis: 'var(--status-critical, #c53030)',
};

const P = { atas: 16, kanan: 16, bawah: 34, kiri: 56 };

const skala = (nilai, min, maks, panjang) =>
  maks === min ? panjang / 2 : ((nilai - min) / (maks - min)) * panjang;

/** Sumbu, kisi, dan label. Dipakai seluruh grafik berbasis kartesius. */
function Kerangka({ lebar, tinggi, yMin, yMaks, tikY, children, satuan }) {
  const w = lebar - P.kiri - P.kanan;
  const h = tinggi - P.atas - P.bawah;

  return (
    <g>
      {tikY.map((t) => {
        const y = P.atas + h - skala(t, yMin, yMaks, h);
        return (
          <g key={t}>
            <line
              x1={P.kiri} x2={lebar - P.kanan} y1={y} y2={y}
              stroke="var(--gridline)" strokeWidth="1"
            />
            <text
              x={P.kiri - 6} y={y + 4} textAnchor="end"
              fontSize="10" fill="var(--text-secondary)"
            >
              {/* Desimal ditampilkan bila tiknya memang pecahan. Membulatkannya
                  membuat langkah 2,5 tampil sebagai 80-83-85-88-90, yang
                  terbaca sebagai jarak tik yang tidak rata. */}
              {fmt(t, Number.isInteger(t) ? 0 : 1)}
            </text>
          </g>
        );
      })}
      {satuan && (
        <text x={P.kiri - 6} y={P.atas - 4} textAnchor="end" fontSize="10" fill="var(--text-secondary)">
          {satuan}
        </text>
      )}
      {children}
    </g>
  );
}

/** Tik sumbu-Y yang bulat, supaya angkanya terbaca. */
function tikBulat(min, maks, jumlah = 4) {
  if (maks === min) return [min];
  const kasar = (maks - min) / jumlah;
  const pangkat = 10 ** Math.floor(Math.log10(kasar));
  const langkah = [1, 2, 2.5, 5, 10].map((m) => m * pangkat).find((m) => m >= kasar) ?? pangkat * 10;
  const awal = Math.floor(min / langkah) * langkah;
  const tik = [];
  for (let v = awal; v <= maks + langkah / 2; v += langkah) tik.push(Number(v.toFixed(6)));
  return tik;
}

const TOOLTIP_W = 190;
const TOOLTIP_H = 132;

function Tooltip({ isi, x, y, lebar, tinggi }) {
  if (!isi) return null;
  /*
   * Kotak dijaga tetap utuh di dalam bidang gambar, mendatar DAN tegak.
   * foreignObject memotong isinya pada batas width/height-nya, jadi ukurannya
   * dibuat cukup untuk isi terpanjang (nama silo + beberapa baris seri), lalu
   * posisinya di-clamp supaya tidak melewati tepi SVG dan terpotong saat hover
   * di pinggir kanan atau bawah.
   */
  const kiri = Math.min(Math.max(0, x + 12), Math.max(0, lebar - TOOLTIP_W));
  const atas = tinggi
    ? Math.min(Math.max(0, y - 10), Math.max(0, tinggi - TOOLTIP_H))
    : Math.max(0, y - 10);
  return (
    <foreignObject
      x={kiri} y={atas} width={TOOLTIP_W} height={TOOLTIP_H}
      pointerEvents="none" style={{ overflow: 'visible' }}
    >
      <div className="grafik__tooltip">{isi}</div>
    </foreignObject>
  );
}

/** Bungkus: judul, pertanyaan yang dijawab, dan sakelar tabel (FR-27.1.4). */
export function Panel({ judul, pertanyaan, anakGrafik, anakTabel, kosong }) {
  const [tabel, setTabel] = useState(false);

  return (
    <div className="kartu grafik">
      <div className="kartu__kepala">
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>{judul}</h3>
          {/* Pertanyaannya ditampilkan, bukan disembunyikan: panel yang tidak
              menjawab pertanyaan apa pun seharusnya tidak ada (FR-27.1.1). */}
          <div className="bantuan">{pertanyaan}</div>
        </div>
        <button
          type="button"
          className="btn btn--hantu btn--kecil dorong"
          onClick={() => setTabel(!tabel)}
        >
          {tabel ? 'Lihat grafik' : 'Lihat tabel'}
        </button>
      </div>
      {kosong ? (
        <div className="kosong">Tidak ada data pada rentang ini.</div>
      ) : tabel ? anakTabel : anakGrafik}
    </div>
  );
}

/** Legenda seri. Warna selalu disertai label, tidak pernah warna saja. */
export function Legenda({ seri }) {
  return (
    <div className="grafik__legenda">
      {seri.map((s) => (
        <span key={s.kunci}>
          <i style={{ background: warnaSeri(s.kunci) }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Garis kategori (mis. neraca harian): sumbu-X berupa label, bukan waktu. */
export function Garis({ data, seri, satuan, tinggi = 220 }) {
  const [sorot, setSorot] = useState(null);
  const lebar = 760;
  const w = lebar - P.kiri - P.kanan;
  const h = tinggi - P.atas - P.bawah;

  const semua = data.flatMap((d) => seri.map((s) => d[s.kunci] ?? 0));
  const maks = Math.max(...semua, 1);
  const tik = tikBulat(0, maks);
  const yMaks = tik.at(-1);

  const x = (i) => P.kiri + (data.length === 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v) => P.atas + h - skala(v ?? 0, 0, yMaks, h);

  return (
    <>
      <svg viewBox={`0 0 ${lebar} ${tinggi}`} className="grafik__svg" role="img">
        <Kerangka lebar={lebar} tinggi={tinggi} yMin={0} yMaks={yMaks} tikY={tik} satuan={satuan}>
          {seri.map((s) => (
            <polyline
              key={s.kunci}
              fill="none"
              stroke={warnaSeri(s.kunci)}
              strokeWidth="2"
              points={data.map((d, i) => `${x(i)},${y(d[s.kunci])}`).join(' ')}
            />
          ))}
          {sorot !== null && (
            <line
              x1={x(sorot)} x2={x(sorot)} y1={P.atas} y2={P.atas + h}
              stroke="var(--text-secondary)" strokeDasharray="3 3"
            />
          )}
          {data.map((d, i) => (
            <g key={d.label}>
              {seri.map((s) => (
                <circle
                  key={s.kunci} cx={x(i)} cy={y(d[s.kunci])} r={sorot === i ? 4 : 2.5}
                  fill={warnaSeri(s.kunci)}
                />
              ))}
              <rect
                x={x(i) - w / Math.max(data.length, 1) / 2} y={P.atas}
                width={w / Math.max(data.length, 1)} height={h}
                fill="transparent"
                onMouseEnter={() => setSorot(i)}
                onMouseLeave={() => setSorot(null)}
              />
            </g>
          ))}
          {data.map((d, i) =>
            i % Math.ceil(data.length / 8) === 0 ? (
              <text
                key={`l${d.label}`} x={x(i)} y={tinggi - 12} textAnchor="middle"
                fontSize="10" fill="var(--text-secondary)"
              >
                {String(d.label).slice(5)}
              </text>
            ) : null,
          )}
          {sorot !== null && (
            <Tooltip
              lebar={lebar} tinggi={tinggi} x={x(sorot)} y={P.atas}
              isi={
                <>
                  <b>{String(data[sorot].label).slice(0, 10)}</b>
                  {seri.map((s) => (
                    <div key={s.kunci}>
                      {s.label}: {fmt(data[sorot][s.kunci] ?? 0)} {satuan}
                    </div>
                  ))}
                </>
              }
            />
          )}
        </Kerangka>
      </svg>
      <Legenda seri={seri} />
    </>
  );
}

/** Deret waktu (mis. suhu per silo), dengan pita aman dan garis ambang. */
export function GarisWaktu({ seri, satuan, pita, ambang, tinggi = 220 }) {
  const [sorot, setSorot] = useState(null);
  const lebar = 760;
  const w = lebar - P.kiri - P.kanan;
  const h = tinggi - P.atas - P.bawah;

  const titik = seri.flatMap((s) => s.titik);
  if (titik.length === 0) return <div className="kosong">Tidak ada data.</div>;

  const waktuMs = titik.map((t) => new Date(t.waktu).getTime());
  const tMin = Math.min(...waktuMs);
  const tMaks = Math.max(...waktuMs);

  const nilai = titik.map((t) => t.nilai);
  const batasBawah = Math.min(...nilai, pita?.min ?? Infinity, ambang ?? Infinity);
  const batasAtas = Math.max(...nilai, pita?.maks ?? -Infinity, ambang ?? -Infinity);
  const bantal = (batasAtas - batasBawah) * 0.1 || 1;
  const tik = tikBulat(batasBawah - bantal, batasAtas + bantal);
  const yMin = tik[0];
  const yMaks = tik.at(-1);

  const x = (ms) => P.kiri + (tMaks === tMin ? w / 2 : ((ms - tMin) / (tMaks - tMin)) * w);
  const y = (v) => P.atas + h - skala(v, yMin, yMaks, h);

  return (
    <>
      <svg viewBox={`0 0 ${lebar} ${tinggi}`} className="grafik__svg" role="img">
        <Kerangka lebar={lebar} tinggi={tinggi} yMin={yMin} yMaks={yMaks} tikY={tik} satuan={satuan}>
          {pita && (
            <rect
              x={P.kiri} y={y(pita.maks)} width={w} height={Math.abs(y(pita.min) - y(pita.maks))}
              fill="var(--status-good, #2f855a)" opacity="0.08"
            />
          )}
          {ambang !== undefined && ambang !== null && (
            <>
              <line
                x1={P.kiri} x2={lebar - P.kanan} y1={y(ambang)} y2={y(ambang)}
                stroke={NADA.kritis} strokeWidth="1.5" strokeDasharray="5 3"
              />
              <text
                x={lebar - P.kanan} y={y(ambang) - 4} textAnchor="end"
                fontSize="10" fill={NADA.kritis}
              >
                ambang {ambang} {satuan}
              </text>
            </>
          )}
          {seri.map((s) => (
            <g key={s.kunci}>
              <polyline
                fill="none" stroke={warnaSeri(s.kunci)} strokeWidth="1.8"
                points={s.titik.map((t) => `${x(new Date(t.waktu).getTime())},${y(t.nilai)}`).join(' ')}
              />
              {s.titik.map((t, i) => (
                <circle
                  key={`${s.kunci}${i}`}
                  cx={x(new Date(t.waktu).getTime())} cy={y(t.nilai)}
                  r={t.kritis ? 4.5 : 2.5}
                  fill={t.kritis ? NADA.kritis : warnaSeri(s.kunci)}
                  stroke={t.kritis ? 'white' : 'none'} strokeWidth={t.kritis ? 1 : 0}
                  onMouseEnter={() => setSorot({ ...t, seri: s.label })}
                  onMouseLeave={() => setSorot(null)}
                />
              ))}
            </g>
          ))}
          {sorot && (
            <Tooltip
              lebar={lebar} tinggi={tinggi}
              x={x(new Date(sorot.waktu).getTime())}
              y={y(sorot.nilai)}
              isi={
                <>
                  <b>{sorot.siloName ?? sorot.seri}</b>
                  <div>{fmt(sorot.nilai, 2)} {satuan}</div>
                  <div className="bantuan">
                    {new Date(sorot.waktu).toLocaleString('id-ID', {
                      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                    })}
                  </div>
                  {sorot.kritis && <div style={{ color: NADA.kritis }}>di bawah ambang</div>}
                </>
              }
            />
          )}
        </Kerangka>
      </svg>
      <Legenda seri={seri} />
    </>
  );
}

/** Batang mendatar, dengan penanda rata-rata atau zona ambang. */
export function Batang({ data, satuan, penanda, zona, tinggi }) {
  const lebar = 760;
  const tinggiBaris = 26;
  const h = data.length * tinggiBaris;
  const totalTinggi = tinggi ?? h + P.atas + P.bawah;
  /*
   * Ruang label nilai disisakan di kanan, bukan hanya P.kanan.
   *
   * Label nilai dicetak di UJUNG batang. Batang terpanjang mendekati lebar
   * penuh, sehingga dengan P.kanan yang cuma 16 px, angka seperti "209" atau
   * "600.000" meluber keluar panel. Menyisakan ~52 px membuat label batang
   * termaksimal pun tetap muat, dengan ongkos batang sedikit lebih pendek.
   */
  const RUANG_LABEL = 52;
  /*
   * Batang mendatar memakai label ENTITAS di kiri (nama silo, supplier, seri),
   * bukan angka pendek seperti grafik lain. P.kiri=56 hanya memuat ~8 karakter;
   * nama seperti "Aneka Karya Boyolali" akan melewati tepi kiri SVG dan
   * terpotong. Marginnya diperlebar khusus untuk grafik ini.
   */
  const KIRI = 132;
  const w = lebar - KIRI - RUANG_LABEL;
  const potongLabel = (t) => (String(t).length > 20 ? `${String(t).slice(0, 19)}…` : String(t));

  const maks = Math.max(...data.map((d) => d.nilai), penanda?.nilai ?? 0, 1);
  const tik = tikBulat(0, maks);
  const xMaks = tik.at(-1);

  const nadaZona = (nilai) => {
    if (!zona) return null;
    for (const z of zona) if (z.sampai === null || nilai <= z.sampai) return z.nada;
    return null;
  };

  return (
    <>
      <svg viewBox={`0 0 ${lebar} ${totalTinggi}`} className="grafik__svg" role="img">
        {tik.map((t) => (
          <g key={t}>
            <line
              x1={KIRI + skala(t, 0, xMaks, w)} x2={KIRI + skala(t, 0, xMaks, w)}
              y1={P.atas} y2={P.atas + h} stroke="var(--gridline)"
            />
            <text
              x={KIRI + skala(t, 0, xMaks, w)} y={P.atas + h + 14} textAnchor="middle"
              fontSize="10" fill="var(--text-secondary)"
            >
              {fmt(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const nada = nadaZona(d.nilai);
          return (
            // Kunci disertai indeks: dua entitas dapat memiliki NAMA yang sama
            // (mis. dua supplier bernama sama), dan kunci berbasis label saja
            // membuat React menjatuhkan salah satu batang sehingga tampak
            // tumpang tindih atau hilang.
            <g key={`${d.label}-${i}`}>
              <text
                x={KIRI - 6} y={P.atas + i * tinggiBaris + tinggiBaris / 2 + 4}
                textAnchor="end" fontSize="11" fill="var(--text-primary)"
              >
                {potongLabel(d.label)}
                <title>{d.label}</title>
              </text>
              <rect
                x={KIRI} y={P.atas + i * tinggiBaris + 4}
                width={Math.max(skala(d.nilai, 0, xMaks, w), 1)}
                height={tinggiBaris - 8}
                fill={nada ? NADA[nada] : warnaSeri(d.lipatan ? '__lainnya' : d.label)}
                opacity={d.lipatan ? 0.55 : 1}
              >
                <title>
                  {d.label}: {fmt(d.nilai, 1)} {satuan}
                  {d.jumlah !== undefined ? ` (${d.jumlah} record)` : ''}
                </title>
              </rect>
              <text
                x={KIRI + Math.max(skala(d.nilai, 0, xMaks, w), 1) + 5}
                y={P.atas + i * tinggiBaris + tinggiBaris / 2 + 4}
                fontSize="10" fill="var(--text-secondary)"
              >
                {fmt(d.nilai, d.nilai < 100 ? 1 : 0)}
              </text>
            </g>
          );
        })}
        {penanda && (
          <>
            <line
              x1={KIRI + skala(penanda.nilai, 0, xMaks, w)}
              x2={KIRI + skala(penanda.nilai, 0, xMaks, w)}
              y1={P.atas} y2={P.atas + h}
              stroke="var(--text-primary)" strokeWidth="1.5" strokeDasharray="4 3"
            />
            <text
              x={KIRI + skala(penanda.nilai, 0, xMaks, w) + 4} y={P.atas + 10}
              fontSize="10" fill="var(--text-primary)"
            >
              {penanda.label} {fmt(penanda.nilai, 1)}
            </text>
          </>
        )}
      </svg>
      {zona && (
        <div className="grafik__legenda">
          {zona.map((z, i) => (
            <span key={z.nada}>
              <i style={{ background: NADA[z.nada] }} />
              {i === 0 ? `sampai ${z.sampai} ${satuan}`
                : z.sampai === null ? `di atas ${zona[i - 1].sampai} ${satuan}`
                  : `${zona[i - 1].sampai}-${z.sampai} ${satuan}`}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** Batang bertumpuk tegak. */
export function BatangBertumpuk({ data, seri, satuan, tinggi = 240 }) {
  const [sorot, setSorot] = useState(null);
  const lebar = 760;
  const w = lebar - P.kiri - P.kanan;
  const h = tinggi - P.atas - P.bawah;

  const total = data.map((d) => seri.reduce((s, k) => s + (d[k.kunci] ?? 0), 0));
  const tik = tikBulat(0, Math.max(...total, 1));
  const yMaks = tik.at(-1);

  const lebarKolom = Math.min(48, (w / Math.max(data.length, 1)) * 0.7);
  const x = (i) => P.kiri + (i + 0.5) * (w / Math.max(data.length, 1)) - lebarKolom / 2;
  // Label sumbu-X dijarangkan bila kolomnya banyak, supaya tidak tumpang tindih.
  const langkahLabel = Math.ceil(data.length / 12) || 1;

  return (
    <>
      <svg viewBox={`0 0 ${lebar} ${tinggi}`} className="grafik__svg" role="img">
        <Kerangka lebar={lebar} tinggi={tinggi} yMin={0} yMaks={yMaks} tikY={tik} satuan={satuan}>
          {data.map((d, i) => {
            let bawah = 0;
            return (
              <g
                key={d.label}
                onMouseEnter={() => setSorot(i)}
                onMouseLeave={() => setSorot(null)}
              >
                {seri.map((s) => {
                  const v = d[s.kunci] ?? 0;
                  const tinggiBatang = skala(v, 0, yMaks, h);
                  const y = P.atas + h - skala(bawah, 0, yMaks, h) - tinggiBatang;
                  bawah += v;
                  return v > 0 ? (
                    <rect
                      key={s.kunci} x={x(i)} y={y} width={lebarKolom} height={tinggiBatang}
                      fill={warnaSeri(s.kunci)}
                    />
                  ) : null;
                })}
                {i % langkahLabel === 0 && (
                  <text
                    x={x(i) + lebarKolom / 2} y={tinggi - 12} textAnchor="middle"
                    fontSize="10" fill="var(--text-secondary)"
                  >
                    {String(d.label).length > 9 ? String(d.label).slice(5) : d.label}
                  </text>
                )}
              </g>
            );
          })}
          {sorot !== null && (
            <Tooltip
              lebar={lebar} tinggi={tinggi} x={x(sorot) + lebarKolom} y={P.atas}
              isi={
                <>
                  <b>{data[sorot].label}</b>
                  {seri.map((s) => (
                    <div key={s.kunci}>{s.label}: {fmt(data[sorot][s.kunci] ?? 0)}</div>
                  ))}
                </>
              }
            />
          )}
        </Kerangka>
      </svg>
      <Legenda seri={seri} />
    </>
  );
}

/** Heatmap jam x hari. Intensitas satu warna, bukan pelangi. */
export function Heatmap({ data, hari }) {
  const id = useId();
  const kotak = 26;
  const lebarLabel = 34;
  const lebar = lebarLabel + 24 * kotak;
  const tinggi = 20 + hari.length * kotak;

  const maks = Math.max(...data.map((d) => d.jumlah), 1);
  const peta = new Map(data.map((d) => [`${d.hariIndeks}-${d.jam}`, d]));

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${lebar} ${tinggi}`} className="grafik__svg" style={{ minWidth: 620 }}>
        {Array.from({ length: 24 }, (_, j) =>
          j % 3 === 0 ? (
            <text
              key={`j${j}`} x={lebarLabel + j * kotak + kotak / 2} y={12}
              textAnchor="middle" fontSize="9" fill="var(--text-secondary)"
            >
              {j}
            </text>
          ) : null,
        )}
        {hari.map((h, i) => (
          <g key={h}>
            <text
              x={lebarLabel - 6} y={20 + i * kotak + kotak / 2 + 4}
              textAnchor="end" fontSize="10" fill="var(--text-secondary)"
            >
              {h}
            </text>
            {Array.from({ length: 24 }, (_, j) => {
              const sel = peta.get(`${i}-${j}`);
              return (
                <rect
                  key={`${id}${i}${j}`}
                  x={lebarLabel + j * kotak} y={20 + i * kotak}
                  width={kotak - 2} height={kotak - 2} rx="2"
                  fill={sel ? PALET[0] : 'var(--gridline)'}
                  opacity={sel ? 0.2 + 0.8 * (sel.jumlah / maks) : 0.35}
                >
                  {sel && (
                    <title>
                      {h} jam {j}.00 · {sel.jumlah} penerimaan · {fmt(sel.ltr)} L
                    </title>
                  )}
                </rect>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Tabel setara untuk tiap grafik - FR-27.1.4. */
export function TabelGrafik({ kolom, baris }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tabel">
        <thead>
          <tr>{kolom.map((k) => <th key={k.k} className={k.num ? 'num' : ''}>{k.label}</th>)}</tr>
        </thead>
        <tbody>
          {baris.map((b, i) => (
            <tr key={i}>
              {kolom.map((k) => (
                <td key={k.k} className={k.num ? 'num' : ''}>
                  {k.num ? fmt(b[k.k] ?? 0, k.desimal ?? 0) : String(b[k.k] ?? '-')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
