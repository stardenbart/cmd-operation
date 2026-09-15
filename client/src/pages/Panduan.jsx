import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Halaman Panduan Pengguna - dokumen bantuan dalam aplikasi.
 *
 * SATU SUMBER, TIGA TAMPILAN.
 *
 * Seluruh isi panduan hidup di array `BAB` di bawah. Dari satu sumber itu
 * lahir tiga hal sekaligus: tab peran di atas, deretan chip bagian, dan
 * panel navigasi mengambang di kanan. Menuliskannya tiga kali berarti tiga
 * tempat yang harus dijaga tetap sama; menuliskannya sekali membuatnya
 * mustahil berbeda.
 *
 * DISUSUN MENGIKUTI URUTAN MENU.
 *
 * Bab-babnya sengaja berurutan sama persis dengan menu di kiri aplikasi.
 * Orang yang tersesat di satu halaman mencari bantuannya dengan menyusuri
 * urutan yang sama seperti yang ia lihat di layar, bukan urutan abjad atau
 * urutan yang paling masuk akal bagi penulisnya.
 */

/* Peran yang dikenal. 'semua' hanyalah filter, bukan peran sungguhan. */
const PERAN = [
  { id: 'semua', label: 'Semua' },
  { id: 'operator', label: 'Operator' },
  { id: 'spv', label: 'SPV' },
  { id: 'admin', label: 'Admin' },
];

/** Label peran untuk lencana di dalam bab. */
const LABEL_PERAN = { operator: 'Operator', spv: 'SPV', admin: 'Admin' };

/* Blok isi: paragraf (p), daftar (ul), gambar, dan langkah bernomor (ol). */
const p = (teks) => ({ jenis: 'p', teks });
const ul = (...butir) => ({ jenis: 'ul', butir });
const ol = (...langkah) => ({ jenis: 'ol', langkah });
const gambar = (src, alt, keterangan) => ({ jenis: 'gambar', src, alt, keterangan });
const sub = (judul, ...blok) => ({ judul, blok });

const IMG = '/panduan';

/**
 * Isi panduan.
 *
 * Tiap bab menyebut `peran` yang benar-benar MEMAKAI halaman itu. Filter peran
 * di atas menampilkan bab yang memuat peran terpilih; "Semua" menampilkan
 * segalanya. Halaman yang menu-nya terlihat semua peran tetapi tindakannya
 * dibatasi (mis. Approval hanya diputuskan SPV) dijelaskan di dalam babnya.
 */
