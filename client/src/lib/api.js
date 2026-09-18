/**
 * Klien API.
 *
 * Access token disimpan di memori, bukan localStorage: token di localStorage
 * dapat dibaca skrip mana pun yang berhasil masuk ke halaman. Refresh token
 * berada di cookie httpOnly dan tidak pernah tersentuh JavaScript.
 */

let accessToken = null;
const pendengar = new Set();

export function setToken(token) {
  accessToken = token;
  pendengar.forEach((fn) => fn(token));
}
export function getToken() {
  return accessToken;
}
export function onTokenChange(fn) {
  pendengar.add(fn);
  return () => pendengar.delete(fn);
}

/** Error yang membawa kode aturan bisnis, mis. 'BR-06'. */
export class ApiError extends Error {
  constructor(kode, pesan, detail, status) {
    super(pesan);
    this.kode = kode;
    this.detail = detail;
    this.status = status;
  }
}

let sedangRefresh = null;

async function refreshToken() {
  // Beberapa permintaan yang bersamaan menemui 401 hanya memicu SATU refresh;
  // sisanya menunggu hasil yang sama.
  sedangRefresh ??= fetch('/api/v1/auth/refresh', { method: 'POST' })
    .then(async (res) => {
      if (!res.ok) throw new ApiError('UNAUTHORIZED', 'Sesi berakhir', null, 401);
      const { accessToken: baru } = await res.json();
      setToken(baru);
      return baru;
    })
    .finally(() => { sedangRefresh = null; });
  return sedangRefresh;
}

/**
 * Memulihkan sesi saat halaman dimuat - SATU KALI per muat halaman.
 *
 * Sengaja TIDAK memakai penjaga `sedangRefresh` di atas, yang direset setelah
 * selesai. Refresh token dirotasi di server: token lama dicabut begitu dipakai.
 * Jadi dua pemanggilan BERURUTAN sama merusaknya dengan dua yang bersamaan -
 * yang kedua memakai token yang sudah dicabut, gagal 401, dan pengguna
 * terlempar ke layar login padahal sesinya sah.
 *
 * Itu bukan kasus teoretis: StrictMode React memasang effect dua kali di mode
 * pengembangan, dan gejalanya tepat itu - sesi hilang setiap kali halaman
 * di-reload. Janji di sini disimpan permanen, jadi pemasangan ulang komponen
 * memakai hasil yang sama alih-alih membakar token kedua.
 */
let pemulihanSesi = null;
export function pulihkanSesi() {
  pemulihanSesi ??= refreshToken();
  return pemulihanSesi;
}

async function kirim(path, opsi = {}, bolehUlang = true) {
  const res = await fetch(`/api/v1${path}`, {
    ...opsi,
    headers: {
      ...(opsi.body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...opsi.headers,
    },
    body: opsi.body ? JSON.stringify(opsi.body) : undefined,
  });

  if (res.status === 401 && bolehUlang && accessToken) {
    try {
      await refreshToken();
      return kirim(path, opsi, false);
    } catch {
      setToken(null);
      throw new ApiError('UNAUTHORIZED', 'Sesi berakhir. Masuk kembali.', null, 401);
    }
  }

  const isi = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(
      isi?.code ?? 'ERROR',
      isi?.message ?? `Permintaan gagal (${res.status})`,
      isi?.details ?? null,
      res.status,
    );
  }
  return isi;
}

/**
 * Mengunduh berkas biner ke perangkat pengguna.
 *
 * Tidak memakai tautan biasa dan itu disengaja: endpointnya menuntut header
 * Authorization, sementara navigasi `<a href>` tidak membawanya. Jadi
 * berkasnya diambil lewat fetch, dijadikan blob, lalu diserahkan ke browser.
 *
 * Nama berkas diambil dari header `Content-Disposition` supaya SERVER yang
 * menentukan namanya. Kalau klien menyusun namanya sendiri, konvensi
 * penamaannya akan ada di dua tempat, dan sufiks `_2` untuk terbitan ulang
 * pasti terlewat di salah satunya.
 */
export async function unduh(path) {
  const ambil = async (token) =>
    fetch(`/api/v1${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  let res = await ambil(accessToken);
  if (res.status === 401 && accessToken) {
    res = await ambil(await refreshToken());
  }

  if (!res.ok) {
    const isi = await res.json().catch(() => null);
    throw new ApiError(
      isi?.code ?? 'ERROR',
      isi?.message ?? `Unduhan gagal (${res.status})`,
      isi?.details ?? null,
      res.status,
    );
  }

  const disposisi = res.headers.get('Content-Disposition') ?? '';
  const nama = /filename="?([^";]+)"?/.exec(disposisi)?.[1] ?? 'unduhan.xlsx';

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const tautan = document.createElement('a');
  tautan.href = url;
  tautan.download = nama;
  document.body.append(tautan);
  tautan.click();
  tautan.remove();

  /**
   * URL blob DIKEMBALIKAN, bukan langsung dicabut.
   *
   * Klik di atas terjadi SETELAH `await fetch`, jadi ia berada di luar
   * gerakan pengguna. Sebagian browser dan sebagian kebijakan perangkat
   * memblokir unduhan otomatis semacam itu, dan blokirnya SENYAP: tidak ada
   * galat yang sampai ke JavaScript, berkasnya sekadar tidak muncul. Itulah
   * yang dilaporkan terjadi pada export form GMP.
   *
   * Karena itu pemanggilnya menerima URL ini dan menampilkan tautan yang
   * dapat diklik pengguna. Klik itu adalah gerakan pengguna sungguhan, yang
   * tidak pernah diblokir. Umurnya dipanjangkan ke sepuluh menit supaya
   * tautannya tidak mati sebelum sempat dipakai.
   */
  setTimeout(() => URL.revokeObjectURL(url), 600_000);

  return { nama, ukuran: blob.size, url };
}

/** Mengirim berkas biner tanpa mengubahnya menjadi JSON. */
export async function unggahBiner(path, body, tipe = 'application/zip') {
  const ambil = async (token) => fetch(`/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': tipe,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

  let res = await ambil(accessToken);
  if (res.status === 401 && accessToken) res = await ambil(await refreshToken());
  const isi = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      isi?.code ?? 'ERROR', isi?.message ?? `Unggah gagal (${res.status})`,
      isi?.details ?? null, res.status,
    );
  }
  return isi;
}

export const api = {
  get: (path) => kirim(path),
  post: (path, body) => kirim(path, { method: 'POST', body }),
  patch: (path, body) => kirim(path, { method: 'PATCH', body }),
  delete: (path) => kirim(path, { method: 'DELETE' }),
};
