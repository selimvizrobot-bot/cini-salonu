# Çini Salonu

Sosyal casino (sanal jeton, paraya çevrilemez) + gerçek oyuncular arasında güvenli tanışma.

## İçerik
- `index.html` — oyun: Slot, Video Poker, seviye/görev/çark, mola ve süre sınırı, Tanış bölümü, masa sohbeti
- `supabase/schema.sql` — veritabanı, güvenlik kuralları (RLS), 18+ ve dolandırıcılık korumaları
- `supabase/002_elmas.sql` — elmas cüzdanı (yeni hesaba 20), her özel mesaj 1 elmas, hediyeler (lale 2, çay 3, nar 5, yıldız 10)
- `supabase/003_bilet.sql` — oyun masası bileti: 1 elmas = 1 saat, oyun başına
- `test/` — yerel Postgres testleri (`test.sql`: 22 kural testi, `e2e.js`: 24 adımlı uçtan uca test)

## Kurulum
1. supabase.com'da yeni proje aç (ücretsiz katman yeterli).
2. SQL Editor → sırayla `schema.sql`, `002_elmas.sql`, `003_bilet.sql` dosyalarını yapıştır → Run.
3. Authentication → Providers → Email açık; "Confirm email" açık kalsın.
4. Project Settings → API: `Project URL` ve `anon public` anahtarını `index.html` başındaki
   `window.CINI_CONFIG={url:'...',key:'...'}` satırına yaz. (anon anahtar herkese açık olabilir; güvenliği RLS sağlar. `service_role` anahtarını asla sayfaya koyma.)
5. `index.html` dosyasını statik bir barındırmaya yükle (GitHub Pages, Netlify, Cloudflare Pages).
6. Authentication → URL Configuration → Site URL olarak bu adresi gir.

## Koruma kuralları (veritabanında zorunlu)
- 18 yaş altı profil açılamaz; doğum tarihi sonradan değiştirilemez ve kimseye gösterilmez (yalnız yaş).
- Bot / sahte profil yok; tanışma listesi karşılıklı arama tercihine göre süzülür.
- Özel mesaj yalnız karşılıklı kabul edilmiş arkadaşlar arasında; parayla açılmaz.
- Mesaj, sohbet ve profilde link ve IBAN paylaşılamaz; hız sınırları var (istek 30/gün, mesaj 20/dk, masa 1/3 sn).
- Engelleme arkadaşlığı siler, mesaj ve istekleri kapatır, masa mesajlarını gizler.
- 24 saatte 3 farklı şikâyet ya da "18 yaşından küçük olabilir" şikâyeti → profil otomatik incelemeye alınır.
- Kullanıcı hesabını ve tüm verilerini tek tuşla silebilir (KVKK).

Şikâyetleri Supabase panelinde `reports` tablosundan incele; gerekirse `profiles.banned = true` yap.

## Elmas kuralları
- Elmas yalnız mağazadan alınır; oyunda kazanılmaz, oyuncular arasında aktarılamaz. Hediyeler alana elmas/jeton olarak geçmez.
- Cüzdana istemciden yazılamaz; düşüm yalnız sunucudaki tetikleyicilerde olur.
- Satın alma onaylanınca (ödeme sağlayıcısı bağlanana kadar elle): SQL Editor →
  `select public.admin_elmas_ekle('<kullanıcı-id>', 150, 'satin_alma', '<ödeme-no>');`

## Yayına çıkmadan önce
- KVKK aydınlatma metni ve kullanım şartları (avukat onaylı) — kayıt ekranındaki onay kutuları bunlara bağlanmalı.
- Gerçek kimlikle yaş doğrulama hizmeti (şu an yaş beyana dayalı + şikâyet sistemi).
- Ödeme bağlanacaksa: mağaza (Google Play / App Store) sosyal casino kuralları, aylık harcama sınırı.
- Moderasyon: şikâyetlere 24 saat içinde dönülmesi.

## Testleri çalıştırma
```
initdb + pg_ctl ile yerel Postgres (port 5499) → psql -f test/stub.sql -f supabase/schema.sql
psql -f test/test.sql            # kural testleri
cd test && npm i && node e2e.js  # uçtan uca
```
