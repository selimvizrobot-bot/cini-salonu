# Çini Salonu

Sosyal casino (sanal jeton, paraya çevrilemez) + gerçek oyuncular arasında güvenli tanışma.

## İçerik
- `index.html` — oyun: Slot, Video Poker, seviye/görev/çark, mola ve süre sınırı, Tanış bölümü, masa sohbeti
- `supabase/schema.sql` — veritabanı, güvenlik kuralları (RLS), 18+ ve dolandırıcılık korumaları
- `supabase/002_elmas.sql` — elmas cüzdanı (yeni hesaba 20), her özel mesaj 1 elmas, hediyeler (lale 2, çay 3, nar 5, yıldız 10)
- `supabase/003_bilet.sql` — oyun masası bileti: 1 elmas = 1 saat, oyun başına
- `supabase/004_odeme.sql` — iyzico ödeme kayıtları; paket fiyatı veritabanında sabit, elmas yalnız doğrulanmış ödemeye bir kez yüklenir
- `supabase/005_sinir.sql` — aylık harcama sınırı: en fazla 1000 ₺/ay; düşürme hemen, yükseltme 24 saat sonra
- `supabase/006_yonetim.sql` — yönetim: şikâyet kararları, yasaklama, elmas düzeltme, ödeme listesi; her işlem `yonetim_kayit`'a yazılır
- `yonetim.html` — yönetim paneli (yalnız `yoneticiler` tablosundakiler açabilir; Ayarlar'da bağlantısı çıkar)
- `manifest.webmanifest`, `sw.js`, `ikon-*.png`, `og.png` — telefona uygulama gibi kurulum ve paylaşım görseli
- `supabase/functions/odeme/index.ts` — Edge Function: iyzico Checkout Form başlatma, dönüş doğrulama, yarım kalan ödeme kontrolü
- `yasal.html` — ön bilgilendirme, mesafeli satış, iade, ödeme KVKK metni (TASLAK)
- `test/` — yerel testler: `test.sql` (kurallar), `e2e.js` (57 adım, sayfa + veritabanı), `okey.js` (17), `yonetim.js` (31), `odeme.js` (58: ödeme kuralları + fonksiyon, imza resmi iyzico kütüphanesiyle karşılaştırılır)

## Kurulum
1. supabase.com'da yeni proje aç (ücretsiz katman yeterli).
2. SQL Editor → sırayla `schema.sql`, `002_elmas.sql`, `003_bilet.sql`, `004_odeme.sql`, `005_sinir.sql`, `006_yonetim.sql` dosyalarını yapıştır → Run.
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

Şikâyetleri `yonetim.html` panelinden incele: kapat, temize çıkar ya da yasakla. Yönetici eklemek için SQL Editor:
`insert into public.yoneticiler (user_id) values ('<kullanıcı-id>');`

## Elmas kuralları
- Elmas yalnız mağazadan alınır; oyunda kazanılmaz, oyuncular arasında aktarılamaz. Hediyeler alana elmas/jeton olarak geçmez.
- Cüzdana istemciden yazılamaz; düşüm yalnız sunucudaki tetikleyicilerde olur.
- Aylık harcama sınırı: varsayılan ve tavan 1000 ₺ (`sinir_tavan()`). Kullanıcı Ayarlar'dan 0–1000 ₺ arası seçer; sayılan: bu ay ödenen, incelemede ve son 1 saatte açılmış ödemeler.
- Paketler: 50 elmas 29,99 ₺ · 150 elmas 79,99 ₺ · 400 elmas 179,99 ₺ (fiyat `paket_bilgi()` içinde). Jeton satılmaz.
- Elle yükleme / telafi gerekirse: SQL Editor →
  `select public.admin_elmas_ekle('<kullanıcı-id>', 150, 'satin_alma', '<ödeme-no>');`

## iyzico ödeme
Akış: Mağaza → fatura formu + onaylar → `odeme` fonksiyonu kayıt açar, iyzico Checkout Form başlatır → kullanıcı iyzico sayfasında öder
→ iyzico, fonksiyona `token` döner → fonksiyon ödemeyi iyzico'dan sorgular (durum, tutar, sepet, imza) → `odeme_tamamla()` elmas yükler → siteye `#odeme-ok`.
Dönüş kaçarsa kullanıcı siteye girdiğinde yarım kalan ödeme yeniden sorgulanır; 1 saatte tamamlanmayan kapanır.

Kurulum:
1. Edge Functions → Deploy new function → adı `odeme`, kod `supabase/functions/odeme/index.ts` → Deploy.
2. Fonksiyon ayarı: **Verify JWT kapalı** (iyzico dönüşü jetonsuz gelir; kullanıcı istekleri fonksiyon içinde doğrulanır).
3. Edge Functions → Secrets: `IYZICO_API_KEY`, `IYZICO_SECRET_KEY` (iyzico panel → Ayarlar → Firma Ayarları).
   Sandbox varsayılandır. Canlıya geçince `IYZICO_BASE_URL=https://api.iyzipay.com` ekle ve canlı anahtarları gir.
4. Sandbox test kartı: `5528 7900 0000 0008`, ileri bir son kullanma tarihi, herhangi bir CVC.

Ödemeleri `odemeler` tablosundan izle (`durum`: bekliyor, inceleme, odendi, hata; `hata` sütunu nedeni yazar).

Canlıya geçmeden: iyzico üye işyeri başvurusu (şirket gerekir), `yasal.html` içindeki satıcı bilgileri ve hukukçu kontrolü.
iyzico'nun kabul etmediği iş modelleri arasında kumar/bahis siteleri var; başvuruda işi olduğu gibi anlat
(paraya çevrilmeyen sanal jetonlu oyun + tanışma, satılan şey yalnız elmas). Onay iyzico'nun kararıdır.

## Yayına çıkmadan önce
- KVKK aydınlatma metni ve kullanım şartları (avukat onaylı) — kayıt ekranındaki onay kutuları bunlara bağlanmalı.
- Gerçek kimlikle yaş doğrulama hizmeti (şu an yaş beyana dayalı + şikâyet sistemi).
- Ödeme: iyzico canlı onayı (yukarıda), mobil uygulama olursa Google Play / App Store kuralları.
- Moderasyon: şikâyetlere 24 saat içinde dönülmesi.

## Testleri çalıştırma
```
initdb + pg_ctl ile yerel Postgres (port 5499, soket /tmp)
cd test && npm i
./kur.sh t2 && psql -h /tmp -p 5499 -U postgres -d t2 -f test.sql   # kural testleri
node e2e.js && node okey.js && node odeme.js && node yonetim.js                       # veritabanı gerekenler kendisi kurar
```