const BAB = [
  {
    id: 'selamat-datang',
    judul: 'Selamat Datang',
    ringkas: 'Apa itu aplikasi ini dan cara membaca panduannya.',
    peran: ['operator', 'spv', 'admin'],
    isi: [
      sub(
        null,
        p('CMD 1 Operation mencatat perjalanan susu segar dari truk sampai tangki produksi: penerimaan, prepasteurisasi, pemindahan antar silo, pengecekan mutu, sampai form GMP yang tercetak untuk audit. Panduan ini menjelaskan tiap halaman dengan urutan yang sama seperti menu di sebelah kiri layar Anda.'),
        p('Satu aplikasi ini dipakai tiga peran yang berbeda tugasnya. Gunakan tombol peran di atas untuk menyaring bagian yang benar-benar Anda pakai.'),
        ul(
          'Operator mencatat kejadian di lapangan: penerimaan, prepast, monitoring, transfer, dan pengembalian.',
          'SPV memutuskan: menyetujui atau menolak catatan, meninjau permintaan koreksi, dan membatalkan catatan yang keliru.',
          'Admin mengurus data induk: silo, supplier, tank, akun pengguna, serta volume awal bulan pada stock opname.',
        ),
      ),
    ],
  },

  {
    id: 'masuk',
    judul: 'Masuk & Akun',
    ringkas: 'Cara login, mengganti password, dan keluar.',
    peran: ['operator', 'spv', 'admin'],
    isi: [
      sub(
        'Masuk (Login)',
        p('Buka aplikasi, isi Username dan Password Anda, lalu tekan Masuk. Bila password Anda masih sementara (baru diberikan Admin), aplikasi langsung meminta Anda menggantinya sebelum boleh melanjutkan.'),
        gambar(`${IMG}/cmd-login.png`, 'Halaman masuk CMD 1 Operation', 'Layar masuk. Username dan password diberikan oleh Admin.'),
      ),
      sub(
        'Ganti password & keluar',
        ul(
          'Tombol Ganti password ada di kanan atas. Isi password lama, lalu password baru minimal 8 karakter dan ulangi. Setelah diganti, seluruh sesi Anda di perangkat lain ikut berakhir dan Anda perlu masuk kembali.',
          'Lupa password? Hubungi Admin. Admin akan menerbitkan password sementara yang wajib Anda ganti saat login pertama.',
          'Tombol Keluar mengakhiri sesi Anda di perangkat ini.',
        ),
      ),
      sub(
        'Sesi mengikuti shift',
        p('Sesi login mengikuti jadwal shift: Shift 1 pukul 07.00–14.59, Shift 2 pukul 15.00–22.59, dan Shift 3 pukul 23.00–06.59.'),
        ul(
          'Saat jam berpindah dari satu shift ke shift berikutnya, sesi Anda otomatis berakhir (logout) — ini berlaku untuk peran apa pun.',
          'Peringatan muncul 5 menit sebelum pergantian shift supaya Anda sempat menyimpan pekerjaan yang sedang berjalan.',
          'Setelah shift berganti, masuk kembali seperti biasa untuk melanjutkan.',
        ),
      ),
    ],
  },

  {
    id: 'dashboard',
    judul: 'Dashboard',
    ringkas: 'Halaman pertama setelah masuk: kondisi seluruh silo sekilas.',
    peran: ['operator', 'spv', 'admin'],
    isi: [
      sub(
        'Membaca kartu silo',
        p('Dashboard menampilkan tiap silo sebagai satu kartu berisi tabung. Ketinggian isi tabung menunjukkan seberapa penuh silo, dan angka persennya ada di dalamnya. Kartu juga menyebut standing time (sudah berapa lama susu berdiri di silo itu), pH, dan suhu terakhir.'),
        gambar(`${IMG}/cmd-dashboard-operator.png`, 'Dashboard operasional', 'Setiap silo digambar sebagai tabung. Isi dan warnanya mengikuti keadaan sebenarnya.'),
      ),
      sub(
        'Perlu dilengkapi & batch aktif',
        ul(
          'Kartu "Perlu dilengkapi" menagih input yang masih separuh, termasuk silo tujuan atau hasil proses Prepast yang belum diisi. Klik salah satunya untuk langsung membukanya dan melengkapi. Kalau kosong, berarti semua catatan sudah lengkap.',
          'Tabel "Batch aktif per silo" di bawah memperlihatkan susu siapa yang masih tersimpan di tiap silo, berapa TS-nya, dan sudah berapa lama berdiri, lengkap dengan subtotal per silo.',
        ),
        p('Angka menyegar sendiri tiap 30 detik tanpa memuat ulang halaman, jadi yang Anda lihat selalu terbaru.'),
      ),
      sub(
        'Tampilan Admin',
        p('Admin dan SPV melihat dashboard yang sama, hanya lebih menekankan ringkasan seluruh plant.'),
        gambar(`${IMG}/cmd-dashboard-admin.png`, 'Dashboard dilihat oleh Admin', 'Dashboard versi Admin. Data silonya sama, dibaca untuk pengawasan menyeluruh.'),
      ),
    ],
  },

  {
    id: 'penerimaan',
    judul: 'Penerimaan',
    ringkas: 'Mencatat susu yang baru datang dari supplier.',
    peran: ['operator', 'spv'],
    isi: [
      sub(
        'Mengisi penerimaan',
        p('Halaman ini mencatat susu yang baru diterima. Seluruh susu masuk lebih dulu ke BUFFER sebelum diprepast.'),
        ol(
          'Ketik nama Supplier di kolom pencarian, lalu pilih dari daftar yang muncul.',
          'Isi Waktu selesai (tanggal dan jam penerimaan selesai) dalam satu kolom sekaligus.',
          'Isi Kuantitas dalam kilogram dan Berat jenis. Titik atau koma untuk desimal sama saja.',
          'Total solid boleh dikosongkan. Catatan juga opsional.',
          'Lihat Volume tercatat yang dihitung otomatis (kg dibagi berat jenis, dibulatkan ke bawah), lalu tekan Simpan penerimaan.',
        ),
        gambar(`${IMG}/cmd-penerimaan.png`, 'Formulir penerimaan susu', 'Supplier dicari dengan mengetik. Volume dihitung otomatis di bawah.'),
        p('Setelah disimpan, catatan berstatus Menunggu persetujuan sampai SPV menyetujuinya.'),
      ),
    ],
  },

  {
    id: 'prepast',
    judul: 'Prepast',
    ringkas: 'Memindahkan susu dari buffer ke silo lewat prepasteurisasi.',
    peran: ['operator', 'spv'],
    isi: [
      sub(
        'Memilih batch dari buffer',
        p('Halaman Prepast berisi antrean susu yang menunggu di buffer. Pilih satu batch penerimaan, lalu bagi isinya ke satu silo tujuan atau lebih.'),
        gambar(`${IMG}/cmd-prepast.png`, 'Antrean buffer pada halaman Prepast', 'Antrean buffer. Pilih batch untuk mulai memprepastnya ke silo.'),
      ),
      sub(
        'Mengisi & input gantung',
        ul(
          'Untuk tiap pecahan, pilih silo tujuan dan volumenya, lalu isi waktu mulai dan selesai prepast, flow rate, suhu setelah heater, dan suhu keluar produk.',
          'Karena penerimaan dan prepast kadang berjalan paralel, Anda boleh menyimpan separuh dulu tanpa mengisi waktunya. Catatan itu menjadi input gantung dan akan ditagih di Dashboard sampai dilengkapi.',
        ),
      ),
      sub(
        'Waktu selesai & Proses Kontinu',
        ul(
          'Waktu selesai dipisah jadi dua kolom: tanggal dan jam. Begitu tanggal waktu mulai diisi, tanggal selesai ikut terisi otomatis — jamnya sengaja dikosongkan karena harus diisi sesuai kejadian sebenarnya.',
          'Mencentang "Proses Kontinu" juga mengisi tanggal selesai secara otomatis dengan cara yang sama.',
          'Kalau saat menyimpan baru tanggalnya yang terisi (jam belum), aplikasi tetap mengingatnya sebagai draft — tidak hilang saat catatan ini dibuka kembali nanti, baik dari halaman Prepast maupun dialog "Lengkapi Prepast" di Data.',
        ),
        gambar(`${IMG}/cmd-prepast-selesai.png`, 'Kolom waktu selesai pada Prepast', 'Tanggal Selesai terisi otomatis dari Mulai, jamnya dikosongkan menunggu diisi sesuai kejadian sebenarnya.'),
      ),
    ],
  },

  {
    id: 'monitoring',
    judul: 'Monitoring',
    ringkas: 'Ronde pengecekan pH dan suhu tiap silo.',
    peran: ['operator', 'spv'],
    isi: [
      sub(
        'Mencatat pengecekan',
        p('Monitoring adalah ronde pengecekan berkala. Pilih silo yang dicek, lalu catat pH, suhu, dan waktu pengecekannya.'),
        gambar(`${IMG}/cmd-monitoring.png`, 'Halaman ronde pengecekan', 'Ronde pengecekan. Silo yang sudah lewat jadwalnya ditandai agar tidak terlewat.'),
        ul(
          'Setiap cek yang disimpan dibandingkan dengan cek sebelumnya pada silo yang sama. Kalau jaraknya melewati interval jadwal silo itu, catatan ini ditandai "Lewat Jadwal" secara permanen — bisa dilihat dan disaring dari halaman Data, jadi celah jadwal yang terlewat tidak hilang begitu saja saat cek berikutnya masuk.',
          'Volume silo yang 0 L saat ini tidak mengunci pengisian pH/suhu. Anda tetap bisa mencatat, misalnya untuk waktu cek yang mundur — aplikasi hanya mengingatkan untuk memastikan waktu cek yang dipilih sesuai kondisi fisik silo saat itu.',
        ),
        gambar(`${IMG}/cmd-monitoring-lewat-jadwal.png`, 'Badge Lewat Jadwal pada ronde Monitoring', 'SILO2 tertandai "Lewat Jadwal" karena melewati interval ceknya; SILO6 kosong 0 L tetap dapat diisi pH dan suhunya.'),
      ),
    ],
  },

  {
    id: 'transfer',
    judul: 'Transfer',
    ringkas: 'Mengeluarkan susu dari silo ke produksi atau silo lain.',
    peran: ['operator', 'spv'],
    isi: [
      sub(
        'Transfer keluar silo',
        ol(
          'Pilih Silo asal.',
          'Pilih Jenis: Pemakaian produksi (keluar ke tank produksi) atau Pindah silo (dipindahkan ke silo lain).',
          'Isi Volume dan Waktu transfer.',
          'Untuk pemakaian produksi, pilih Tank tujuan. Untuk pindah silo, pilih Silo tujuan.',
        ),
        gambar(`${IMG}/cmd-transfer.png`, 'Formulir transfer keluar silo', 'Kolom tujuan menyesuaikan diri: tank untuk produksi, silo untuk pindah silo.'),
      ),
      sub(
        'Batch mengikuti tangkinya',
        ul(
          'Tank CMD 2: batch otomatis terisi CMD2, tidak perlu Anda pilih.',
          'Tank MT: pilih prefiks batch (HRC, FC, dll.) lalu ketik nomornya.',
          'Pengosongan silo: tidak berbatch karena bukan pemakaian produksi.',
        ),
        p('Susu tertua di silo selalu keluar lebih dulu (FIFO), dihitung otomatis. Anda tidak perlu memilih batch mana yang keluar.'),
      ),
      sub(
        'Beberapa baris sekaligus: batch sama & tank tujuan bersama',
        ul(
          'Tombol "Tambah transfer" membuka baris baru untuk mencatat beberapa transfer dalam satu kali kirim.',
          'Kolom "Tersedia" pada tiap baris mengikuti sisa volume secara langsung: begitu satu baris memakai sebagian volume silo, baris lain yang berasal dari silo yang sama langsung menunjukkan sisanya, bukan angka volume awal.',
          'Saat mode "Batch sama" dipilih, ada field "Tank tujuan bersama" yang berlaku untuk seluruh baris sekaligus — tidak perlu memilih tank satu-satu di tiap baris.',
        ),
        gambar(`${IMG}/cmd-transfer-batch-sama.png`, 'Mode Batch sama dengan Tank tujuan bersama', 'Tank tujuan bersama dan Batch bersama berlaku untuk semua baris transfer sekaligus; kolom Tank tujuan tiap baris otomatis mengikuti.'),
      ),
    ],
  },

  {
    id: 'pengembalian',
    judul: 'Pengembalian',
    ringkas: 'Mengembalikan susu dari tank kembali ke silo.',
    peran: ['operator', 'spv'],
    isi: [
      sub(
        'Mengembalikan ke silo',
        p('Kadang susu yang sudah keluar perlu dikembalikan ke silo. Halaman ini mencatat pengembalian itu. Karena susunya sudah tercampur, asal suppliernya boleh tidak diketahui.'),
        gambar(`${IMG}/cmd-pengembalian.png`, 'Formulir pengembalian ke silo', 'Pengembalian ke silo. Volume yang kembali dihitung ulang ke stok silo tujuan.'),
      ),
    ],
  },

  {
    id: 'approval',
    judul: 'Approval',
    ringkas: 'Menyetujui atau menolak catatan yang masuk.',
    peran: ['spv'],
    isi: [
      sub(
        'Antrean persetujuan',
        p('Setiap catatan yang dibuat operator berstatus Menunggu persetujuan sampai diputuskan SPV. Halaman Approval mengumpulkan seluruh catatan itu dalam satu antrean.'),
        gambar(`${IMG}/cmd-approval.png`, 'Antrean persetujuan', 'Antrean persetujuan. Catatan dapat disetujui satu per satu atau sekaligus.'),
        ul(
          'Setujui atau tolak satu catatan, atau pilih beberapa untuk diputuskan sekaligus.',
          'Keputusan ini wewenang SPV. Admin dapat melihat antreannya, tetapi tidak memutuskan.',
        ),
      ),
    ],
  },

  {
    id: 'permintaan-koreksi',
    judul: 'Permintaan Koreksi',
    ringkas: 'Memperbaiki catatan yang sudah disetujui.',
    peran: ['operator', 'spv'],
    isi: [
      sub(
        'Alur koreksi',
        p('Catatan yang belum disetujui masih bisa disunting langsung. Tetapi catatan yang SUDAH disetujui tidak boleh diubah diam-diam, sebab itu catatan mutu. Perubahannya lewat permintaan koreksi.'),
        gambar(`${IMG}/cmd-koreksi.png`, 'Halaman permintaan koreksi', 'Permintaan koreksi. Catatan asli tetap utuh selama permintaan menunggu.'),
        ul(
          'Operator mengajukan koreksi beserta alasannya dari halaman Data.',
          'SPV meninjau: menyetujui akan menjalankan koreksinya, menolak akan membiarkan catatan aslinya.',
          'Selama menunggu, catatan aslinya tetap berlaku apa adanya.',
        ),
      ),
    ],
  },

  {
    id: 'data',
    judul: 'Data',
    ringkas: 'Mencari dan menyaring seluruh catatan.',
    peran: ['operator', 'spv', 'admin'],
    isi: [
      sub(
        'Mencari catatan',
        p('Halaman Data adalah tempat menelusuri seluruh catatan per jenis: penerimaan, prepast, transfer, monitoring, dan pengembalian.'),
        gambar(`${IMG}/cmd-data.png`, 'Halaman Data dengan filter', 'Halaman Data. Saring per status, per silo (boleh lebih dari satu), rentang tanggal, atau kata kunci.'),
        ul(
          'Saring per status, per silo (boleh memilih beberapa sekaligus dan dicari), rentang tanggal, atau ketik kode/supplier.',
          'Tombol Riwayat menampilkan seluruh perubahan sebuah catatan beserta pelaku dan alasannya.',
          'Dari sini pula Anda melengkapi input gantung, mengajukan koreksi, atau membatalkan catatan yang keliru.',
        ),
      ),
    ],
  },

  {
    id: 'export',
    judul: 'Export',
    ringkas: 'Mengunduh form GMP dan data ke Excel.',
    peran: ['spv', 'admin'],
    isi: [
      sub(
        'Mengunduh berkas',
        p('Halaman Export menghasilkan form GMP resmi dan data tabel dalam format Excel untuk keperluan audit.'),
        gambar(`${IMG}/cmd-export.png`, 'Halaman Export', 'Export. Pilih rentang tanggal, tinjau pratinjaunya, lalu unduh.'),
        ol(
          'Pilih rentang tanggal yang ingin diekspor.',
          'Tinjau pratinjaunya untuk memastikan datanya sesuai.',
          'Unduh form GMP (xlsx) atau data tabelnya.',
        ),
      ),
    ],
  },

  {
    id: 'analitik',
    judul: 'Analitik',
    ringkas: 'Grafik tren dan hal-hal yang perlu ditindak.',
    peran: ['operator', 'spv', 'admin'],
    isi: [
      sub(
        'Membaca grafik',
        p('Analitik merangkum kejadian sepanjang rentang waktu menjadi grafik: neraca harian, frekuensi input, pola jam kedatangan, suhu dan pH per silo, standing time, sampai tujuan transfer.'),
        gambar(`${IMG}/cmd-analitik.png`, 'Halaman Analitik', 'Analitik. Atur rentang tanggal dan silo di atas; seluruh grafik ikut menyesuaikan.'),
        ul(
          'Atur rentang tanggal dan saring per silo di bagian atas. Seluruh panel ikut menyesuaikan.',
          'Panel "Perlu ditindak" menyorot hal yang butuh perhatian: silo lewat jadwal cek, penyimpangan OPRP, dan lainnya.',
          'Seluruh isinya dapat diunduh ke Excel.',
        ),
      ),
    ],
  },

  {
    id: 'stock-opname',
    judul: 'Stock Opname',
    ringkas: 'Mencatat volume awal bulan tiap silo.',
    peran: ['admin'],
    isi: [
      sub(
        'Input volume awal',
        p('Stock opname mencatat volume nyata tiap silo di awal bulan, sebagai titik mula perhitungan sepanjang bulan. Ini satu-satunya input rutin milik Admin.'),
        gambar(`${IMG}/cmd-stock-opname.png`, 'Halaman Stock Opname', 'Stock opname. Isi volume tiap silo, lalu finalisasi bila sudah lengkap.'),
        p('Isi volume tiap silo baris demi baris. Finalisasi hanya bisa dilakukan bila seluruh silo sudah terisi; aplikasi akan menyebut silo mana yang masih kosong bila ada yang terlewat.'),
      ),
    ],
  },

  {
    id: 'master',
    judul: 'Master Data',
    ringkas: 'Mengelola silo, supplier, tank, dan akun pengguna.',
    peran: ['admin'],
    isi: [
      sub(
        'Mengelola data induk',
        p('Master Data adalah tempat Admin mengatur daftar acuan aplikasi: silo, supplier, tank, prefiks batch, dan akun pengguna.'),
        gambar(`${IMG}/cmd-master.png`, 'Halaman Master Data', 'Master Data. Menambah dan menyunting data acuan, tanpa pernah menghapus.'),
        ul(
          'Menambah atau menyunting entri. Tidak ada tombol hapus: data yang tidak dipakai lagi cukup dinonaktifkan, agar catatan lama yang menyebutnya tetap dapat dibaca.',
          'Membuat akun baru menghasilkan password sementara yang tampil sekali. Catat dan serahkan ke pemiliknya.',
          'Reset password untuk pengguna yang lupa: aplikasi menerbitkan password sementara baru dan mencabut sesi lamanya.',
        ),
      ),
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Komponen                                                            */
/* ------------------------------------------------------------------ */

function Blok({ blok }) {
  if (blok.jenis === 'p') return <p className="panduan__p">{blok.teks}</p>;
  if (blok.jenis === 'ul') {
    return (
      <ul className="panduan__ul">
        {blok.butir.map((b, i) => <li key={i}>{b}</li>)}
      </ul>
    );
  }
  if (blok.jenis === 'ol') {
    return (
      <ol className="panduan__ol">
        {blok.langkah.map((b, i) => <li key={i}>{b}</li>)}
      </ol>
    );
  }
  if (blok.jenis === 'gambar') {
    return (
      <figure className="panduan__gambar">
        {/* loading lazy: gambar jauh di bawah tidak diunduh sampai didekati,
            jadi halaman terbuka cepat walau berisi belasan tangkapan layar. */}
        <img src={blok.src} alt={blok.alt} loading="lazy" />
        {blok.keterangan && <figcaption>{blok.keterangan}</figcaption>}
      </figure>
    );
  }
  return null;
}

function LencanaPeran({ peran }) {
  return (
    <div className="panduan__peran-baris">
      {peran.map((r) => (
        <span key={r} className={`panduan__peran-pil panduan__peran-pil--${r}`}>
          {LABEL_PERAN[r]}
        </span>
      ))}
    </div>
  );
}

export default function Panduan() {
  const [peran, setPeran] = useState('semua');
  const [aktif, setAktif] = useState(BAB[0].id);
  const [navBuka, setNavBuka] = useState(false);

  // Bab yang tampil mengikuti peran terpilih. "Semua" menampilkan segalanya.
  const babTampil = useMemo(
    () => (peran === 'semua' ? BAB : BAB.filter((b) => b.peran.includes(peran))),
    [peran],
  );

  const refBab = useRef({});

  /*
   * Sorot bagian yang sedang dibaca (scroll-spy).
   *
   * IntersectionObserver, bukan menghitung posisi gulir sendiri di tiap
   * kejadian scroll: menghitung sendiri berarti berjalan pada setiap piksel
   * gulir dan membuat halaman tersendat. Observer hanya memberi tahu saat
   * sebuah bab benar-benar masuk atau keluar layar.
   */
  useEffect(() => {
    const amatan = new IntersectionObserver(
      (entri) => {
        const terlihat = entri
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (terlihat[0]) setAktif(terlihat[0].target.dataset.bab);
      },
      // Jendela dipersempit ke sepertiga atas layar supaya "bab aktif" adalah
      // yang sedang dibaca, bukan yang baru muncul di kaki layar.
      { rootMargin: '-20% 0px -60% 0px' },
    );

    for (const b of babTampil) {
      const el = refBab.current[b.id];
      if (el) amatan.observe(el);
    }
    return () => amatan.disconnect();
  }, [babTampil]);

  function loncatKe(id) {
    const el = refBab.current[id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setNavBuka(false);
  }

  return (
    <div className="panduan tumpuk">
      <header className="panduan__kepala">
        <span className="halaman-kepala__eyebrow">Panduan Pengguna</span>
        <h1>CMD 1 Operation</h1>
        <p className="panduan__intro">
          Cara memakai tiap halaman aplikasi, disusun mengikuti urutan menu.
          Pilih peran Anda untuk menyaring bagian yang relevan, atau pakai
          tombol navigasi mengambang di kanan untuk melompat antar bagian.
        </p>

        {/* Tab peran */}
        <div className="panduan__peran-tab" role="tablist" aria-label="Saring per peran">
          {PERAN.map((r) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={peran === r.id}
              className={`panduan__tab${peran === r.id ? ' aktif' : ''}`}
              onClick={() => setPeran(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Chip bagian */}
        <div className="panduan__chip-baris">
          {babTampil.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={`panduan__chip${aktif === b.id ? ' aktif' : ''}`}
              onClick={() => loncatKe(b.id)}
            >
              <span className="panduan__chip-no">{String(i).padStart(2, '0')}</span>
              {b.judul}
            </button>
          ))}
        </div>
      </header>

      {/* Isi dokumen */}
      <div className="panduan__isi">
        {babTampil.map((b, i) => (
          <section
            key={b.id}
            id={b.id}
            data-bab={b.id}
            ref={(el) => { refBab.current[b.id] = el; }}
            className="panduan__bab"
          >
            <span className="panduan__bab-no">Bab {String(i).padStart(2, '0')}</span>
            <h2>{b.judul}</h2>
            <p className="panduan__bab-ringkas">{b.ringkas}</p>
            <LencanaPeran peran={b.peran} />

            {b.isi.map((s, j) => (
              <div key={j} className="panduan__sub">
                {s.judul && <h3>{s.judul}</h3>}
                {s.blok.map((blok, k) => <Blok key={k} blok={blok} />)}
              </div>
            ))}
          </section>
        ))}
      </div>

      {/*
        Navigasi mengambang di kanan.

        Tombol bulat menempel di tepi kanan layar dan ikut menggulir. Menekannya
        membuka daftar seluruh bagian; menekan salah satunya meluncur ke sana.
        Daftarnya menyorot bagian yang sedang dibaca, jadi pemakainya selalu
        tahu ada di mana.
      */}
      <div className={`panduan__nav${navBuka ? ' buka' : ''}`}>
        <button
          type="button"
          className="panduan__nav-tombol"
          aria-expanded={navBuka}
          aria-label={navBuka ? 'Tutup navigasi' : 'Buka navigasi bagian'}
          onClick={() => setNavBuka((v) => !v)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="panduan__nav-ikon">
            <path d={navBuka ? 'M6 6l12 12M18 6 6 18' : 'M4 7h16M4 12h16M4 17h16'} />
          </svg>
        </button>

        {navBuka && (
          <nav className="panduan__nav-panel" aria-label="Daftar bagian">
            <div className="panduan__nav-judul">Loncat ke bagian</div>
            {babTampil.map((b, i) => (
              <button
                key={b.id}
                type="button"
                className={`panduan__nav-item${aktif === b.id ? ' aktif' : ''}`}
                onClick={() => loncatKe(b.id)}
              >
                <span className="panduan__nav-no">{String(i).padStart(2, '0')}</span>
                {b.judul}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
