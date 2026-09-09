import { PesanSukses } from './ui.jsx';

/**
 * Pemberitahuan berkas siap, beserta TAUTAN CADANGAN.
 *
 * Unduhan dipicu setelah `await fetch`, jadi kliknya berada di luar gerakan
 * pengguna. Sebagian browser dan sebagian kebijakan perangkat memblokir
 * unduhan otomatis semacam itu, dan blokirnya SENYAP: tidak ada galat yang
 * sampai ke JavaScript, berkasnya sekadar tidak muncul di folder unduhan.
 *
 * Tautan di bawah ini adalah jalan keluarnya. Kliknya gerakan pengguna
 * sungguhan, yang tidak pernah diblokir. Ia selalu ditampilkan, bukan hanya
 * saat gagal, sebab kegagalannya tidak dapat dideteksi dari sini - kalau
 * ditampilkan hanya "saat gagal", ia tidak akan pernah muncul.
 */
export default function BerkasSiap({ hasil, onTutup }) {
  if (!hasil) return null;

  return (
    <PesanSukses>
      <span>
        <b>{hasil.nama}</b> siap ({(hasil.ukuran / 1024).toFixed(0)} KB).
        {' '}Berkas seharusnya langsung tersimpan di folder unduhan.
        {' '}Bila tidak muncul,{' '}
        <a href={hasil.url} download={hasil.nama} className="tautan-unduh">
          klik di sini untuk menyimpannya
        </a>.
      </span>
      {onTutup && (
        <button type="button" className="btn btn--hantu btn--kecil dorong" onClick={onTutup}>
          Tutup
        </button>
      )}
    </PesanSukses>
  );
}
