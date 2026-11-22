// Çini Salonu · iyzico ödeme (Checkout Form) — tek fonksiyon, dış bağımlılık yok.
// Supabase'te "Verify JWT" KAPALI olmalı: iyzico dönüşü jetonsuz gelir; kullanıcı rotaları jetonu burada doğrular.
//
//  POST form {token}                         iyzico dönüşü → ödemeyi iyzico'dan sorgula, elması yükle, siteye 303
//  POST JSON {islem:'baslat', paket, fatura} kullanıcı jetonuyla → {url} (iyzico ödeme sayfası)
//  POST JSON {islem:'kontrol'}               kullanıcı jetonuyla → yarım kalan ödemeleri yeniden sorgula → {eklenen}
//  POST JSON {iyziEventType,...}            iyzico bildirimi (webhook): ödemeyi iyzico'dan sorgulayıp sonuçlandır
//
// Sırlar (Dashboard → Edge Functions → Secrets): IYZICO_API_KEY, IYZICO_SECRET_KEY
// İsteğe bağlı: IYZICO_BASE_URL (varsayılan sandbox), SITE_URL, ODEME_DONUS_URL

const env = (k, d = '') => Deno.env.get(k) || d;
const IYZICO = () => env('IYZICO_BASE_URL', 'https://sandbox-api.iyzipay.com');
const SITE = () => env('SITE_URL', 'https://selimvizrobot-bot.github.io/cini-salonu/');
const SB = () => env('SUPABASE_URL');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

