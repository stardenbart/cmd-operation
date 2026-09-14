import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import { msSampaiPergantianShift } from './lib/shift.js';
import Login from './pages/Login.jsx';
import DialogGantiPassword from './components/DialogGantiPassword.jsx';
import PasangPWA from './components/PasangPWA.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Analitik from './pages/Analitik.jsx';
import DetailSilo from './pages/DetailSilo.jsx';
import Receiving from './pages/Receiving.jsx';
import Prepast from './pages/Prepast.jsx';
import Transfer from './pages/Transfer.jsx';
import Pengembalian from './pages/Pengembalian.jsx';
import Approval from './pages/Approval.jsx';
import Export from './pages/Export.jsx';
import StockOpname from './pages/StockOpname.jsx';
import Master from './pages/Master.jsx';
import PermintaanKoreksi from './pages/PermintaanKoreksi.jsx';
import DataList from './pages/DataList.jsx';
import Monitoring from './pages/Monitoring.jsx';
import Panduan from './pages/Panduan.jsx';
import ImportData from './pages/ImportData.jsx';
import LossesManagement from './pages/LossesManagement.jsx';
import PublicDashboard from './pages/PublicDashboard.jsx';
import { Kosong } from './components/ui.jsx';
import './styles/app.css';

/**
 * Menu disaring menurut wewenang — ini KENYAMANAN TAMPILAN, bukan keamanan.
 * Penegakan wewenang ada di endpoint (BR-22); Power Apps hanya memakai
 * properti Visible tombol, sehingga siapa pun yang dapat memanggil operasi
 * tulis dapat menyetujui atau mem-void record (B-22).
 */
/**
 * Menu dikelompokkan supaya sidebar tidak terlalu padat: transaksi harian
 * dikumpulkan di grup "FM Receiving", pengelolaan aplikasi di "Manage Apps".
 * Grup dapat dilipat. Dashboard, Analitik, Data, dan Panduan berdiri sendiri
 * karena sering diakses lintas peran atau tidak masuk salah satu kelompok.
 *
 * Penyaringan `boleh(aksi)` tidak berubah: sebuah grup hanya muncul bila
 * setidaknya satu anaknya lolos wewenang.
 */
const NAV = [
  { ke: '/', label: 'Dashboard', ikon: 'dashboard', aksi: 'dashboard:lihat', tepat: true },
  { ke: '/analitik', label: 'Analitik', ikon: 'analitik', aksi: 'dashboard:lihat' },
  {
    grup: 'FM Receiving', ikon: 'grupFm', anak: [
      { ke: '/receiving', label: 'Penerimaan', ikon: 'penerimaan', aksi: 'transaksi:buat' },
      { ke: '/prepast', label: 'Prepast', ikon: 'prepast', aksi: 'transaksi:buat' },
      { ke: '/monitoring', label: 'Monitoring', ikon: 'monitoring', aksi: 'transaksi:buat' },
      { ke: '/transfer', label: 'Transfer', ikon: 'transfer', aksi: 'transaksi:buat' },
      { ke: '/pengembalian', label: 'Pengembalian', ikon: 'pengembalian', aksi: 'transaksi:buat' },
      { ke: '/approval', label: 'Approval', ikon: 'approval', aksi: 'dashboard:lihat' },
      { ke: '/permintaan-koreksi', label: 'Permintaan Koreksi', ikon: 'koreksi', aksi: 'dashboard:lihat' },
      { ke: '/stock-opname', label: 'Stock Opname', ikon: 'stok', aksi: 'stock_opname:kelola' },
    ],
  },
  { ke: '/data', label: 'Data', ikon: 'data', aksi: 'dashboard:lihat' },
  {
    grup: 'Manage Apps', ikon: 'grupManage', anak: [
      { ke: '/export', label: 'Export', ikon: 'export', aksi: 'dashboard:lihat' },
      { ke: '/import', label: 'Import Data', ikon: 'import', aksi: 'master:kelola' },
      { ke: '/master', label: 'Master Data', ikon: 'master', aksi: 'master:kelola' },
      { ke: '/losses', label: 'Losses Setting', ikon: 'losses', aksi: 'master:kelola' },
    ],
  },
  // Panduan terlihat semua peran (semua punya dashboard:lihat) dan sengaja
  // diletakkan paling bawah - dicari saat butuh, bukan dilewati tiap hari.
  { ke: '/panduan', label: 'Panduan', ikon: 'panduan', aksi: 'dashboard:lihat' },
];

