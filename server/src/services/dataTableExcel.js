/**
 * Export data operasional berbentuk tabel datar.
 *
 * Berbeda dari Form GMP, berkas ini tidak menggabungkan nilai proses untuk
 * mengejar tata letak dokumen. Setiap Prepast tetap satu baris. Kolom Receiving
 * diulang ketika satu penerimaan dipecah ke beberapa silo, sehingga workbook
 * dapat langsung difilter, dipivot, dan ditelusuri tanpa kehilangan data raw.
 */

import ExcelJS from 'exceljs';
import { pool } from '../db/pool.js';
import { batasTanggal } from './waktu.js';

const NAVY = 'FF17366F';
const PUTIH = 'FFFFFFFF';
const BIRU_MUDA = 'FFF3F6FA';
const GARIS = 'FFDDE4EE';

const KOLOM_RECEIVING_PREPAST = [
  ['receiving_id', 'Receiving ID', 14, 'angka'],
  ['receiving_kode', 'Kode Receiving', 22],
  ['supplier', 'Supplier', 28],
  ['receiving_selesai', 'Receiving Selesai', 21, 'tanggal'],
  ['qty_kg', 'Qty Receiving (Kg)', 19, 'angka2'],
  ['berat_jenis', 'Berat Jenis', 14, 'angka4'],
  ['receiving_qty_ltr', 'Qty Receiving (L)', 19, 'angka2'],
  ['receiving_sisa_ltr', 'Sisa Receiving (L)', 18, 'angka2'],
  ['receiving_ts', 'TS Receiving (%)', 17, 'angka2'],
  ['receiving_status', 'Status Receiving', 20],
  ['receiving_fifo', 'FIFO Receiving', 16],
  ['buffer_status', 'Status Buffer', 18],
  ['cmd_source', 'Sumber CMD', 14],
  ['receiving_operator', 'Operator Receiving', 24],
  ['receiving_approver', 'Approver Receiving', 24],
  ['receiving_disetujui', 'Receiving Disetujui', 21, 'tanggal'],
  ['receiving_remarks', 'Catatan Receiving', 36],
  ['prepast_id', 'Prepast ID', 14, 'angka'],
  ['prepast_kode', 'Kode Prepast', 22],
  ['silo_tujuan', 'Silo Tujuan', 16],
  ['volume_prepast_ltr', 'Volume Prepast (L)', 19, 'angka2'],
  ['prepast_sisa_ltr', 'Sisa Prepast (L)', 18, 'angka2'],
  ['prepast_mulai', 'Prepast Mulai', 21, 'tanggal'],
  ['prepast_selesai', 'Prepast Selesai', 21, 'tanggal'],
  ['flowrate', 'Flowrate', 13, 'angka2'],
  ['temp_after_heater', 'Temp After Heater (°C)', 22, 'angka2'],
  ['temp_output', 'Temp Output (°C)', 18, 'angka2'],
  ['prepast_ts', 'TS Prepast (%)', 15, 'angka2'],
  ['prepast_status', 'Status Prepast', 19],
  ['prepast_fifo', 'FIFO Prepast', 15],
  ['prepast_draft', 'Draft', 11, 'boolean'],
  ['prepast_operator', 'Operator Prepast', 23],
  ['prepast_approver', 'Approver Prepast', 23],
  ['prepast_disetujui', 'Prepast Disetujui', 21, 'tanggal'],
  ['prepast_remarks', 'Catatan Prepast', 36],
];

