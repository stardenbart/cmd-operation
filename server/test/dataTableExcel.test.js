import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  bangunBerkasDataTabel,
  jumlahDataTabel,
  namaBerkasDataTabel,
} from '../src/services/dataTableExcel.js';

const data = {
  dari: '2026-08-01',
  sampai: '2026-08-26',
  receivingPrepast: [{
    receiving_id: 1,
    receiving_kode: 'RCV-20260801-001',
    supplier: 'Supplier A',
    qty_kg: '1000.50',
    prepast_id: 11,
    prepast_kode: 'PST-20260801-001',
    prepast_draft: 0,
  }],
  transfer: [{
    id: 21,
    kode: 'TRF-20260801-001',
    jenis: 'PEMAKAIAN PRODUKSI',
    volume_ltr: '500.25',
    draft: 0,
  }],
  monitoring: [{
    id: 31,
    kode: 'MTR-20260801-001',
    silo: 'SILO1',
    ph: '6.70',
    suhu: '4.20',
  }],
};

describe('Export Data Tabel Raw', () => {
  test('membentuk tiga sheet tabel vertikal dengan filter dan header beku', async () => {
    const buffer = await bangunBerkasDataTabel(data);
    assert.equal(buffer.subarray(0, 2).toString(), 'PK');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    assert.deepEqual(
      wb.worksheets.map((ws) => ws.name),
      ['Receiving-Prepast', 'Transfer', 'Monitoring'],
    );

    for (const ws of wb.worksheets) {
      assert.equal(ws.rowCount, 2, `${ws.name} memiliki satu header dan satu data`);
      assert.equal(ws.views[0].state, 'frozen');
      assert.equal(ws.views[0].ySplit, 1);
      assert.ok(ws.autoFilter, `${ws.name} memiliki filter kolom`);
    }

    const receiving = wb.getWorksheet('Receiving-Prepast');
    assert.equal(receiving.getCell('B2').value, 'RCV-20260801-001');
    assert.equal(receiving.getCell('E2').value, 1000.5, 'angka tidak disimpan sebagai teks');
    assert.equal(receiving.getCell('AE2').value, 'Tidak', 'boolean dibuat mudah dibaca');
  });

  test('nama berkas menjelaskan rentang dan jumlah menghitung seluruh sheet', () => {
    assert.equal(
      namaBerkasDataTabel('2026-08-01', '2026-08-26'),
      'Data_Tabel_CMD1_20260801_sd_20260826.xlsx',
    );
    assert.equal(
      namaBerkasDataTabel('2026-08-26', '2026-08-26'),
      'Data_Tabel_CMD1_20260826.xlsx',
    );
    assert.equal(jumlahDataTabel(data), 3);
  });
});
