/**
 * Bentuk perubahan koreksi, terpisah dari rutenya.
 *
 * Ada DUA jalur masuk ke service koreksi: koreksi langsung (POST /koreksi)
 * dan persetujuan permintaan koreksi (WF-3), yang menjalankan nilai yang
 * tersimpan di `correction_request.payload_json`. Selama skema ini menempel
 * di lapis rute, jalur kedua melewatinya: nilai dari JSON tetap string,
 * lalu pecah jauh di dalam (`"1030"` bukan angka bagi hitungQtyLtr).
 *
 * Karena itu skemanya di sini, dan kedua jalur memakainya.
 */

import { z } from 'zod';
import { angkaDesimalOpsional, teksOpsional, waktu } from '../middleware/validasi.js';

const waktuOpsional = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  waktu().optional(),
);

const idOpsional = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.coerce.number().int().positive().optional(),
);

/**
 * Satu skema untuk seluruh modul.
 *
 * Field yang tidak relevan bagi suatu modul diabaikan oleh servicenya, bukan
 * ditolak: menolak akan memaksa klien tahu bentuk tiap modul, padahal
 * servicenya sudah tahu.
 */
export const skemaPerubahanKoreksi = z.object({
  volumeLtr: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  supplierId: idOpsional,
  qtyKg: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  beratJenis: angkaDesimalOpsional({ min: 0, maxDecimals: 4 }),
  nilaiTs: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  finishTime: waktuOpsional,
  prepastStart: waktuOpsional,
  prepastFinish: waktuOpsional,
  flowrate: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  tempAfterHeater: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  tempOutput: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  trfTime: waktuOpsional,
  tankId: idOpsional,
  batchPrefix: teksOpsional(10),
  batchNomor: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.union([z.string(), z.number()]).optional(),
  ),
  ph: angkaDesimalOpsional({ min: 0, maxDecimals: 2 }),
  temp: angkaDesimalOpsional({ min: -50, maxDecimals: 2 }),
  timeCheck: waktuOpsional,
  remarks: teksOpsional(),
  konfirmasiRollover: z.coerce.boolean().default(false),
});

/** Field yang boleh diusulkan lewat permintaan koreksi. */
export const FIELD_PERUBAHAN = Object.keys(skemaPerubahanKoreksi.shape);