const KOLOM_TRANSFER = [
  ['id', 'Transfer ID', 14, 'angka'],
  ['kode', 'Kode Transfer', 22],
  ['jenis', 'Jenis Transfer', 24],
  ['silo_asal', 'Silo Asal', 16],
  ['tujuan', 'Tujuan', 20],
  ['volume_ltr', 'Volume (L)', 16, 'angka2'],
  ['volume_silo_sebelum_ltr', 'Volume Silo Sebelum (L)', 24, 'angka2'],
  ['batch', 'Batch', 22],
  ['waktu_transfer', 'Waktu Transfer', 21, 'tanggal'],
  ['standing_time_menit', 'Standing Time (Menit)', 22, 'angka'],
  ['tujuan_cmd', 'Tujuan CMD', 14],
  ['status', 'Status', 19],
  ['draft', 'Draft', 11, 'boolean'],
  ['operator', 'Operator', 23],
  ['approver', 'Approver', 23],
  ['disetujui_pada', 'Disetujui Pada', 21, 'tanggal'],
  ['prepast_teralokasi', 'Kode Prepast Teralokasi', 34],
  ['supplier_teralokasi', 'Supplier Teralokasi', 36],
  ['volume_teralokasi_ltr', 'Total Alokasi (L)', 19, 'angka2'],
  ['catatan_penolakan', 'Catatan Penolakan', 36],
  ['dibuat_pada', 'Dibuat Pada', 21, 'tanggal'],
  ['diperbarui_pada', 'Diperbarui Pada', 21, 'tanggal'],
];

const KOLOM_MONITORING = [
  ['id', 'Monitoring ID', 15, 'angka'],
  ['kode', 'Kode Monitoring', 22],
  ['silo', 'Silo', 16],
  ['waktu_cek', 'Waktu Cek', 21, 'tanggal'],
  ['ph', 'pH', 11, 'angka2'],
  ['suhu', 'Suhu (°C)', 13, 'angka2'],
  ['volume_snapshot_ltr', 'Volume Snapshot (L)', 21, 'angka2'],
  ['supplier_snapshot', 'Supplier Snapshot', 42],
  ['status', 'Status', 19],
  ['operator', 'Operator', 23],
  ['approver', 'Approver', 23],
  ['disetujui_pada', 'Disetujui Pada', 21, 'tanggal'],
  ['catatan_penolakan', 'Catatan Penolakan', 36],
  ['dibuat_pada', 'Dibuat Pada', 21, 'tanggal'],
  ['diperbarui_pada', 'Diperbarui Pada', 21, 'tanggal'],
];

const angka = (nilai) => (nilai === null || nilai === undefined ? null : Number(nilai));

function normalisasi(nilai, jenis) {
  if (nilai === null || nilai === undefined) return null;
  if (jenis?.startsWith('angka')) return angka(nilai);
  if (jenis === 'boolean') return Boolean(nilai) ? 'Ya' : 'Tidak';
  return nilai;
}

function formatKolom(jenis) {
  if (jenis === 'tanggal') return 'dd/mm/yyyy hh:mm';
  if (jenis === 'angka4') return '#,##0.0000';
  if (jenis === 'angka2') return '#,##0.00';
  if (jenis === 'angka') return '#,##0';
  return undefined;
}

function tambahSheet(wb, nama, definisi, data) {
  const ws = wb.addWorksheet(nama, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = definisi.map(([key, header, width]) => ({ key, header, width }));

  for (const sumber of data) {
    ws.addRow(Object.fromEntries(definisi.map(([key, , , jenis]) => [
      key,
      normalisasi(sumber[key], jenis),
    ])));
  }

  const kepala = ws.getRow(1);
  kepala.height = 30;
  kepala.eachCell((sel) => {
    sel.font = { bold: true, color: { argb: PUTIH } };
    sel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    sel.alignment = { vertical: 'middle', wrapText: true };
    sel.border = { bottom: { style: 'thin', color: { argb: NAVY } } };
  });

  definisi.forEach(([, , , jenis], indeks) => {
    const format = formatKolom(jenis);
    if (format) ws.getColumn(indeks + 1).numFmt = format;
  });

  for (let nomor = 2; nomor <= ws.rowCount; nomor += 1) {
    const baris = ws.getRow(nomor);
    baris.height = 22;
    baris.eachCell({ includeEmpty: true }, (sel) => {
      sel.alignment = { vertical: 'middle' };
      sel.border = { bottom: { style: 'hair', color: { argb: GARIS } } };
      if (nomor % 2 === 0) {
        sel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BIRU_MUDA } };
      }
    });
  }

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: definisi.length },
  };
  return ws;
}