const GARIS_IKON = {
  dashboard: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  analitik: 'M4 19V9m6 10V5m6 14v-7m4 7H2',
  penerimaan: 'M12 3v12m0 0 5-5m-5 5-5-5M4 19h16',
  prepast: 'M12 3s5 5.4 5 9a5 5 0 1 1-10 0c0-3.6 5-9 5-9Z',
  monitoring: 'M3 12h4l2-5 4 10 2-5h6',
  transfer: 'M7 7h12m0 0-3-3m3 3-3 3M17 17H5m0 0 3 3m-3-3 3-3',
  pengembalian: 'M9 7H5V3M5 7a8 8 0 1 1-1 8',
  approval: 'M5 12.5 9.5 17 19 7.5',
  koreksi: 'm4 20 4.2-1 10.7-10.7-3.2-3.2L5 15.8 4 20Zm9.8-13.8 3.2 3.2',
  data: 'M4 5h16v14H4V5Zm0 5h16M9 5v14',
  export: 'M12 3v12m0 0 5-5m-5 5-5-5M5 21h14',
  stok: 'M7 4h10v17H7V4Zm3-2h4v4h-4V2Zm0 9h4m-4 5h4',
  master: 'M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM14 2v4h4M8 10h8M8 14h8M8 18h5',
  panduan: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5Zm2.5 13.5H20',
  import: 'M12 21V9m0 0-4 4m4-4 4 4M5 3h14v4H5V3Z',
  losses: 'M12 3s5 5.4 5 9a5 5 0 1 1-10 0c0-3.6 5-9 5-9Zm-3 9a3 3 0 0 0 3 3',
  grupFm: 'M4 7h16M4 12h16M4 17h10',
  grupManage: 'M4 6h16M7 12h13M4 12h.01M4 18h.01M10 18h10',
  panel: 'M4 5h16M4 12h16M4 19h16',
};

function IkonMenu({ nama }) {
  return (
    <svg className="nav__ikon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={GARIS_IKON[nama]} />
    </svg>
  );
}

/** Baca/tulis preferensi tampilan sidebar dengan aman (mode privat dll). */
function bacaPref(kunci, cadangan) {
  try {
    const v = localStorage.getItem(kunci);
    return v === null ? cadangan : JSON.parse(v);
  } catch { return cadangan; }
}
function simpanPref(kunci, nilai) {
  try { localStorage.setItem(kunci, JSON.stringify(nilai)); } catch { /* abaikan */ }
}

function TautanMenu({ m }) {
  return (
    <NavLink to={m.ke} end={m.tepat} className={({ isActive }) => (isActive ? 'aktif' : '')}>
      <IkonMenu nama={m.ikon} />
      <span>{m.label}</span>
    </NavLink>
  );
}

/**
 * Grup menu yang dapat dilipat.
 *
 * Anak SELALU dirender ke DOM: pada layar sempit navigasi berbentuk bilah
 * mendatar, dan CSS meratakan grup (header disembunyikan, anak jadi
 * `display:contents`) supaya perilakunya sama persis seperti sebelum ada grup.
 * Melipat hanya berlaku pada sidebar tegak (desktop).
 */
function GrupMenu({ grup, ikon, anak, terbuka, onToggle }) {
  const idPanel = `grup-${grup.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="nav__grup">
      <button
        type="button"
        className="nav__grup-tombol"
        aria-expanded={terbuka}
        aria-controls={idPanel}
        onClick={onToggle}
      >
        <IkonMenu nama={ikon} />
        <span>{grup}</span>
        <svg className={`nav__chevron${terbuka ? ' nav__chevron--buka' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div className={`nav__grup-anak${terbuka ? '' : ' nav__grup-anak--tutup'}`} id={idPanel}>
        {anak.map((m) => <TautanMenu key={m.ke} m={m} />)}
      </div>
    </div>
  );
}

