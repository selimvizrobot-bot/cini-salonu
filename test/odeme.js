// Ödeme testi: 004_odeme.sql kuralları (yerel Postgres) + Edge Function "odeme" (Node'da, sahte Deno ile).
// iyzico taklit sunucusu, gelen IYZWSv2 imzasını iyzico'nun RESMİ Node kütüphanesiyle yeniden hesaplayıp karşılaştırır.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execSync } = require('child_process');
const { Pool } = require('pg');
const resmi = require('iyzipay/lib/utils');

execSync(path.join(__dirname, 'kur.sh') + ' od', { stdio: 'ignore' });
const pool = new Pool({ host: '/tmp', port: 5499, user: 'postgres', database: 'od' });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const A = 'aaaaaaaa-0000-0000-0000-00000000000a', B = 'bbbbbbbb-0000-0000-0000-00000000000b';

async function as(role, uid, sql, p) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role ' + role);
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [uid || '']);
    const r = await c.query(sql, p); await c.query('commit'); return { rows: r.rows };
  } catch (e) { await c.query('rollback'); return { err: e.message }; } finally { c.release(); }
}
const svc = (sql, p) => as('service_role', null, sql, p);
const cuzdan = async u => (await pool.query('select elmas from public.wallets where user_id=$1', [u])).rows[0].elmas;

// ───────── sahte ortam ─────────
const SB_URL = 'https://proje.supabase.co', SECRET = 'sb_secret_test', API = 'sandbox-apikey', SIR = 'sandbox-sirkey';
const ENV = { SUPABASE_URL: SB_URL, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_test' }),
  IYZICO_API_KEY: API, IYZICO_SECRET_KEY: SIR, SITE_URL: 'https://site.test/cini/' };
const JWT = { 'eyJ.A': { id: A, email: 'a@x.test' }, 'eyJ.B': { id: B, email: 'b@x.test' } };
const iyz = { init: [], senaryo: {}, imzaHatasi: 0, n: 0 };
const H = (n, o) => new Response(o === undefined ? null : JSON.stringify(o), { status: n, headers: { 'Content-Type': 'application/json' } });
const sig = a => crypto.createHmac('sha256', SIR).update(a.join(':')).digest('hex');
const fy = v => { let s = String(v); if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; };

async function rest(u, init) {
  const [yol, qs] = u.pathname.replace('/rest/v1/', '').split('?').concat(u.search.slice(1)).slice(0, 2);
  const body = init.body ? JSON.parse(init.body) : null;
  if (init.headers.apikey !== SECRET || init.headers.Authorization) return H(401, { message: 'anahtar' });
  if (yol === 'rpc/odeme_tamamla') { const r = await svc('select public.odeme_tamamla($1,$2) v', [body.p_id, body.p_payment_id]); return r.err ? H(400, { message: r.err }) : H(200, r.rows[0].v); }
  const w = [], p = [];
  for (const [k, v] of new URLSearchParams(qs)) {
    if (k === 'select') continue;
    const [op, ...rest] = v.split('.'), val = rest.join('.');
    if (op === 'eq') { p.push(val); w.push(`${k} = $${p.length}`); }
    if (op === 'gte') { p.push(val); w.push(`${k} >= $${p.length}`); }
    if (op === 'in') { p.push(val.replace(/^\(|\)$/g, '').split(',')); w.push(`${k} = any($${p.length})`); }
  }
  const where = w.length ? ' where ' + w.join(' and ') : '';
  let r;
  if (init.method === 'POST') { const k = Object.keys(body); r = await svc(`insert into public.odemeler (${k}) values (${k.map((_, i) => '$' + (i + 1))}) returning *`, k.map(x => body[x])); return r.err ? H(400, { message: r.err }) : H(201, r.rows); }
  if (init.method === 'PATCH') { const k = Object.keys(body); r = await svc(`update public.odemeler set ${k.map((x, i) => `${x} = $${p.length + i + 1}`)}${where}`, p.concat(k.map(x => body[x]))); return r.err ? H(400, { message: r.err }) : H(204); }
  r = await svc(`select * from public.odemeler${where}`, p);
  return r.err ? H(400, { message: r.err }) : H(200, r.rows);
}

