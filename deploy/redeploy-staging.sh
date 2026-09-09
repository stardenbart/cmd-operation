#!/usr/bin/env sh
set -eu

CURRENT_RELEASE="/home/usersentul01/CMD1-Operation-release3"
NEXT_RELEASE="${1:?Path release baru wajib diberikan}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/home/usersentul01/CMD1-Operation-backups"
BACKUP_FILE="$BACKUP_DIR/fm_receiving-before-fr35-$STAMP.sql.gz"
PROJECT="cmd1operation"

export DOCKER_HOST="unix:///run/user/$(id -u)/podman/podman.sock"

if [ ! -d "$NEXT_RELEASE" ]; then
  echo "Release baru tidak ditemukan: $NEXT_RELEASE" >&2
  exit 1
fi

if [ ! -f "$CURRENT_RELEASE/.env" ]; then
  echo "Konfigurasi release aktif tidak ditemukan" >&2
  exit 1
fi

# Runtime secret dan sertifikat tidak pernah dibawa dari workstation.
cp "$CURRENT_RELEASE/.env" "$NEXT_RELEASE/.env"
mkdir -p "$NEXT_RELEASE/deploy/certs" "$NEXT_RELEASE/export-output" "$NEXT_RELEASE/logs"
cp -R "$CURRENT_RELEASE/deploy/certs/." "$NEXT_RELEASE/deploy/certs/"

# Direktori hasil build dari NTFS/Windows dapat tiba sebagai mode 500. Worker
# nginx berjalan sebagai user non-root dan memerlukan bit traverse pada folder.
find "$NEXT_RELEASE/client/dist" -type d -exec chmod 755 {} +
find "$NEXT_RELEASE/client/dist" -type f -exec chmod 644 {} +

mkdir -p "$BACKUP_DIR"
echo "Membuat backup database: $BACKUP_FILE"
docker exec fm_mysql sh -c \
  'exec mysqldump --single-transaction --routines --triggers --events -uroot -p"$MYSQL_ROOT_PASSWORD" fm_receiving' \
  | gzip > "$BACKUP_FILE"
test -s "$BACKUP_FILE"

echo "Baseline jumlah record:"
docker exec fm_mysql sh -c \
  'exec mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" fm_receiving -e "
    SELECT CONCAT(\"operator=\", COUNT(*)) FROM operator;
    SELECT CONCAT(\"receiving=\", COUNT(*)) FROM receiving;
    SELECT CONCAT(\"prepast=\", COUNT(*)) FROM prepast_record;
    SELECT CONCAT(\"transfer=\", COUNT(*)) FROM transfer;
    SELECT CONCAT(\"monitoring=\", COUNT(*)) FROM monitoring;
  "'

cd "$NEXT_RELEASE"

# Build mengganti image latest, tetapi container lama tetap berjalan sampai
# migrasi berhasil dan proses recreate dimulai.
docker-compose -p "$PROJECT" build server

# Ambil root password dari .env hanya ke environment proses; nilainya tidak
# dicetak. Runner mencatat migrasi sehingga berkas lama tidak dijalankan ulang.
MYSQL_ROOT_PASSWORD="$(sed -n 's/^MYSQL_ROOT_PASSWORD=//p' .env | tail -n 1)"
export MYSQL_ROOT_PASSWORD
# docker-compose 1.x di atas Podman mencoba membuat legacy container link saat
# `run`, yang tidak didukung Podman. Jalankan image hasil build langsung pada
# network project yang sama; env-file tidak dicetak dan DB tetap di service mysql.
docker run --rm --network "${PROJECT}_default" --env-file .env \
  -e DB_HOST=mysql -e DB_PORT=3306 \
  localhost/${PROJECT}_server:latest node server/src/db/migrate.js

# Seed hanya untuk tabel loss_point baru. ON DUPLICATE tidak mengubah status
# aktif yang kelak diatur Admin dan tidak menyentuh tabel transaksi.
docker exec -i fm_mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" fm_receiving' \
  < db/seeds/003_loss_points.sql

# --no-deps penting: MySQL dan semua stack lain di host tidak direcreate.
docker-compose -p "$PROJECT" up -d --no-deps --force-recreate server nginx

echo "Menunggu API sehat..."
i=0
until curl -fsS http://127.0.0.1:8080/health >/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "API tidak sehat setelah 60 detik" >&2
    docker-compose -p "$PROJECT" logs --tail=100 server nginx >&2
    exit 1
  fi
  sleep 2
done

echo "Status migrasi dan validasi setelah deploy:"
docker exec fm_mysql sh -c \
  'exec mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" fm_receiving -e "
    SELECT nama FROM schema_migration WHERE nama IN (\"016_custom_permissions.sql\",\"017_loss_points.sql\") ORDER BY nama;
    SELECT CONCAT(\"operator=\", COUNT(*)) FROM operator;
    SELECT CONCAT(\"receiving=\", COUNT(*)) FROM receiving;
    SELECT CONCAT(\"prepast=\", COUNT(*)) FROM prepast_record;
    SELECT CONCAT(\"transfer=\", COUNT(*)) FROM transfer;
    SELECT CONCAT(\"monitoring=\", COUNT(*)) FROM monitoring;
    SELECT CONCAT(\"loss_point=\", COUNT(*)) FROM loss_point;
  "'

docker-compose -p "$PROJECT" ps
echo "DEPLOY_OK backup=$BACKUP_FILE release=$NEXT_RELEASE"
