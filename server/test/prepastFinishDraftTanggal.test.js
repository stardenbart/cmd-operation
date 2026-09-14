/**
 * Draft tanggal Waktu Selesai — BR-16.
 *
 * `prepast_finish` adalah SATU kolom DATETIME — tidak bisa menyimpan
 * "tanggal saja". Tanpa tempat penyimpanan terpisah, tanggal Selesai yang
 * sempat diketik operator sebelum jamnya diisi hilang begitu saja begitu
 * record disimpan (Jam kosong -> prepastFinish tidak terkirim -> tidak ada
 * apa pun untuk dimuat ulang lain kali). Kolom `prepast_finish_draft_tanggal`
 * mengingat tanggal itu SAMPAI Selesai sungguhan (tanggal+jam) tersimpan.
 */
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { bangunBasisDataUji, reset, tutup, AKTOR, IP_UJI } from './bantuan/dbUji.js';

let pool;
let receiving;
let prepast;

const SILO = 2;
const T = (jam, menit = 0) => new Date(2026, 8, 14, jam, menit);

before(async () => {
  await bangunBasisDataUji();
  ({ pool } = await import('../src/db/pool.js'));
  receiving = await import('../src/services/receiving.js');
  prepast = await import('../src/services/prepast.js');
});

beforeEach(reset);
after(tutup);

async function buatReceiving(qtyKg = 5000) {
  return receiving.buat(
    { supplierId: 1, qtyKg, beratJenis: 1, nilaiTs: 12.4, finishTime: T(6) },
    AKTOR.operator, IP_UJI,
  );
}

describe('buat() — draft tanggal Selesai', () => {
  test('tersimpan saat Jam belum diisi, prepast_finish tetap NULL', async () => {
    const rcv = await buatReceiving();
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
        prepastFinishDraftTanggal: '2026-09-14',
      },
      AKTOR.operator, IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    const [[baris]] = await pool.query(
      'SELECT prepast_finish, prepast_finish_draft_tanggal FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.equal(baris.prepast_finish, null);
    assert.equal(baris.prepast_finish_draft_tanggal.toISOString().slice(0, 10), '2026-09-14');

    const konteks = await prepast.konteksPelengkapan(id, AKTOR.operator);
    assert.equal(konteks.prepastFinishDraftTanggal, '2026-09-14');
    assert.equal(konteks.prepastFinish, null);
  });

  test('tidak tersimpan (NULL) saat prepastFinish lengkap dikirim — tidak diperlukan', async () => {
    const rcv = await buatReceiving();
    const hasil = await prepast.buat(
      {
        receivingId: rcv.id,
        pecahan: [{ siloId: SILO, volumeLtr: 1000 }],
        prepastStart: T(7),
        prepastFinish: T(8),
        // Terkirim juga (mis. sisa state form) tapi harus diabaikan karena
        // Selesai sungguhan sudah ada.
        prepastFinishDraftTanggal: '2026-09-14',
      },
      AKTOR.operator, IP_UJI,
    );
    const id = hasil.dibuat[0].id;

    const [[baris]] = await pool.query(
      'SELECT prepast_finish, prepast_finish_draft_tanggal FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.ok(baris.prepast_finish);
    assert.equal(baris.prepast_finish_draft_tanggal, null);
  });
});

describe('lengkapiDraft() — draft tanggal Selesai', () => {
  async function buatDraftKosong(receivingId) {
    const hasil = await prepast.buat(
      { receivingId, pecahan: [{ siloId: SILO, volumeLtr: 1000 }], prepastStart: T(7) },
      AKTOR.operator, IP_UJI,
    );
    return hasil.dibuat[0].id;
  }

  test('mengisi hanya tanggal (Jam belum) tersimpan dan termuat ulang', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftKosong(rcv.id);

    await prepast.lengkapiDraft(id, { prepastFinishDraftTanggal: '2026-09-14' }, AKTOR.operator, IP_UJI);

    const konteks = await prepast.konteksPelengkapan(id, AKTOR.operator);
    assert.equal(konteks.prepastFinishDraftTanggal, '2026-09-14');
    assert.equal(konteks.prepastFinish, null);
  });

  test('tidak mengirim field ini sama sekali mempertahankan draft lama', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftKosong(rcv.id);

    await prepast.lengkapiDraft(id, { prepastFinishDraftTanggal: '2026-09-14' }, AKTOR.operator, IP_UJI);
    // Pelengkapan lain, tidak menyentuh Selesai sama sekali.
    await prepast.lengkapiDraft(id, { flowrate: 5.5 }, AKTOR.operator, IP_UJI);

    const konteks = await prepast.konteksPelengkapan(id, AKTOR.operator);
    assert.equal(konteks.prepastFinishDraftTanggal, '2026-09-14');
  });

  test('mengisi Jam menyusul (Selesai lengkap) mengosongkan draft — sumber kebenaran pindah ke prepast_finish', async () => {
    const rcv = await buatReceiving();
    const id = await buatDraftKosong(rcv.id);

    await prepast.lengkapiDraft(id, { prepastFinishDraftTanggal: '2026-09-14' }, AKTOR.operator, IP_UJI);
    await prepast.lengkapiDraft(id, { prepastFinish: T(8) }, AKTOR.operator, IP_UJI);

    const [[baris]] = await pool.query(
      'SELECT prepast_finish, prepast_finish_draft_tanggal FROM prepast_record WHERE id = ?',
      [id],
    );
    assert.ok(baris.prepast_finish);
    assert.equal(baris.prepast_finish_draft_tanggal, null);

    const konteks = await prepast.konteksPelengkapan(id, AKTOR.operator);
    assert.equal(konteks.prepastFinishDraftTanggal, null);
  });
});