/*
 * Export raw hanya memuat DATA AKTUAL.
 *
 * Yang dibatalkan (VOIDED), yang sudah digantikan koreksi (REVISED), dan yang
 * ditolak approver (Rejected) BUKAN keadaan aktual yang terinput - mereka
 * jejak keputusan, bukan data operasional. Menyertakannya membuat export
 * terlihat memuat penerimaan atau transfer yang sebenarnya sudah tidak
 * berlaku. Definisi "aktual" ini sama dengan yang dipakai di seluruh aplikasi
 * (mis. batch aktif silo).
 */
const STATUS_AKTUAL = ['VOIDED', 'REVISED', 'Rejected'];
const filterAktual = (kolom) => `${kolom} NOT IN (?, ?, ?)`;

/** Hanya status aktual. Rentang menentukan waktu operasionalnya. */
export async function ambilDataTabel(dariIso, sampaiIso) {
  const dari = batasTanggal(dariIso, 'mulai');
  const sampai = batasTanggal(sampaiIso, 'akhir');

  const [[receivingPrepast], [transfer], [monitoring]] = await Promise.all([
    pool.query(
      `SELECT r.id AS receiving_id, r.kode AS receiving_kode,
              sup.supplier_name AS supplier, r.finish_time AS receiving_selesai,
              r.qty_kg, r.berat_jenis, r.qty_ltr AS receiving_qty_ltr,
              r.qty_remaining_ltr AS receiving_sisa_ltr, r.nilai_ts AS receiving_ts,
              r.status_approval AS receiving_status, r.status_fifo AS receiving_fifo,
              r.buffer_status, r.cmd_source,
              ro.nama_lengkap AS receiving_operator,
              ra.nama_lengkap AS receiving_approver,
              r.approved_at AS receiving_disetujui, r.remarks AS receiving_remarks,
              p.id AS prepast_id, p.kode AS prepast_kode,
              st.silo_name AS silo_tujuan, p.vol_prepast_ltr AS volume_prepast_ltr,
              p.qty_remaining_ltr AS prepast_sisa_ltr,
              p.prepast_start AS prepast_mulai, p.prepast_finish AS prepast_selesai,
              p.flowrate_pst AS flowrate, p.temp_after_heater,
              p.temp_output_prd AS temp_output, p.nilai_ts AS prepast_ts,
              p.status_approval AS prepast_status, p.status_fifo AS prepast_fifo,
              p.is_gantung AS prepast_draft,
              po.nama_lengkap AS prepast_operator,
              pa.nama_lengkap AS prepast_approver,
              p.approved_at AS prepast_disetujui, p.remarks AS prepast_remarks
         FROM receiving r
         JOIN supplier sup ON sup.id = r.supplier_id
         JOIN operator ro ON ro.id = r.operator_id
         LEFT JOIN operator ra ON ra.id = r.approved_by_id
         LEFT JOIN prepast_record p
           ON p.receiving_id = r.id AND p.jenis_batch = 'PREPAST'
           AND ${filterAktual('p.status_approval')}
         LEFT JOIN silo st ON st.id = p.silo_tujuan_id
         LEFT JOIN operator po ON po.id = p.operator_id
         LEFT JOIN operator pa ON pa.id = p.approved_by_id
        WHERE r.finish_time BETWEEN ? AND ?
          AND ${filterAktual('r.status_approval')}
        ORDER BY r.finish_time, r.id, p.prepast_start IS NULL, p.prepast_start, p.id`,
      [...STATUS_AKTUAL, dari, sampai, ...STATUS_AKTUAL],
    ),
    pool.query(
      `SELECT t.id, t.kode, t.transfer_type AS jenis,
              sa.silo_name AS silo_asal,
              COALESCE(st.silo_name, tm.tank_name) AS tujuan,
              t.vol_ltr AS volume_ltr,
              t.vol_akt_silo_ltr AS volume_silo_sebelum_ltr,
              t.batch, t.trf_time AS waktu_transfer,
              t.standing_time_menit, t.cmd_destination AS tujuan_cmd,
              t.status_approval AS status, t.is_gantung AS draft,
              o.nama_lengkap AS operator, a.nama_lengkap AS approver,
              t.approved_at AS disetujui_pada,
              GROUP_CONCAT(DISTINCT p.kode ORDER BY al.urutan_fifo SEPARATOR ', ')
                AS prepast_teralokasi,
              GROUP_CONCAT(DISTINCT sup.supplier_name ORDER BY al.urutan_fifo SEPARATOR ', ')
                AS supplier_teralokasi,
              SUM(al.qty_allocated) AS volume_teralokasi_ltr,
              t.rejection_comment AS catatan_penolakan,
              t.created_at AS dibuat_pada, t.updated_at AS diperbarui_pada
         FROM transfer t
         JOIN silo sa ON sa.id = t.silo_asal_id
         LEFT JOIN silo st ON st.id = t.silo_tujuan_id
         LEFT JOIN tank_master tm ON tm.id = t.tank_id
         JOIN operator o ON o.id = t.operator_id
         LEFT JOIN operator a ON a.id = t.approved_by_id
         LEFT JOIN transfer_allocation al ON al.transfer_id = t.id
         LEFT JOIN prepast_record p ON p.id = al.prepast_id
         LEFT JOIN supplier sup ON sup.id = al.supplier_id
        WHERE COALESCE(t.trf_time, t.created_at) BETWEEN ? AND ?
          AND ${filterAktual('t.status_approval')}
        GROUP BY t.id, t.kode, t.transfer_type, sa.silo_name, st.silo_name,
                 tm.tank_name, t.vol_ltr, t.vol_akt_silo_ltr, t.batch,
                 t.trf_time, t.standing_time_menit, t.cmd_destination,
                 t.status_approval, t.is_gantung, o.nama_lengkap,
                 a.nama_lengkap, t.approved_at, t.rejection_comment,
                 t.created_at, t.updated_at
        ORDER BY COALESCE(t.trf_time, t.created_at), t.id`,
      [dari, sampai, ...STATUS_AKTUAL],
    ),
    pool.query(
      `SELECT m.id, m.kode, s.silo_name AS silo,
              m.time_check AS waktu_cek, m.ph_check AS ph,
              m.temp_check AS suhu,
              m.val_aktual_snapshot_ltr AS volume_snapshot_ltr,
              m.supplier_list AS supplier_snapshot,
              m.status_approval AS status,
              o.nama_lengkap AS operator, a.nama_lengkap AS approver,
              m.approved_at AS disetujui_pada,
              m.rejection_comment AS catatan_penolakan,
              m.created_at AS dibuat_pada, m.updated_at AS diperbarui_pada
         FROM monitoring m
         JOIN silo s ON s.id = m.silo_id
         JOIN operator o ON o.id = m.operator_id
         LEFT JOIN operator a ON a.id = m.approved_by_id
        WHERE m.time_check BETWEEN ? AND ?
          AND ${filterAktual('m.status_approval')}
        ORDER BY m.time_check, m.id`,
      [dari, sampai, ...STATUS_AKTUAL],
    ),
  ]);

  return { dari: dariIso, sampai: sampaiIso, receivingPrepast, transfer, monitoring };
}

export async function bangunBerkasDataTabel(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CMD 1 Operation';
  wb.created = new Date();
  wb.subject = `Data operasional ${data.dari} sampai ${data.sampai}`;

  tambahSheet(wb, 'Receiving-Prepast', KOLOM_RECEIVING_PREPAST, data.receivingPrepast);
  tambahSheet(wb, 'Transfer', KOLOM_TRANSFER, data.transfer);
  tambahSheet(wb, 'Monitoring', KOLOM_MONITORING, data.monitoring);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function namaBerkasDataTabel(dari, sampai) {
  const padat = (tanggal) => tanggal.replaceAll('-', '');
  return dari === sampai
    ? `Data_Tabel_CMD1_${padat(dari)}.xlsx`
    : `Data_Tabel_CMD1_${padat(dari)}_sd_${padat(sampai)}.xlsx`;
}

export function jumlahDataTabel(data) {
  return data.receivingPrepast.length + data.transfer.length + data.monitoring.length;
}