// Sesi berakhir OTOMATIS begitu shift berganti (07.00/15.00/23.00 WIB) —
// server yang menegakkannya sungguhan (wajibLogin & refresh() menolak lepas
// dari apa kata klien, lihat auth/shift.js di server). Peringatan & keluar
// di sini murni supaya operator tidak kehilangan pekerjaan yang sedang
// diketik tanpa tanda-tanda.
const PERINGATAN_MENIT_SEBELUM_SHIFT = 5;

function Kerangka({ children }) {
  const { operator, keluar, boleh } = useAuth();
  const navigate = useNavigate();
  const lokasi = useLocation();
  const [gantiPassword, setGantiPassword] = useState(false);
  const [sidebarTampil, setSidebarTampil] = useState(() => bacaPref('nav:tampil', true));
  const [grupTerbuka, setGrupTerbuka] = useState(() => bacaPref('nav:grup', {}));
  const [peringatanShift, setPeringatanShift] = useState(false);

  useEffect(() => simpanPref('nav:tampil', sidebarTampil), [sidebarTampil]);
  useEffect(() => simpanPref('nav:grup', grupTerbuka), [grupTerbuka]);

  useEffect(() => {
    /*
     * DIPERIKSA BERKALA (bukan satu setTimeout sekali tembak dijadwalkan di
     * muka) — supaya tidak "nyangkut" saat tab di-background. Timer sepanjang
     * berjam-jam (sampai 8 jam, jarak terjauh ke pergantian shift) DI-THROTTLE
     * browser di tab tidak aktif, kadang sampai lewat jauh dari jadwalnya;
     * peringatan sempat muncul tapi logout-nya sendiri jadi telat/tidak
     * pernah tereksekusi. Polling tiap 30 detik selalu membandingkan dengan
     * jam SUNGGUHAN saat itu — berapa pun telatnya satu tick terjadi, tick
     * berikutnya tetap benar, tidak bisa nyangkut menampilkan peringatan basi.
     */
    function periksa() {
      const msSampaiGanti = msSampaiPergantianShift();
      if (msSampaiGanti <= 0) {
        keluar().then(() => navigate('/', { replace: true }));
        return;
      }
      setPeringatanShift(msSampaiGanti <= PERINGATAN_MENIT_SEBELUM_SHIFT * 60_000);
    }

    periksa();
    const id = setInterval(periksa, 30_000);
    // Tab yang kembali terlihat langsung diperiksa ulang — jangan menunggu
    // tick 30 detik berikutnya kalau operator baru saja kembali dari tab lain
    // persis pada saat pergantian shift.
    const tanganiVisibilitas = () => { if (!document.hidden) periksa(); };
    document.addEventListener('visibilitychange', tanganiVisibilitas);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tanganiVisibilitas);
    };
  }, [keluar, navigate]);

  // Menu tersaring wewenang; grup yang seluruh anaknya tak berwenang dibuang.
  const nav = NAV.map((n) => {
    if (!n.grup) return boleh(n.aksi) ? n : null;
    const anak = n.anak.filter((a) => boleh(a.aksi));
    return anak.length ? { ...n, anak } : null;
  }).filter(Boolean);

  // Grup terbuka bila operator membukanya (default terbuka) ATAU rute aktif ada
  // di dalamnya - menyembunyikan halaman yang sedang dibuka membingungkan.
  const adaAktif = (anak) => anak.some((a) => (
    a.tepat ? lokasi.pathname === a.ke : lokasi.pathname.startsWith(a.ke)
  ));

  async function tanganiKeluar() {
    await keluar();
    navigate('/', { replace: true });
  }

  return (
    <div className={`app${sidebarTampil ? '' : ' app--tanpa-nav'}`}>
      <header className="topbar">
        <div className="topbar__identitas">
          <button
            type="button"
            className="topbar__toggle"
            aria-label={sidebarTampil ? 'Sembunyikan menu' : 'Tampilkan menu'}
            aria-pressed={!sidebarTampil}
            onClick={() => setSidebarTampil((v) => !v)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={GARIS_IKON.panel} /></svg>
          </button>
          <img className="topbar__logo" src="/Logo_Cimory.png" alt="Cimory" />
          <div className="topbar__judul">
            <div className="topbar__merek">CMD 1 Operation</div>
            <div className="topbar__sub">Fresh Milk Receiving · Plant Sentul 1</div>
          </div>
        </div>
        <div className="topbar__kanan">
          <span className="topbar__avatar" aria-hidden="true">
            {operator.nama?.trim()?.charAt(0)?.toUpperCase() || 'O'}
          </span>
          <div className="topbar__user">
            <div className="topbar__nama">{operator.nama}</div>
            <div className="topbar__peran">{operator.role}</div>
          </div>
          <PasangPWA />
          <button
            type="button" className="btn btn--kecil btn--kedua"
            onClick={() => setGantiPassword((v) => !v)}
            aria-label="Ganti password"
          >
            {/* Label memendek di layar sempit, bukan terpotong ellipsis.
                Di 390px, "Ganti password" memakan ruang yang membuat nama
                aplikasi ikut terpangkas menjadi "CMD 1 ...". Yang dipendekkan
                labelnya, sebab "Password" di sebelah "Keluar" tetap tidak
                dapat disalahartikan - sedangkan merek yang terpotong tidak
                memberi tahu apa pun. */}
            <span className="hanya-lebar">Ganti password</span>
            <span className="hanya-sempit">Password</span>
          </button>
          <button type="button" className="btn btn--kecil btn--kedua" onClick={tanganiKeluar}>
            Keluar
          </button>
        </div>
      </header>

      {peringatanShift && (
        <div className="pesan pesan--waspada" role="status" style={{ margin: '12px 16px 0' }}>
          Shift akan segera berganti — sesi ini akan otomatis berakhir. Segera simpan pekerjaan yang sedang berjalan.
        </div>
      )}

      <div className="app__badan">
        <nav className="nav" aria-label="Menu Utama">
          <div className="nav__label">Menu Utama</div>
          {nav.map((n) => (
            n.grup ? (
              <GrupMenu
                key={n.grup}
                grup={n.grup}
                ikon={n.ikon}
                anak={n.anak}
                terbuka={(grupTerbuka[n.grup] ?? true) || adaAktif(n.anak)}
                onToggle={() => setGrupTerbuka((s) => ({ ...s, [n.grup]: !(s[n.grup] ?? true) }))}
              />
            ) : (
              <TautanMenu key={n.ke} m={n} />
            )
          ))}
        </nav>

        <main className="isi">
          <div className="isi__konten">
            {gantiPassword && (
              <DialogGantiPassword onTutup={() => setGantiPassword(false)} />
            )}
            {children}
          </div>
          <footer className="footer-aplikasi">
            © Powered by{' '}
            <strong>Digital Transformation Plant Sentul 2026</strong>
          </footer>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const { sudahMasuk, memuat, boleh } = useAuth();
  const lokasi = useLocation();

  // Dashboard publik berdiri di luar cangkang & tanpa login: tautan bertoken
  // dari luar tim tidak boleh terhalang layar masuk. Diperiksa sebelum apa pun.
  if (lokasi.pathname === '/publik/dashboard') return <PublicDashboard />;

  if (memuat) {
    return <div className="login"><div className="login__kotak"><Kosong>Memulihkan sesi…</Kosong></div></div>;
  }
  if (!sudahMasuk) return <Login />;

  // Admin tidak melakukan input transaksi harian (D-14), jadi rute input
  // tidak dipasang sama sekali untuknya.
  const bolehInput = boleh('transaksi:buat');

  return (
    <Kerangka>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/silo/:id" element={<DetailSilo />} />
        <Route path="/analitik" element={<Analitik />} />
        <Route path="/approval" element={<Approval />} />
        <Route path="/permintaan-koreksi" element={<PermintaanKoreksi />} />
        <Route path="/data" element={<DataList />} />
        <Route path="/export" element={<Export />} />
        <Route path="/stock-opname" element={<StockOpname />} />
        <Route path="/master" element={<Master />} />
        <Route path="/master/:master" element={<Master />} />
        {boleh('master:kelola') && <Route path="/losses" element={<LossesManagement />} />}
        <Route path="/import" element={<ImportData />} />
        <Route path="/panduan" element={<Panduan />} />
        {bolehInput && <Route path="/receiving" element={<Receiving />} />}
        {bolehInput && <Route path="/prepast" element={<Prepast />} />}
        {bolehInput && <Route path="/monitoring" element={<Monitoring />} />}
        {bolehInput && <Route path="/transfer" element={<Transfer />} />}
        {bolehInput && <Route path="/pengembalian" element={<Pengembalian />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Kerangka>
  );
}