async function iyzicoSahte(u, init) {
  const govde = JSON.parse(init.body), rnd = init.headers['x-iyzi-rnd'];
  const beklenen = resmi.generateAuthorizationHeaderV2('IYZWSv2', API, ':', SIR, u.pathname, govde, rnd);
  if (init.headers.Authorization !== beklenen) { iyz.imzaHatasi++; return H(200, { status: 'failure', errorMessage: 'imza' }); }
  if (u.pathname === '/payment/iyzipos/checkoutform/initialize/auth/ecom') {
    iyz.init.push(govde); const token = 'tok-' + (++iyz.n) + '-abcdef';
    iyz[token] = govde;
    return H(200, { status: 'success', token, paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=' + token, conversationId: govde.conversationId, signature: sig([govde.conversationId, token]) });
  }
  if (u.pathname === '/payment/iyzipos/checkoutform/auth/ecom/detail') {
    const g = iyz[govde.token]; if (!g) return H(200, { status: 'failure', errorMessage: 'bulunamadı' });
    const s = iyz.senaryo[govde.token] || {};
    if (s.status === 'failure') return H(200, { status: 'failure', errorMessage: 'Ödeme bulunamadı' });
    const r = { status: 'success', paymentStatus: s.paymentStatus || 'SUCCESS', paymentId: 'PAY' + govde.token.split('-')[1], currency: 'TRY',
      basketId: g.basketId, conversationId: govde.conversationId, price: s.price || Number(g.price), paidPrice: s.paidPrice || Number(g.paidPrice),
      token: govde.token, fraudStatus: s.fraudStatus === undefined ? 1 : s.fraudStatus };
    r.signature = s.imza || sig([r.paymentStatus, r.paymentId, r.currency, r.basketId, r.conversationId, fy(r.paidPrice), fy(r.price), r.token]);
    return H(200, r);
  }
  return H(404, {});
}

async function sahteFetch(adres, init = {}) {
  const u = new URL(adres); init.headers = init.headers || {};
  if (adres.startsWith(SB_URL + '/auth/v1/user')) { const t = (init.headers.Authorization || '').replace('Bearer ', ''); return JWT[t] ? H(200, JWT[t]) : H(401, { msg: 'jwt' }); }
  if (adres.startsWith(SB_URL + '/rest/v1/')) return rest(u, init);
  if (u.origin === 'https://sandbox-api.iyzipay.com') return iyzicoSahte(u, init);
  throw new Error('beklenmeyen adres ' + adres);
}

let handler;
new Function('Deno', 'fetch', fs.readFileSync(path.join(__dirname, '..', 'supabase', 'functions', 'odeme', 'index.ts'), 'utf8'))(
  { env: { get: k => ENV[k] }, serve: h => { handler = h; } }, sahteFetch);
const cagir = async (o, jwt) => { const r = await handler(new Request('https://f/odeme', { method: 'POST', headers: { 'content-type': 'application/json', ...(jwt ? { authorization: 'Bearer ' + jwt } : {}), 'x-forwarded-for': '85.1.2.3, 10.0.0.1' }, body: JSON.stringify(o) })); return { s: r.status, j: await r.json(), h: r.headers }; };
const donus = async token => { const r = await handler(new Request('https://f/odeme', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(token) })); return { s: r.status, yer: r.headers.get('location') }; };
const F = { ad: 'Selim', soyad: 'Yılmaz', tel: '0555 111 22 33', sehir: 'İstanbul', adres: 'Örnek Mah. 1. Sok. No 2' };
const satir = async id => (await pool.query('select * from public.odemeler where id=$1', [id])).rows[0];
const sonToken = () => 'tok-' + iyz.n + '-abcdef';
const sonId = () => iyz.init[iyz.init.length - 1].conversationId;

(async () => {
  await pool.query(`insert into auth.users values ($1,'a@x.test'),($2,'b@x.test')`, [A, B]);
  await pool.query(`insert into public.profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values ($1,'Odeme_A','1985-01-01','erkek','kadin',now())`, [A]);

  console.log('Veritabanı kuralları');
  let r = await svc(`insert into public.odemeler (user_id,paket,elmas,tutar) values ($1,'e50',1,0.01) returning elmas,tutar,durum`, [A]);
  ok(r.rows && r.rows[0].elmas === 50 && r.rows[0].tutar === '29.99' && r.rows[0].durum === 'bekliyor', 'Fiyat ve elmas sunucudan: 50 elmas / 29.99 (gönderilen 1 / 0.01 yok sayıldı)');
  const id1 = (await pool.query('select id from public.odemeler limit 1')).rows[0].id;
  r = await svc(`insert into public.odemeler (user_id,paket) values ($1,'e999')`, [A]); ok(/Geçersiz paket/.test(r.err), 'Bilinmeyen paket reddedildi');
  r = await svc(`insert into public.odemeler (user_id,paket) values ($1,'e50')`, [B]); ok(/profilin olmalı/.test(r.err), 'Profili olmayan alamaz');
  r = await svc(`update public.odemeler set durum='odendi' where id=$1`, [id1]); ok(/doğrulamayla/.test(r.err), 'Elle "ödendi" yapılamaz');
  await svc(`update public.odemeler set elmas=99999, tutar=0.01, user_id=$2 where id=$1`, [id1, B]);
  const s1 = await satir(id1); ok(s1.elmas === 50 && s1.tutar === '29.99' && s1.user_id === A, 'Miktar, tutar ve sahip sonradan değişmez');
  const w0 = await cuzdan(A);
  r = await svc('select public.odeme_tamamla($1,$2) v', [id1, 'P1']); const w1 = await cuzdan(A);
  ok(r.rows[0].v === 'ok' && w1 === w0 + 50, `odeme_tamamla elmas yükledi (${w0} → ${w1})`);
  r = await svc('select public.odeme_tamamla($1,$2) v', [id1, 'P1']);
  ok(r.rows[0].v === 'zaten' && (await cuzdan(A)) === w1, 'Aynı ödeme ikinci kez yüklenmedi');
  await svc(`update public.odemeler set durum='hata' where id=$1`, [id1]); ok((await satir(id1)).durum === 'odendi', 'Ödenmiş kayıt geri alınamaz');
  const led = await pool.query(`select delta,reason,ref from public.elmas_ledger where user_id=$1 and reason='satin_alma'`, [A]);
  ok(led.rows.length === 1 && led.rows[0].ref === 'iyzico:P1', 'Hareket dökümü: satin_alma +50, ref iyzico:P1');
  r = await as('authenticated', A, 'select id,durum,elmas from public.odemeler'); ok(r.rows && r.rows.length === 1, 'Kullanıcı kendi ödemesini görür');
  r = await as('authenticated', B, 'select id from public.odemeler'); ok(r.rows && r.rows.length === 0, 'Başkasının ödemesi görünmez');
  r = await as('authenticated', A, 'select token from public.odemeler'); ok(/permission/.test(r.err || ''), 'Token sütunu istemciye kapalı');
  r = await as('authenticated', A, `insert into public.odemeler (user_id,paket) values ($1,'e50')`, [A]); ok(/permission/.test(r.err || ''), 'İstemci ödeme kaydı yazamaz');
  r = await as('authenticated', A, 'select public.odeme_tamamla($1,$2)', [id1, 'x']); ok(/permission/.test(r.err || ''), 'İstemci odeme_tamamla çağıramaz');
  r = await as('authenticated', A, 'select public.admin_elmas_ekle($1,1000)', [A]); ok(/permission/.test(r.err || ''), 'İstemci admin_elmas_ekle çağıramaz');

  console.log('Fonksiyon: başlatma');
  let c = await handler(new Request('https://f/odeme', { method: 'OPTIONS' }));
  ok(c.status === 200 && c.headers.get('access-control-allow-origin') === '*', 'CORS ön isteği');
  c = await cagir({ islem: 'baslat', paket: 'e50', fatura: F }); ok(c.s === 401, 'Jetonsuz istek 401');
  c = await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'sb_publishable_test'); ok(c.s === 401, 'Yalnız açık anahtarla istek 401');
  c = await cagir({ islem: 'baslat', paket: 'e50', fatura: { ...F, tel: '123' } }, 'eyJ.A'); ok(c.s === 400 && /Fatura/.test(c.j.hata), 'Hatalı telefon reddedildi');
  c = await cagir({ islem: 'baslat', paket: 'e7', fatura: F }, 'eyJ.A'); ok(c.s === 400 && /Geçersiz paket/.test(c.j.hata), 'Geçersiz paket: ' + c.j.hata);
  c = await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.B'); ok(c.s === 400 && /profilin/.test(c.j.hata), 'Profilsiz kullanıcı: ' + c.j.hata);
  const n0 = iyz.init.length;
  c = await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A');
  ok(c.s === 200 && /^https:\/\/sandbox-cpp\.iyzipay\.com\?token=tok-/.test(c.j.url), 'Ödeme sayfası adresi döndü');
  ok(iyz.imzaHatasi === 0 && iyz.init.length === n0 + 1, 'IYZWSv2 imzası resmi iyzico kütüphanesiyle birebir aynı');
  const g = iyz.init[iyz.init.length - 1];
  ok(g.price === '29.99' && g.paidPrice === '29.99' && g.basketItems.length === 1 && g.basketItems[0].price === '29.99' && g.basketItems[0].itemType === 'VIRTUAL', 'Tutar 29.99, sepet tek sanal ürün');
  ok(g.buyer.gsmNumber === '+905551112233' && g.buyer.identityNumber === '11111111111' && g.buyer.ip === '85.1.2.3' && g.buyer.email === 'a@x.test' && g.buyer.city === 'İstanbul', 'Alıcı bilgileri doğru biçimde');
  ok(g.callbackUrl === SB_URL + '/functions/v1/odeme' && g.currency === 'TRY' && g.locale === 'tr' && !g.shippingAddress, 'Dönüş adresi, TRY, kargo adresi yok');
  const t1 = sonToken(), o1 = sonId();
  ok((await satir(o1)).token === t1, 'Token kayda yazıldı');

  console.log('Fonksiyon: iyzico dönüşü');
  let wA = await cuzdan(A);
  let d = await donus(t1); ok(d.s === 303 && d.yer === 'https://site.test/cini/#odeme-ok', 'Başarılı ödeme → siteye #odeme-ok');
  ok((await cuzdan(A)) === wA + 50 && (await satir(o1)).durum === 'odendi' && (await satir(o1)).iyzico_payment_id === 'PAY' + t1.split('-')[1], `50 elmas yüklendi (${wA} → ${await cuzdan(A)})`);
  d = await donus(t1); ok(d.yer.endsWith('#odeme-ok') && (await cuzdan(A)) === wA + 50, 'Dönüş tekrar gelse de ikinci kez yüklenmedi');
  d = await donus('tok-yok-123456'); ok(d.yer.endsWith('#odeme-hata'), 'Bilinmeyen token → #odeme-hata');
  d = await donus('<script>'); ok(d.yer.endsWith('#odeme-hata'), 'Bozuk token → #odeme-hata');

  wA = await cuzdan(A);
  await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A'); iyz.senaryo[sonToken()] = { price: 1, paidPrice: 1 };
  d = await donus(sonToken()); ok(d.yer.endsWith('#odeme-hata') && (await satir(sonId())).durum === 'hata' && (await cuzdan(A)) === wA, 'Tutarı oynanmış ödeme reddedildi, elmas yok');
  await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A'); iyz.senaryo[sonToken()] = { imza: 'bozuk' };
  d = await donus(sonToken()); ok(d.yer.endsWith('#odeme-hata') && (await satir(sonId())).durum === 'bekliyor' && (await cuzdan(A)) === wA, 'İmzası tutmayan yanıt: elmas yok, kayıt incelemeye açık kaldı');
  await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A'); iyz.senaryo[sonToken()] = { paymentStatus: 'FAILURE' };
  d = await donus(sonToken()); ok(d.yer.endsWith('#odeme-hata') && (await satir(sonId())).durum === 'hata', 'Kart reddi → hata');

  console.log('Fonksiyon: inceleme ve yeniden kontrol');
  await cagir({ islem: 'baslat', paket: 'e150', fatura: F }, 'eyJ.A'); const tI = sonToken(), oI = sonId(); iyz.senaryo[tI] = { fraudStatus: 0 };
  d = await donus(tI); ok(d.yer.endsWith('#odeme-inceleme') && (await satir(oI)).durum === 'inceleme' && (await cuzdan(A)) === wA, 'Dolandırıcılık incelemesindeki ödeme bekletildi');
  iyz.senaryo[tI] = { fraudStatus: 1 };
  c = await cagir({ islem: 'kontrol' }, 'eyJ.A'); ok(c.s === 200 && c.j.eklenen === 150 && (await cuzdan(A)) === wA + 150, 'Onay gelince kontrol 150 elmas yükledi');
  c = await cagir({ islem: 'kontrol' }, 'eyJ.A'); ok(c.j.eklenen === 0 && (await cuzdan(A)) === wA + 150, 'Tekrar kontrol: ek yükleme yok');
  await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A'); const tY = sonToken(), oY = sonId(); iyz.senaryo[tY] = { status: 'failure' };
  c = await cagir({ islem: 'kontrol' }, 'eyJ.A'); ok((await satir(oY)).durum === 'bekliyor', 'Yarım ödeme 1 saat dolmadan bekliyor');
  const cc = await pool.connect(); await cc.query(`set session_replication_role = replica; update public.odemeler set created_at = now() - interval '2 hours' where id = '${oY}'; reset session_replication_role`); cc.release();
  c = await cagir({ islem: 'kontrol' }, 'eyJ.A'); const sY = await satir(oY); ok(sY.durum === 'hata' && sY.hata === 'zaman aşımı', 'Süresi geçen yarım ödeme kapandı');

  console.log('iyzico bildirimi (webhook)');
  const bil = async (o, imza) => { const r = await handler(new Request('https://f/odeme', { method: 'POST', headers: { 'content-type': 'application/json', ...(imza ? { 'x-iyz-signature-v3': imza } : {}) }, body: JSON.stringify(o) })); return { s: r.status, j: await r.json() }; };
  const bimza = o => crypto.createHmac('sha256', SIR).update(SIR + o.iyziEventType + o.iyziPaymentId + o.token + o.paymentConversationId + o.status).digest('hex');
  wA = await cuzdan(A);
  await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A');
  let ev = { paymentConversationId: sonId(), merchantId: '1', token: sonToken(), status: 'SUCCESS', iyziReferenceCode: 'r1', iyziEventType: 'CHECKOUT_FORM_AUTH', iyziEventTime: Date.now(), iyziPaymentId: 777 };
  let b = await bil(ev, 'yanlis-imza'); ok(b.s === 401 && (await cuzdan(A)) === wA, 'Yanlış imzalı bildirim reddedildi');
  b = await bil(ev, bimza(ev)); ok(b.s === 200 && b.j.durum === 'ok' && (await cuzdan(A)) === wA + 50, 'İmzalı bildirimle (sayfa kapansa da) 50 elmas yüklendi');
  b = await bil(ev, bimza(ev)); ok(b.s === 200 && (await cuzdan(A)) === wA + 50, 'Bildirim tekrar gelse de ikinci kez yüklenmedi');
  d = await donus(ev.token); ok(d.yer.endsWith('#odeme-ok') && (await cuzdan(A)) === wA + 50, 'Bildirimden sonra gelen tarayıcı dönüşü de tek yükleme');
  await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A');
  ev = { ...ev, paymentConversationId: sonId(), token: sonToken() };
  b = await bil(ev); ok(b.s === 200 && (await cuzdan(A)) === wA + 100, 'İmzasız bildirim de çalışıyor (elmas yine iyzico sorgusuyla doğrulanıyor)');
  await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A'); iyz.senaryo[sonToken()] = { status: 'failure' };
  ev = { ...ev, paymentConversationId: sonId(), token: sonToken() };
  b = await bil(ev, bimza(ev)); ok(b.s === 503 && (await cuzdan(A)) === wA + 100, 'iyzico "başarılı" der ama sorgu doğrulamazsa yükleme yok, yeniden deneme istenir');
  b = await bil({ iyziEventType: 'CHECKOUT_FORM_AUTH', token: 'tok-olmayan-1', status: 'SUCCESS', paymentConversationId: 'x', iyziPaymentId: 1 }); ok(b.s === 200 && (await cuzdan(A)) === wA + 100, 'Bilinmeyen tokenlı sahte bildirim etkisiz');
  b = await bil({ iyziEventType: 'SUBSCRIPTION_ORDER_SUCCESS', token: 'x' }); ok(b.s === 200, 'İlgisiz olay türü sessizce geçiliyor');

  console.log('Harcama sınırı');
  const C = 'cccccccc-0000-0000-0000-00000000000c';
  await pool.query(`insert into auth.users values ($1,'c@x.test')`, [C]);
  await pool.query(`insert into public.profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values ($1,'Odeme_C','1980-05-05','kadin','erkek',now())`, [C]);
  JWT['eyJ.C'] = { id: C, email: 'c@x.test' };
  const hd = async () => (await as('authenticated', C, 'select public.harcama_durumu() v')).rows[0].v;
  const ayarla = n => as('authenticated', C, 'select public.harcama_siniri_ayarla($1) v', [n]);
  const al = p => svc(`insert into public.odemeler (user_id,paket) values ($1,$2) returning id`, [C, p]);
  let v = await hd(); ok(v.sinir == 1000 && v.harcanan == 0 && v.tavan == 1000, 'Varsayılan sınır 1000 ₺, bu ay harcama 0');
  r = await ayarla(50); ok(r.rows[0].v.sinir == 50 && r.rows[0].v.yeni === null, 'Sınırı düşürmek hemen geçerli (50 ₺)');
  r = await al('e50'); ok(!!r.rows, 'Sınır içindeki alım açıldı (29,99)');
  c = await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.C');
  ok(c.s === 400 && /harcama sınırını aşıyor \(bu ay 29,99 ₺, sınır 50,00 ₺\)/.test(c.j.hata), 'Sınırı aşan alım iyzico\'ya gitmeden durdu: ' + c.j.hata);
  r = await ayarla(500); ok(r.rows[0].v.sinir == 50 && r.rows[0].v.yeni == 500 && r.rows[0].v.yeni_tarih, 'Yükseltme hemen geçmiyor, 24 saat bekliyor');
  r = await al('e50'); ok(/aşıyor/.test(r.err || ''), 'Beklerken eski sınır geçerli');
  await pool.query(`update public.harcama_siniri set yeni_tarih = now() - interval '1 second' where user_id = $1`, [C]);
  v = await hd(); ok(v.sinir == 500 && v.yeni === null, '24 saat dolunca yeni sınır (500 ₺) geçerli');
  r = await al('e150'); ok(!!r.rows, 'Yeni sınırla alım açıldı');
  r = await ayarla(2000); ok(/0 ile 1000/.test(r.err || ''), 'Tavanın üstü reddedildi: ' + (r.err || ''));
  await ayarla(800); r = await ayarla(0); ok(r.rows[0].v.sinir == 0 && r.rows[0].v.yeni === null, 'Düşürmek bekleyen yükseltmeyi iptal ediyor');
  r = await al('e50'); ok(/aşıyor/.test(r.err || ''), 'Sınır 0 ₺ → alım kapalı');
  await pool.query(`update public.harcama_siniri set aylik = 1000 where user_id = $1`, [C]);
  const rp = await pool.connect();
  await rp.query(`set session_replication_role = replica;
    update public.odemeler set created_at = now() - interval '2 hours' where user_id = '${C}';
    insert into public.odemeler (user_id,paket,elmas,tutar,durum,created_at) values
      ('${C}','e400',400,179.99,'odendi', (date_trunc('month', now() at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul') - interval '1 minute'),
      ('${C}','e150',150,79.99,'odendi', now() - interval '3 hours'),
      ('${C}','e50',50,29.99,'hata', now() - interval '3 hours');
    reset session_replication_role`); rp.release();
  v = await hd(); ok(Number(v.harcanan) === 79.99, `Yalnız bu ayın ödenenleri sayılıyor; geçen ay, hata ve süresi geçen yarım ödemeler sayılmıyor (${v.harcanan})`);
  r = await as('anon', null, 'select public.harcama_durumu()'); ok(/permission/.test(r.err || ''), 'Girişsiz sınır okunamıyor');
  r = await as('authenticated', C, 'select public.gecerli_sinir($1)', [C]); ok(/permission/.test(r.err || ''), 'İç fonksiyonlar istemciye kapalı');
  r = await as('authenticated', C, 'select * from public.harcama_siniri'); ok(/permission/.test(r.err || ''), 'Sınır tablosu doğrudan değiştirilemiyor');

  console.log('Sınırlar');
  let son;
  for (let i = 0; i < 12; i++) { son = await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.A'); if (son.s !== 200) break; }
  ok(son.s === 400 && /Çok fazla/.test(son.j.hata), 'Saatte 10 denemeden sonra durdu: ' + son.j.hata);
  delete ENV.IYZICO_SECRET_KEY;
  c = await cagir({ islem: 'baslat', paket: 'e50', fatura: F }, 'eyJ.B'); ok(c.s === 503 && /ayarlanmadı/.test(c.j.hata), 'Anahtar yoksa açık mesaj: ' + c.j.hata);
  c = await cagir({ islem: 'yok' }, 'eyJ.A'); ok(c.s === 400, 'Bilinmeyen işlem 400');

  console.log(`\nSonuç: ${pass} geçti, ${fail} kaldı`);
  await pool.end(); process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
