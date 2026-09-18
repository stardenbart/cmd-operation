import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dengar di semua antarmuka (bukan cuma localhost) - supaya perangkat
    // lain di jaringan yang sama (mis. ponsel memindai QR kolom Paraf form
    // GMP) bisa mengaksesnya saat dev. Tidak berlaku di production - itu
    // dilayani nginx dari build statis, bukan server dev Vite ini.
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/health': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
