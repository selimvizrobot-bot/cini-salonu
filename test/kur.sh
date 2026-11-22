#!/bin/sh
# Yerel test veritabanını sıfırdan kurar: ./kur.sh <vt_adı>
set -e
D=${1:-e2e}; P="psql -q -h /tmp -p 5499 -U postgres -v ON_ERROR_STOP=1"
dropdb -h /tmp -p 5499 -U postgres --if-exists "$D"; createdb -h /tmp -p 5499 -U postgres "$D"
cd "$(dirname "$0")"
for f in stub.sql ../supabase/schema.sql ../supabase/002_elmas.sql ../supabase/003_bilet.sql ../supabase/004_odeme.sql ../supabase/005_sinir.sql ../supabase/006_yonetim.sql; do $P -d "$D" -f "$f" >/dev/null; done
echo "kuruldu: $D"