function anahtar(yeni, eski) {
  try { const o = JSON.parse(env(yeni) || '{}'); const v = o.default || Object.values(o)[0]; if (v) return v; } catch (_) { /* eski anahtara düş */ }
  return env(eski);
}
const GIZLI = () => anahtar('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const ACIK = () => anahtar('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY') || GIZLI();

// ── veritabanı (PostgREST, service_role) ──
async function db(yol, init = {}) {
  const k = GIZLI(), h = { apikey: k, 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (!k.startsWith('sb_')) h.Authorization = 'Bearer ' + k; // eski JWT anahtarı
  const r = await fetch(SB() + '/rest/v1/' + yol, { ...init, headers: h });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) { /* boş */ }
  if (!r.ok) { const e = new Error('db ' + r.status + ' ' + t.slice(0, 300)); e.kullanici = j && j.message; throw e; }
  return j;
}
const guncelle = (id, v) => db('odemeler?id=eq.' + id, { method: 'PATCH', body: JSON.stringify(v) });

async function kullanici(req) {
  const a = req.headers.get('authorization') || '';
  if (!/^Bearer\s+ey/.test(a)) return null; // kullanıcı oturum jetonu (JWT) şart
  const r = await fetch(SB() + '/auth/v1/user', { headers: { apikey: ACIK(), Authorization: a } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// ── iyzico IYZWSv2 imzası ──
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
async function hmac(anah, metin) {
  const k = await crypto.subtle.importKey('raw', enc.encode(anah), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(metin)));
}
async function iyzico(yol, govde) {
  const apiKey = env('IYZICO_API_KEY'), sir = env('IYZICO_SECRET_KEY');
  if (!apiKey || !sir) { const e = new Error('iyzico anahtarları eksik'); e.kullanici = 'Ödeme altyapısı henüz ayarlanmadı.'; throw e; }
  const rnd = Date.now() + '' + crypto.getRandomValues(new Uint32Array(1))[0];
  const body = JSON.stringify(govde);
  const imza = await hmac(sir, rnd + yol + body);
  const r = await fetch(IYZICO() + yol, {
    method: 'POST', body,
    headers: { Authorization: 'IYZWSv2 ' + btoa('apiKey:' + apiKey + '&randomKey:' + rnd + '&signature:' + imza), 'x-iyzi-rnd': rnd, 'Content-Type': 'application/json', Accept: 'application/json' },
  });
  return await r.json();
}
// yanıt imzası: alanlar ':' ile, fiyatlarda sondaki sıfırlar atılır (iyzico belgesi)
const fiyat = v => { let s = String(v ?? ''); if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; };
async function imzaTamam(alanlar, imza) {
  if (!imza) return true; // imza yoksa güven TLS + kimlikli sunucu çağrısında
  return (await hmac(env('IYZICO_SECRET_KEY'), alanlar.join(':'))) === imza;
}

// ── ödeme başlat ──
const temiz = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
async function baslat(req, u, g) {
  const f = g.fatura || {};
  const ad = temiz(f.ad, 50), soyad = temiz(f.soyad, 50), sehir = temiz(f.sehir, 50), adres = temiz(f.adres, 200);
  const tel = String(f.tel ?? '').replace(/\D/g, '').replace(/^90/, '').replace(/^0/, '');
  if (ad.length < 2 || soyad.length < 2 || sehir.length < 2 || adres.length < 5 || !/^5\d{9}$/.test(tel)) return json({ hata: 'Fatura bilgilerini eksiksiz yaz.' }, 400);
  if (!u.email) return json({ hata: 'Hesabında e-posta yok.' }, 400);
  if (!env('IYZICO_API_KEY') || !env('IYZICO_SECRET_KEY')) return json({ hata: 'Ödeme altyapısı henüz ayarlanmadı.' }, 503);
  let o;
  try { [o] = await db('odemeler', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: u.id, paket: String(g.paket || '') }) }); }
  catch (e) { return json({ hata: e.kullanici || 'Ödeme kaydı açılamadı.' }, 400); }
  const tutar = Number(o.tutar).toFixed(2), ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const r = await iyzico('/payment/iyzipos/checkoutform/initialize/auth/ecom', {
    locale: 'tr', conversationId: o.id, price: tutar, paidPrice: tutar, currency: 'TRY', basketId: o.id,
    paymentGroup: 'PRODUCT', callbackUrl: env('ODEME_DONUS_URL', SB() + '/functions/v1/odeme'), enabledInstallments: [1],
    buyer: { id: u.id, name: ad, surname: soyad, gsmNumber: '+90' + tel, email: u.email, identityNumber: '11111111111',
      registrationAddress: adres, city: sehir, country: 'Turkey', ...(ip ? { ip } : {}) },
    billingAddress: { contactName: ad + ' ' + soyad, city: sehir, country: 'Turkey', address: adres },
    basketItems: [{ id: o.paket, name: o.elmas + ' Elmas', category1: 'Dijital ürün', category2: 'Oyun içi elmas', itemType: 'VIRTUAL', price: tutar }],
  });
  if (r.status !== 'success' || !r.token || !r.paymentPageUrl || !(await imzaTamam([r.conversationId, r.token], r.signature))) {
    await guncelle(o.id, { durum: 'hata', hata: temiz(r.errorMessage || 'başlatılamadı', 300) });
    return json({ hata: 'Ödeme başlatılamadı' + (r.errorMessage ? ': ' + r.errorMessage : '.') }, 502);
  }
  await guncelle(o.id, { token: r.token });
  return json({ url: r.paymentPageUrl });
}

// ── ödemeyi iyzico'dan sorgula ve sonuçlandır ──
// döner: ok | inceleme | hata (kesin) | bekliyor (henüz bitmemiş) | belirsiz (iyzico'ya ulaşılamadı)
async function sonuclandir(token) {
  const [o] = (await db('odemeler?select=*&token=eq.' + encodeURIComponent(token))) || [];
  if (!o) return 'hata';
  if (o.durum === 'odendi') return 'ok';
  if (o.durum === 'hata') return 'hata';
  let r;
  try { r = await iyzico('/payment/iyzipos/checkoutform/auth/ecom/detail', { locale: 'tr', conversationId: o.id, token }); }
  catch (_) { return 'belirsiz'; }
  if (!r || r.status !== 'success') return 'bekliyor';
  if (!(await imzaTamam([r.paymentStatus, r.paymentId, r.currency, r.basketId, r.conversationId, fiyat(r.paidPrice), fiyat(r.price), r.token], r.signature))) {
    await guncelle(o.id, { hata: 'yanıt imzası uyuşmadı' }); return 'belirsiz';
  }
  if (r.paymentStatus === 'FAILURE') { await guncelle(o.id, { durum: 'hata', hata: temiz(r.errorMessage || 'ödeme başarısız', 300) }); return 'hata'; }
  if (r.paymentStatus !== 'SUCCESS') return 'bekliyor';
  const uyuyor = r.basketId === o.id && r.conversationId === o.id && r.currency === 'TRY' && r.token === token
    && Number(r.price) === Number(o.tutar) && Number(r.paidPrice) >= Number(o.tutar);
  if (!uyuyor) { await guncelle(o.id, { durum: 'hata', hata: 'tutar/sepet uyuşmadı · paymentId ' + r.paymentId }); return 'hata'; }
  if (r.fraudStatus === -1) { await guncelle(o.id, { durum: 'hata', hata: 'iyzico dolandırıcılık kontrolü reddetti' }); return 'hata'; }
  if (r.fraudStatus === 0) { await guncelle(o.id, { durum: 'inceleme' }); return 'inceleme'; }
  await db('rpc/odeme_tamamla', { method: 'POST', body: JSON.stringify({ p_id: o.id, p_payment_id: String(r.paymentId) }) });
  return 'ok';
}

