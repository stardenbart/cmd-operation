import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, pulihkanSesi, setToken, getToken } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const qc = useQueryClient();
  const [operator, setOperator] = useState(null);
  const [wewenang, setWewenang] = useState([]);
  const [memuat, setMemuat] = useState(true);

  // Sesi dipulihkan dari cookie refresh saat halaman dimuat ulang.
  useEffect(() => {
    let batal = false;
    (async () => {
      try {
        // Lewat api.js, bukan fetch sendiri: jalur refresh harus satu, kalau
        // tidak penjaga dedupenya tidak berlaku bagi pemanggil ini.
        await pulihkanSesi();
        const me = await api.get('/auth/me');
        if (!batal) {
          setOperator(me.operator);
          setWewenang(me.wewenang);
        }
      } catch {
        if (!batal) setOperator(null);
      } finally {
        if (!batal) setMemuat(false);
      }
    })();
    return () => { batal = true; };
  }, []);

  const nilai = useMemo(() => ({
    operator,
    wewenang,
    memuat,
    sudahMasuk: Boolean(operator && getToken()),

    async masuk(username, password) {
      const hasil = await api.post('/auth/login', { username, password });
      setToken(hasil.accessToken);
      setOperator(hasil.operator);
      setWewenang(hasil.wewenang);
      // Buang seluruh cache kueri user sebelumnya. Wewenang per-baris (tombol
      // Sunting/Batalkan) dihitung server per aktor; tanpa pembersihan ini, data
      // hasil sesi lama (mis. Admin) tampil dulu untuk Operator baru sampai
      // refetch - itulah tombol yang "hilang sampai di-refresh".
      qc.clear();
      return hasil;
    },

    /*
     * Ganti password mencabut SELURUH sesi, termasuk sesi ini - itu memang
     * yang diminta gantiPassword() di server. Jadi keadaan lokal ikut
     * dibersihkan di sini, bukan dibiarkan menyimpan token yang sudah mati
     * dan memunculkan galat 401 pada permintaan berikutnya.
     */
    async gantiPassword(passwordLama, passwordBaru) {
      const hasil = await api.post('/auth/change-password', { passwordLama, passwordBaru });
      setToken(null);
      setOperator(null);
      setWewenang([]);
      return hasil;
    },

    async keluar() {
      await api.post('/auth/logout').catch(() => {});
      setToken(null);
      setOperator(null);
      setWewenang([]);
      // Cache dibuang agar sesi berikutnya tidak mewarisi data & wewenang lama.
      qc.clear();
    },

    // Menyembunyikan menu yang tidak relevan. Ini KENYAMANAN TAMPILAN —
    // penegakan wewenang tetap di endpoint (BR-22, B-22).
    boleh: (aksi) => wewenang.includes(aksi),
  }), [operator, wewenang, memuat, qc]);

  return <AuthContext.Provider value={nilai}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus di dalam AuthProvider');
  return ctx;
}
