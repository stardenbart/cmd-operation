import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import JSZip from 'jszip';
import { unggahBiner, unduh } from '../lib/api.js';
import { Lencana, PesanGalat, PesanSukses } from '../components/ui.jsx';

const NAMA_LIST = {
  operator: 'Operator', receiving: 'Penerimaan', prepast: 'Prepast', transfer: 'Transfer',
  monitoring: 'Monitoring', stockOpname: 'Stock Opname',
};

async function jadikanZip(daftar) {
  const zip = new JSZip();
  for (const berkas of daftar) zip.file(berkas.name, berkas);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

const nadaStatus = (status) => ({
  LENGKAP: 'baik', SEBAGIAN: 'waspada', HILANG: 'kritis',
  'TIDAK DAPAT DIMUAT': 'kritis', DILEWATI: 'netral',
}[status] ?? 'netral');

export default function ImportData() {
  const qc = useQueryClient();
  const [berkas, setBerkas] = useState([]);
  const [pemeriksaan, setPemeriksaan] = useState(null);
  const [konfirmasi, setKonfirmasi] = useState(false);
  const [hasil, setHasil] = useState(null);
  const namaBerkas = useMemo(() => berkas.map((f) => f.name), [berkas]);

  const preview = useMutation({
    mutationFn: async () => unggahBiner('/import/preview', await jadikanZip(berkas)),
    onSuccess: (data) => { setPemeriksaan(data); setKonfirmasi(false); setHasil(null); },
  });
  const eksekusi = useMutation({
    mutationFn: async () => unggahBiner('/import/execute?konfirmasi=ya', await jadikanZip(berkas)),
    onSuccess: async (data) => {
      setHasil(data);
      await qc.invalidateQueries();
    },
  });

  const template = useMutation({ mutationFn: () => unduh('/import/template') });

  const galat = preview.error ?? eksekusi.error ?? template.error;
  return (
    <div className="tumpuk halaman-import">
      <div className="kartu__kepala halaman-kepala">
        <div>
          <span className="halaman-kepala__eyebrow">Administrasi Data</span>
          <h1>Import SharePoint</h1>
        </div>
      </div>
      <p className="bantuan halaman-deskripsi">
        Perbarui seluruh data dari hasil export SharePoint List. Import bersifat idempoten:
        kode yang sudah ada diperbarui dan kode baru ditambahkan.
      </p>

      {/* Template diletakkan sebelum unggah: pengguna perlu tahu bentuk berkas
          SEBELUM menyiapkannya, bukan sesudah. Isinya diturunkan dari definisi
          kolom yang sama dengan pemuat, jadi tidak mungkin usang. */}
      <section className="kartu import-template">
        <div>
          <h2>Belum tahu formatnya?</h2>
          <div className="bantuan">
            Unduh template berisi satu berkas CSV per bagian dengan kolom yang benar,
            plus PETUNJUK_FORMAT.csv yang menandai kolom wajib dan jenis nilainya.
          </div>
        </div>
        <button
          type="button" className="btn btn--kedua"
          disabled={template.isPending}
          onClick={() => template.mutate()}
        >
          {template.isPending ? 'Menyiapkan…' : 'Unduh Template Format'}
        </button>
      </section>

      <PesanGalat galat={galat} onTutup={() => { preview.reset(); eksekusi.reset(); template.reset(); }} />
      {hasil && (
        <PesanSukses>
          Import selesai. {hasil.jumlahPengecualian} pengecualian tercatat dan{' '}
          {hasil.verifikasi.jumlahGagal} pemeriksaan gagal.
        </PesanSukses>
      )}

      <section className="kartu tumpuk import-unggah">
        <div className="kartu__kepala">
          <div>
            <h2>Pilih Berkas Export</h2>
            <div className="bantuan">Pilih seluruh berkas CSV atau Excel (.xlsx) sekaligus.</div>
          </div>
          <Lencana>{berkas.length} Berkas</Lencana>
        </div>
        <input
          type="file" multiple accept=".csv,.xlsx"
          onChange={(e) => {
            setBerkas([...e.target.files]);
            setPemeriksaan(null); setKonfirmasi(false); setHasil(null);
          }}
        />
        {namaBerkas.length > 0 && (
          <div className="import-berkas">{namaBerkas.map((n) => <span key={n}>{n}</span>)}</div>
        )}
        <div className="kartu__aksi">
          <button
            type="button" className="btn btn--utama"
            disabled={!berkas.length || preview.isPending || eksekusi.isPending}
            onClick={() => preview.mutate()}
          >
            {preview.isPending ? 'Memeriksa…' : 'Periksa Berkas'}
          </button>
        </div>
      </section>

      {pemeriksaan && (
        <section className="kartu tumpuk">
          <div className="kartu__kepala">
            <h2>Hasil Pemeriksaan</h2>
            <Lencana nada={pemeriksaan.siap ? 'baik' : 'kritis'}>
              {pemeriksaan.siap ? 'Siap Diimport' : 'Belum Siap'}
            </Lencana>
          </div>
          <div className="tabel-bungkus">
            <table className="tabel import-pratinjau">
              <thead><tr><th>Bagian</th><th>Berkas</th><th className="num">Baris</th><th>Status</th><th>Catatan</th></tr></thead>
              <tbody>{pemeriksaan.list.map((item) => (
                <tr key={item.list}>
                  <td><b>{NAMA_LIST[item.list] ?? item.list}</b></td>
                  <td>{item.berkas ?? '-'}</td>
                  <td className="num">{item.jumlahBaris ?? '-'}</td>
                  <td><Lencana nada={nadaStatus(item.status)}>{item.status}</Lencana></td>
                  <td>{item.pesan ?? (item.kolomWajibHilang?.length
                    ? `Kolom wajib hilang: ${item.kolomWajibHilang.join(', ')}`
                    : item.kolomHilang?.length ? `${item.kolomHilang.length} kolom opsional tidak ada` : '-')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {pemeriksaan.catatan.map((c) => <div key={c} className="pesan pesan--waspada">{c}</div>)}
          {pemeriksaan.siap && (
            <>
              <label className="import-konfirmasi">
                <input type="checkbox" checked={konfirmasi} onChange={(e) => setKonfirmasi(e.target.checked)} />
                <span>Saya sudah memeriksa jumlah baris, kolom, dan format tanggal.</span>
              </label>
              <div className="kartu__aksi">
                <button
                  type="button" className="btn btn--utama"
                  disabled={!konfirmasi || eksekusi.isPending}
                  onClick={() => eksekusi.mutate()}
                >
                  {eksekusi.isPending ? 'Mengimport…' : 'Import Data'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {hasil && (
        <section className="kartu tumpuk">
          <div className="kartu__kepala"><h2>Ringkasan Import</h2></div>
          <div className="import-ringkasan">
            {Object.entries(hasil.ringkasan).filter(([k]) => k !== 'barisSumber').map(([k, v]) => (
              <div key={k}><span>{NAMA_LIST[k] ?? k}</span><b>{v}</b></div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
