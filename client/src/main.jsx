import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './lib/auth.jsx';
import './styles/tokens.css';

/**
 * Invalidasi otomatis menggantikan tujuh tombol refresh manual di Power Apps
 * beserta Timer-nya (WF-6). Mutasi membatalkan query yang terpengaruh;
 * dashboard menambahkan polling terarah.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 20_000, refetchOnWindowFocus: true, retry: 1 },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

/*
 * Daftarkan service worker PWA. Hanya di konteks aman (HTTPS / localhost) -
 * di HTTP polos registrasi tidak diizinkan peramban, jadi dijaga agar tidak
 * melempar. Kegagalan registrasi tidak boleh mengganggu aplikasi.
 */
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* abaikan */ });
  });
}
