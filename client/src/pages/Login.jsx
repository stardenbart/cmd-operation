import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { Field, PesanGalat, PesanSukses } from '../components/ui.jsx';

/*
 * Tidak ada lagi dropdown operator.
 *
 * Dropdown menuntut daftar seluruh operator dikirim ke perangkat SEBELUM ada
 * yang login, sehingga siapa pun yang membuka halaman ini tahu siapa saja yang
 * bekerja di sini. Endpoint pemasoknya ikut dihapus di server, jadi layar ini
 * tidak dapat kembali memakainya tanpa keputusan sadar.
 */
export default function Login() {
  const { masuk, gantiPassword } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [galat, setGalat] = useState(null);
  const [mengirim, setMengirim] = useState(false);

  /*
   * Wajib ganti password ditangani DI SINI, bukan setelah masuk aplikasi.
   *
   * Password sementara diterbitkan Admin dan sudah pernah dibacakan atau
   * dikirim lewat pesan. Membiarkan pemiliknya memakai aplikasi lebih dahulu
   * berarti kredensial yang sudah terbaca orang lain tetap sah selama ia masih
   * betah menunda.
   */
  const [wajibGanti, setWajibGanti] = useState(false);
  const [baru, setBaru] = useState('');
  const [ulangi, setUlangi] = useState('');
  const [sukses, setSukses] = useState(null);

  async function kirimLogin(e) {
    e.preventDefault();
    setGalat(null);
    setMengirim(true);
    try {
      const hasil = await masuk(username.trim(), password);
      if (hasil.mustChangePassword) {
        setWajibGanti(true);
      } else {
        navigate('/', { replace: true });
      }
    } catch (err) {
      setGalat(err);
      setPassword('');
    } finally {
      setMengirim(false);
    }
  }

  async function kirimGanti(e) {
    e.preventDefault();
    setGalat(null);

    if (baru !== ulangi) {
      setGalat(new Error('Password baru dan ulangannya tidak sama'));
      return;
    }

    setMengirim(true);
    try {
      await gantiPassword(password, baru);
      // Sesi lama sudah dicabut server. Kembali ke layar masuk, bukan lanjut
      // ke aplikasi dengan token yang sudah mati.
      setWajibGanti(false);
      setPassword('');
      setBaru('');
      setUlangi('');
      setSukses('Password berhasil diganti. Masuk kembali dengan password baru Anda.');
    } catch (err) {
      setGalat(err);
    } finally {
      setMengirim(false);
    }
  }

  return (
    <div className="login">
      <form className="login__kotak tumpuk" onSubmit={wajibGanti ? kirimGanti : kirimLogin}>
        <div className="login__merek">
          <img className="login__logo" src="/Logo_Cimory.png" alt="Cimory" />
          <span className="login__eyebrow">Plant Sentul 1</span>
          <h1>CMD 1 Operation</h1>
          <p>
            {wajibGanti
              ? 'Password Anda masih sementara. Ganti dahulu sebelum melanjutkan.'
              : 'Masuk untuk melanjutkan aktivitas operasional Anda.'}
          </p>
        </div>

        <PesanSukses>{sukses}</PesanSukses>
        <PesanGalat galat={galat} />

        {wajibGanti ? (
          <>
            <Field label="Password baru" wajib bantuan="Minimal 8 karakter">
              <input
                type="password"
                autoComplete="new-password"
                value={baru}
                onChange={(e) => setBaru(e.target.value)}
                minLength={8}
                required
                autoFocus
              />
            </Field>

            <Field label="Ulangi password baru" wajib>
              <input
                type="password"
                autoComplete="new-password"
                value={ulangi}
                onChange={(e) => setUlangi(e.target.value)}
                required
              />
            </Field>

            <button className="btn btn--utama" disabled={mengirim || !baru || !ulangi}>
              {mengirim ? 'Menyimpan…' : 'Ganti password'}
            </button>
          </>
        ) : (
          <>
            <Field label="Username" wajib>
              <input
                autoComplete="username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
              />
            </Field>

            <Field label="Password" wajib>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>

            <button className="btn btn--utama" disabled={mengirim || !username || !password}>
              {mengirim ? 'Memeriksa…' : 'Masuk'}
            </button>

            <p className="login__bantuan">
              Lupa password? Hubungi Admin untuk menerbitkan password sementara.
            </p>
          </>
        )}
      </form>
      <div className="login__footer">
        © Powered by{' '}
        <strong>Digital Transformation Plant Sentul 2026</strong>
      </div>
    </div>
  );
}
