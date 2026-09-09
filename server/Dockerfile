FROM docker.io/library/node:22-alpine

WORKDIR /app

# Dependensi dipasang lebih dulu agar lapisan ini di-cache selama
# package.json tidak berubah.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/
RUN npm ci --omit=dev --workspace=server || npm install --omit=dev --workspace=server

COPY server ./server
COPY db ./db

# Gagal cepat bila template form GMP tidak ikut terbawa ke konteks build.
# OneDrive Files On-Demand dapat mengirim berkas ini sebagai placeholder 0 byte
# saat rilis ditransfer, sehingga image "berhasil" dibangun tetapi unduhan xlsx
# 500 di runtime ("File not found: /app/db/templates/..."). `test -s` menuntut
# berkasnya ada DAN tidak kosong, jadi image rusak tidak pernah terkirim diam-diam.
RUN test -s db/templates/CMD1_FRM_PRD_01_rev02.xlsx \
  || (echo 'FATAL: template form GMP hilang/kosong di konteks build (hidrasi OneDrive?)' >&2; exit 1)

ENV NODE_ENV=production
# Zona waktu proses = zona pabrik. Penyimpanan tetap UTC (mysql2 timezone:'Z',
# toISOString), tetapi parsing datetime-local, batas hari, dan getHours() memakai
# zona proses. Dengan TZ=UTC, kontinuitas Prepast tertolak dan jendela tanggal
# form GMP bergeser 7 jam - keduanya benar hanya bila proses berjalan di zona
# pabrik, sebagaimana dev & test. node:alpine butuh paket tzdata agar nama zona
# ini kenal; tanpa itu TZ diam-diam kembali ke UTC.
RUN apk add --no-cache tzdata
ENV TZ=Asia/Jakarta

EXPOSE 3000

# Node menjalankan proses sebagai PID 1; --init memastikan sinyal diteruskan
# sehingga shutdown rapi di index.js benar-benar terpanggil.
CMD ["node", "server/src/index.js"]