async function donus(req) {
  const git = s => new Response(null, { status: 303, headers: { Location: SITE() + '#odeme-' + s } });
  try {
    const token = String((await req.formData()).get('token') || '');
    if (!/^[\w-]{8,200}$/.test(token)) return git('hata');
    const s = await sonuclandir(token);
    return git(s === 'ok' || s === 'inceleme' ? s : 'hata');
  } catch (e) { console.error(e); return git('hata'); }
}

// iyzico bildirimi. Elmas yine yalnız iyzico'dan sorgulanan sonuçla yüklenir; bildirim yalnız tetikler.
// İmza (X-IYZ-SIGNATURE-V3) geldiyse doğrulanır: HMAC-SHA256(sır, sır+olay+ödemeNo+token+konuşmaNo+durum), hex.
async function bildirim(req, g) {
  const imza = req.headers.get('x-iyz-signature-v3'), sir = env('IYZICO_SECRET_KEY');
  if (imza && sir) {
    const b = await hmac(sir, sir + (g.iyziEventType ?? '') + (g.iyziPaymentId ?? '') + (g.token ?? '') + (g.paymentConversationId ?? '') + (g.status ?? ''));
    if (b !== imza) return json({ ok: false }, 401);
  }
  const token = String(g.token || '');
  if (g.iyziEventType !== 'CHECKOUT_FORM_AUTH' || !/^[\w-]{8,200}$/.test(token)) return json({ ok: true });
  const s = await sonuclandir(token);
  // iyzico başarı diyor ama sorgu henüz doğrulamadıysa 2xx dönme: iyzico 15 dk sonra yeniden yollar
  if (g.status === 'SUCCESS' && (s === 'bekliyor' || s === 'belirsiz')) return json({ ok: false, durum: s }, 503);
  return json({ ok: true, durum: s });
}

async function kontrol(u) {
  const once = new Date(Date.now() - 7 * 864e5).toISOString();
  const rows = (await db('odemeler?select=*&user_id=eq.' + u.id + '&durum=in.(bekliyor,inceleme)&created_at=gte.' + encodeURIComponent(once))) || [];
  let eklenen = 0;
  for (const o of rows) {
    const s = o.token ? await sonuclandir(o.token) : 'bekliyor';
    if (s === 'ok') eklenen += o.elmas;
    else if (s === 'bekliyor' && Date.now() - Date.parse(o.created_at) > 36e5) await guncelle(o.id, { durum: 'hata', hata: 'zaman aşımı' });
  }
  return json({ eklenen });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ hata: 'Yalnız POST.' }, 405);
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) return donus(req);
  try {
    const g = await req.json().catch(() => ({}));
    if (g && g.iyziEventType) return await bildirim(req, g);
    const u = await kullanici(req);
    if (!u) return json({ hata: 'Giriş yapmalısın.' }, 401);
    if (g.islem === 'baslat') return await baslat(req, u, g);
    if (g.islem === 'kontrol') return await kontrol(u);
    return json({ hata: 'Bilinmeyen işlem.' }, 400);
  } catch (e) {
    console.error(e);
    return json({ hata: e.kullanici || 'Sunucu hatası, tekrar dene.' }, 500);
  }
});
