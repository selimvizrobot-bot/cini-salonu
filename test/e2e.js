// Uçtan uca test: gerçek sayfa (jsdom) + gerçek şema (yerel Postgres, RLS açık).
// supabase-js yerine, aynı çağrıları SQL'e çeviren küçük bir sahte istemci kullanılır.
const fs = require('fs'), path = require('path'), { JSDOM } = require('jsdom'), { Pool } = require('pg');
require('child_process').execSync(path.join(__dirname, 'kur.sh') + ' e2e', { stdio: 'ignore' });
const pool = new Pool({ host: '/tmp', port: 5499, user: 'postgres', database: 'e2e' });
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  .replace(/window\.CINI_CONFIG=\{[^}]*\}/, "window.CINI_CONFIG={url:'http://yerel',key:'test'}");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m) } else { fail++; console.log('  ✗', m) } };

async function asUser(uid, sql, params) {
  const c = await pool.connect();
  try {
    await c.query('begin'); await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claim.sub',$1,true)", [uid || '']);
    const r = await c.query(sql, params); await c.query('commit'); return { data: r.rows, error: null };
  } catch (e) { await c.query('rollback'); return { data: null, error: { message: e.message } }; }
  finally { c.release(); }
}

function makeClient() {
  let uid = null, cb = null;
  const session = () => uid ? { user: { id: uid } } : null;
  class Q {
    constructor(t) { this.t = t; this.op = 'select'; this.w = []; this.p = []; this.ret = false; this.one = null; this.tail = ''; }
    $(v) { this.p.push(v); return '$' + this.p.length; }
    select(c) { if (this.op !== 'select') this.ret = true; else if (c) this.cols = c; return this; }
    insert(v) { this.op = 'insert'; this.v = v; return this; }
    update(v) { this.op = 'update'; this.v = v; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(k, v) { this.w.push(`${k} = ${this.$(v)}`); return this; }
    is(k) { this.w.push(`${k} is null`); return this; }
    in(k, v) { this.w.push(`${k} = any(${this.$(v)})`); return this; }
    gte(k, v) { this.w.push(`${k} >= ${this.$(v)}`); return this; }
    or(s) { const g = [...s.matchAll(/and\(([^)]*)\)/g)].map(m => '(' + m[1].split(',').map(x => { const [k, , v] = x.split('.'); return `${k} = ${this.$(v)}`; }).join(' and ') + ')'); this.w.push('(' + g.join(' or ') + ')'); return this; }
    order(k, o) { this.tail += ` order by ${k} ${o && o.ascending === false ? 'desc' : 'asc'}`; return this; }
    limit(n) { this.tail += ` limit ${+n}`; return this; }
    single() { this.one = 's'; return this; } maybeSingle() { this.one = 'm'; return this; }
    then(a, b) { return this.run().then(a, b); }
    async run() {
      const where = this.w.length ? ' where ' + this.w.join(' and ') : '', t = 'public.' + this.t;
      let sql;
      if (this.op === 'select') sql = `select ${this.cols || '*'} from ${t}${where}${this.tail}`;
      if (this.op === 'insert') { const k = Object.keys(this.v); sql = `insert into ${t} (${k.join(',')}) values (${k.map(x => this.$(this.v[x])).join(',')})` + (this.ret ? ' returning *' : ''); }
      if (this.op === 'update') { const k = Object.keys(this.v); sql = `update ${t} set ${k.map(x => `${x} = ${this.$(this.v[x])}`).join(',')}${where}` + (this.ret ? ' returning *' : ''); }
      if (this.op === 'delete') sql = `delete from ${t}${where}`;
      const r = await asUser(uid, sql, this.p);
      if (r.error) return r;
      if (this.one) { if (this.one === 's' && r.data.length !== 1) return { data: null, error: { message: 'tek satır bekleniyordu' } }; return { data: r.data[0] || null, error: null }; }
      return r;
    }
  }
  const fx = { calls: [], yanit: async () => ({ data: { url: 'https://sandbox-cpp.iyzipay.com?token=t1' }, error: null }) };
  const sb = {
    functions: { invoke: async (n, o) => { fx.calls.push({ n, body: o.body }); return fx.yanit(o.body); } },
    from: t => new Q(t),
    rpc: async (fn, a = {}) => {
      if (fn === 'discover') return asUser(uid, 'select * from public.discover($1)', [a.p_limit]);
      if (fn === 'people') return asUser(uid, 'select * from public.people($1::uuid[])', [a.ids]);
      if (fn === 'delete_me') return asUser(uid, 'select public.delete_me()', []);
      if (fn === 'harcama_durumu') { const r = await asUser(uid, 'select public.harcama_durumu() as v', []); return r.error ? r : { data: r.data[0].v, error: null }; }
      if (fn === 'harcama_siniri_ayarla') { const r = await asUser(uid, 'select public.harcama_siniri_ayarla($1) as v', [a.n]); return r.error ? r : { data: r.data[0].v, error: null }; }
      if (fn === 'oyun_bileti') { const r = await asUser(uid, 'select public.oyun_bileti($1) as v', [a.g]); return r.error ? r : { data: r.data[0].v, error: null }; }
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    auth: {
      onAuthStateChange(f) { cb = f; setTimeout(() => f('INITIAL_SESSION', session()), 0); },
      async signUp({ email }) { const r = await pool.query('insert into auth.users (id,email) values (gen_random_uuid(),$1) returning id', [email]); uid = r.rows[0].id; cb('SIGNED_IN', session()); return { data: { session: session() }, error: null }; },
      async signInWithPassword({ email }) { const r = await pool.query('select id from auth.users where email=$1', [email]); if (!r.rows.length) return { error: { message: 'Invalid login credentials' } }; uid = r.rows[0].id; cb('SIGNED_IN', session()); return { data: { session: session() }, error: null }; },
      async signOut() { uid = null; cb('SIGNED_OUT', null); return { error: null }; },
    },
  };
  return { createClient: () => sb, uid: () => uid, fx };
}

function open(hash = '') {
  const mock = makeClient(), gidilen = [];
  const dom = new JSDOM(HTML, { url: 'http://localhost/' + hash, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.matchMedia = () => ({ matches: true }); w.supabase = mock; w.CiniGit = u => gidilen.push(u); } });
  const w = dom.window, d = w.document, q = s => d.querySelector(s);
  return { w, d, q, mock, gidilen,
    click: s => { const e = typeof s === 'string' ? q(s) : s; if (!e) throw new Error('yok: ' + s); e.click(); },
    fill: (s, v) => { const e = q(s); e.value = v; },
    text: s => (q(s) || {}).textContent || '',
    tab: t => q(`.tabs button[data-t="${t}"]`).click(),
    btn: (txt, root) => [...(root || d).querySelectorAll('button')].find(b => b.textContent.trim() === txt),
  };
}

async function signup(P, email, prof) {
  P.click('#aYes'); P.tab('sosyal'); await sleep(50);
  P.fill('#aEm', email); P.fill('#aPw', 'sifre12345');
  P.click(P.btn('Kayıt ol')); await sleep(150);
  P.fill('#pNick', prof.nick); P.fill('#pBirth', prof.birth); P.q('#pGen').value = prof.gender; P.q('#pLook').value = prof.look;
  P.d.querySelectorAll('#fProf input[type=checkbox]').forEach(c => { c.checked = true; });
  P.click(P.btn('Profili oluştur')); await sleep(200);
}

(async () => {
  await pool.query('select 1');
  console.log('Giriş yapmadan oyun');
  const G = open(); await sleep(50); G.click('#aYes');
  const g0 = G.text('#coins'); G.click('#sSpin'); await sleep(80);
  ok(/Oynamak için giriş yap/.test(G.text('#mBox')) && G.text('#coins') === g0, 'Girişsiz oyun açılmadı, giriş istendi');
  G.click('#goSoc'); await sleep(50); ok(!!G.q('#fAuth'), '"Giriş / kayıt" Tanış ekranına götürdü');

  console.log('Kayıt ve profil');
  const A = open(); await sleep(50);
  await signup(A, 'selim@test', { nick: 'Selim', birth: '1979-12-09', gender: 'erkek', look: 'kadin' });
  ok(!!A.q('.stabs'), 'A (erkek) profil oluşturdu, Tanış menüsü açıldı');
  ok(A.text('#elmasN') === '20', 'Hoş geldin: 20 elmas');

  console.log('Oyunlar (masa bileti)');
  A.tab('slot'); await sleep(50);
  ok(/1 elmas/.test(A.text('#pi-slot')), 'Slot masasında bilet bilgisi görünüyor');
  const c0 = A.text('#coins'); A.click('#sSpin'); await sleep(80);
  ok(/Slot masası bileti/.test(A.text('#mBox')) && A.text('#coins') === c0, 'Bilet sorusu çıktı, para düşmeden bekliyor');
  A.click('#pGo'); await sleep(250);
  ok(A.text('#coins') !== c0, 'Bilet alındı ve slot döndü (' + c0 + ' → ' + A.text('#coins') + ')');
  ok(/bitiş saati/.test(A.text('#pi-slot')), 'Bilet süresi makinede görünüyor: ' + A.text('#pi-slot'));
  ok(A.d.querySelectorAll('#reels .cell svg').length === 9, '9 sembol çizildi');
  const c1 = A.text('#coins'); A.click('#sSpin'); await sleep(150);
  ok(A.q('#modal').hidden && A.text('#coins') !== c1, 'Aynı saat içinde ikinci tur bilet sormadan döndü');
  A.tab('poker'); A.click('#pDeal'); await sleep(80); A.click('#pGo'); await sleep(250);
  ok(A.d.querySelectorAll('#hand button.card').length === 5, 'Poker bileti alındı, 5 kart dağıtıldı');
  A.click('#hand button.card'); ok(A.q('#hand button.card').classList.contains('held'), 'Kart tutuldu');
  A.click('#pDeal'); await sleep(50); ok(A.text('#pDeal') === 'DAĞIT', 'Çekiş tamamlandı');
  const w = await pool.query("select w.elmas from public.wallets w join public.profiles p on p.id = w.user_id where p.nick = 'Selim'");
  ok(w.rows[0].elmas === 18, 'İki masa bileti 2 elmas düşürdü (20 → ' + w.rows[0].elmas + ')');
  A.click('#bWheel'); A.click('#wGo'); await sleep(120); ok(/jeton/.test(A.text('#wGo')), 'Çark ödül verdi: ' + A.text('#wGo'));
  A.q('#modal').hidden = true; A.tab('sosyal'); await sleep(50);
  const B = open(); await sleep(50);
  await signup(B, 'ayse@test', { nick: 'Ayse', birth: '1994-04-04', gender: 'kadin', look: 'erkek' });
  ok(!!B.q('.stabs'), 'B (kadın) profil oluşturdu');
  const C = open(); await sleep(50);
  await signup(C, 'cocuk@test', { nick: 'Kucuk', birth: '2011-01-01', gender: 'kadin', look: 'erkek' });
  ok(/18 yaş/.test(C.text('#pErr')) && !C.q('.stabs'), '18 yaş altı engellendi: "' + C.text('#pErr') + '"');
  const D = open(); await sleep(50);
  await signup(D, 'kopya@test', { nick: 'Selim', birth: '1990-01-01', gender: 'erkek', look: 'kadin' });
  ok(/alınmış/.test(D.text('#pErr')), 'Aynı takma ad reddedildi');

  console.log('Tanışma ve istek');
  A.click(A.btn('Kişiler')); await sleep(150);
  const cardsA = [...A.d.querySelectorAll('.pcard b')].map(b => b.textContent);
  ok(cardsA.includes('Ayse') && !cardsA.includes('Kucuk'), 'A, Ayse\'yi görüyor; reşit olmayan yok: ' + cardsA.join(','));
  ok(!/1994/.test(A.text('#sbody')) && /\d\d · Kadın/.test(A.text('#sbody')), 'Doğum tarihi görünmüyor, yalnız yaş');
  A.click(A.btn('İstek gönder')); await sleep(150);
  ok(!!A.btn('İstek gönderildi'), 'A istek gönderdi');
  B.click(B.btn('İstekler')); await sleep(150);
  ok(/Selim/.test(B.text('#sbody')), 'B gelen isteği görüyor');
  B.click(B.btn('Kabul et')); await sleep(200);

  console.log('Mesajlaşma');
  A.click(A.btn('Mesajlar')); await sleep(200);
  A.fill('#dmIn', 'Merhaba, iyi oyunlar'); A.click(A.btn('Gönder')); await sleep(150);
  ok(/Merhaba, iyi oyunlar/.test(A.text('#thread')), 'A mesaj gönderdi');
  B.click(B.btn('Mesajlar')); await sleep(200);
  ok(/Merhaba, iyi oyunlar/.test(B.text('#thread')), 'B mesajı aldı');
  A.fill('#dmIn', 'Şuraya yatır TR33 0006 1005'); A.click(A.btn('Gönder')); await sleep(150);
  ok(/IBAN/.test(A.text('#toast')) && !/TR33/.test(A.text('#thread')), 'IBAN içeren mesaj engellendi');

  console.log('Elmas ve hediye');
  ok(A.text('#elmasN') === '17', 'Mesaj 1 elmas düşürdü, IBAN reddi düşürmedi (18 → ' + A.text('#elmasN') + ')');
  A.click(A.btn('Hediye gönder')); await sleep(50);
  A.click(A.q('.gifts button[data-k="lale"]')); await sleep(250);
  ok(A.text('#elmasN') === '15' && /Lale gönderdin/.test(A.text('#thread')), 'Lale gönderildi, 2 elmas düştü (' + A.text('#elmasN') + ')');
  B.click(B.btn('Mesajlar')); await sleep(250);
  ok(/sana lale gönderdi/.test(B.text('#thread')) && B.text('#elmasN') === '20', 'B hediyeyi görüyor; B\'nin elması değişmedi (' + B.text('#elmasN') + ')');
  await pool.query("update public.wallets set elmas = 0 where user_id = (select id from public.profiles where nick = 'Selim')");
  A.fill('#dmIn', 'elmassiz mesaj'); A.click(A.btn('Gönder')); await sleep(250);
  ok(/Elmasın yetmiyor/.test(A.text('#toast')) && !A.q('#modal').hidden && /elmas/.test(A.text('#mBox')) && !/elmassiz/.test(A.text('#thread')), 'Elmas bitince mesaj gitmedi, mağaza açıldı');
  A.q('#modal').hidden = true;
  A.click(A.btn('Profilim')); await sleep(250);
  ok(/Hediye/.test(A.text('#pGifts')) && /-2 elmas/.test(A.text('#pGifts')), 'Profilde elmas geçmişi görünüyor');
  A.click(A.btn('Mesajlar')); await sleep(200);

  console.log('Masa sohbeti');
  A.tab('slot'); await sleep(100);
  A.fill('#rIn', 'Selam masa'); A.q('#fRoom').dispatchEvent(new A.w.Event('submit', { cancelable: true })); await sleep(150);
  ok(/Selam masa/.test(A.text('#rList')), 'A slot masasına yazdı');
  B.tab('slot'); await sleep(150);
  ok(/Selim: Selam masa/.test(B.text('#rList')), 'B masa mesajını görüyor');

  console.log('Engelleme ve şikâyet');
  B.click(B.q('#rList .nick')); await sleep(50);
  B.click('#xBlock'); await sleep(200);
  ok(/engellendi/.test(B.text('#toast')), 'B, A\'yı engelledi');
  B.tab('slot'); await sleep(150);
  ok(!/Selam masa/.test(B.text('#rList')), 'Engellenenin masa mesajları gizlendi');
  A.tab('sosyal'); A.click(A.btn('Mesajlar')); await sleep(200);
  ok(/Henüz arkadaşın yok/.test(A.text('#sbody')), 'Engelden sonra arkadaşlık silindi');
  const r = await pool.query("select count(*)::int n from public.messages where body like 'Merhaba%'");
  ok(r.rows[0].n === 1, 'Veritabanında yalnız geçerli mesaj var');

  console.log('Elmas satın alma (iyzico)');
  const fx = A.mock.fx, sub = () => A.q('#fBuy').dispatchEvent(new A.w.Event('submit', { cancelable: true }));
  A.click('#bShop'); await sleep(30);
  ok(A.d.querySelectorAll('#mBox [data-pk]').length === 3 && !/Kese|Sandık|Hazine/.test(A.text('#mBox')), 'Mağazada 3 elmas paketi var, jeton satılmıyor');
  A.click('#mBox [data-pk="e150"]'); await sleep(30);
  ok(!!A.q('#fBuy') && /150 elmas · 79,99/.test(A.text('#mBox h2')), 'Paket seçilince fatura formu açıldı');
  A.fill('#bAd', 'Selim'); A.fill('#bSoyad', 'Yumlu'); A.fill('#bTel', '123'); sub(); await sleep(20);
  ok(/Cep telefonunu/.test(A.text('#bE')) && fx.calls.length === 0, 'Hatalı telefon: ' + A.text('#bE'));
  A.fill('#bTel', '0555 111 22 33'); A.fill('#bSehir', 'İstanbul'); A.fill('#bAdres', 'Örnek Mah. 1. Sok. No 2'); sub(); await sleep(20);
  ok(/onayı işaretle/.test(A.text('#bE')) && fx.calls.length === 0, 'Onaysız ödeme başlamadı');
  fx.yanit = async () => ({ data: null, error: { context: { json: async () => ({ hata: 'Ödeme altyapısı henüz ayarlanmadı.' }) } } });
  A.q('#bOk').checked = true; A.q('#bCay').checked = true; A.q('#bHat').checked = true; sub(); await sleep(50);
  ok(/ayarlanmadı/.test(A.text('#bE')) && !A.q('#bGo').disabled && A.gidilen.length === 0, 'Sunucu hatası kullanıcıya gösterildi: ' + A.text('#bE'));
  fx.yanit = async () => ({ data: { url: 'https://sandbox-cpp.iyzipay.com?token=t1' }, error: null });
  sub(); await sleep(50);
  const cg = fx.calls[fx.calls.length - 1];
  ok(cg.n === 'odeme' && cg.body.islem === 'baslat' && cg.body.paket === 'e150' && cg.body.fatura.tel === '0555 111 22 33' && cg.body.fatura.sehir === 'İstanbul', 'Fonksiyon doğru paket ve fatura bilgisiyle çağrıldı');
  ok(A.gidilen[0] === 'https://sandbox-cpp.iyzipay.com?token=t1', 'iyzico ödeme sayfasına yönlendirildi');
  ok(JSON.parse(A.w.localStorage.getItem('cini-fatura')).ad === 'Selim', 'Fatura bilgisi cihazda hatırlandı');
  const R = open('#odeme-ok'); await sleep(50); R.click('#aYes'); await sleep(20);
  ok(/Ödeme alındı/.test(R.text('#mBox')) && R.w.location.hash === '', 'Dönüşte "Ödeme alındı" gösterildi, adres temizlendi');
  const H2 = open('#odeme-hata'); await sleep(50); ok(/18 yaşından/.test(H2.text('#mBox')), 'Yaş sorusu ödeme mesajından önce geldi'); H2.click('#aYes'); await sleep(20); ok(/tamamlanmadı/.test(H2.text('#mBox')), 'Başarısız dönüş mesajı');
  const aId = A.mock.uid(), e0 = +A.text('#elmasN');
  const [od] = (await pool.query(`set role service_role; insert into public.odemeler (user_id,paket) values ('${aId}','e150') returning id; reset role`))[1].rows;
  fx.yanit = async () => { await pool.query('select public.odeme_tamamla($1,$2)', [od.id, 'PAYX']); return { data: { eklenen: 150 }, error: null }; };
await A.w.CiniOdemeTest.kontrol(); await sleep(80);
  ok(fx.calls[fx.calls.length - 1].body.islem === 'kontrol' && /\+150 elmas/.test(A.text('#toast')) && +A.text('#elmasN') === e0 + 150, `Yarım kalan ödeme kontrol edilip yüklendi (${e0} → ${A.text('#elmasN')})`);
  const nC = fx.calls.length; await A.w.CiniOdemeTest.kontrol(); await sleep(30);
  ok(fx.calls.length === nC, 'Bekleyen ödeme yoksa sunucu çağrılmadı');
  A.click(A.btn('Kapat') || '#modal'); await sleep(20);

  console.log('Harcama sınırı ve satın alımlarım');
  A.click('#bShop'); await sleep(120);
  ok(/Bu ay: 79,99 ₺ \/ 1\.000,00 ₺/.test(A.text('#mHist')) && /Satın alımlarım/.test(A.text('#mHist')) && /150 elmas · 79,99 ₺/.test(A.text('#mHist')), 'Mağazada aylık harcama ve satın alım geçmişi: ' + A.text('#mHist').replace(/\s+/g, ' ').slice(0, 120));
  ok(/Yüklendi/.test(A.text('#mHist')), 'Ödenen alım "Yüklendi" görünüyor');
  A.click('#mSinir'); await sleep(120);
  ok(!!A.q('#fHs') && A.q('#fHs').value === '1000', 'Ayarlar\'da sınır seçimi (varsayılan 1.000 ₺)');
  A.q('#fHs').value = '100'; A.q('#fHs').dispatchEvent(new A.w.Event('change')); await sleep(120);
  const hs = (await pool.query('select aylik, yeni from public.harcama_siniri where user_id = $1', [aId])).rows[0];
  ok(/Sınır güncellendi/.test(A.text('#toast')) && +hs.aylik === 100 && hs.yeni === null, 'Sınır 100 ₺\'ye düştü, hemen geçerli');
  A.q('#fHs').value = '500'; A.q('#fHs').dispatchEvent(new A.w.Event('change')); await sleep(120);
  ok(/24 saat/.test(A.text('#toast')) && /yükseltmesi/.test(A.text('#fHarc')) && A.q('#fHs').value === '100', 'Yükseltme 24 saat sonraya kondu: ' + A.text('#toast'));
  A.click(A.btn('Kapat') || '#modal'); await sleep(20);

  console.log('KVKK silme');
  B.tab('sosyal'); B.click(B.btn('Profilim')); await sleep(100);
  B.click('#pDel'); B.click('#pDel'); await sleep(250);
  const z = await pool.query("select count(*)::int n from public.profiles where nick='Ayse'");
  ok(z.rows[0].n === 0 && !!B.q('#fAuth'), 'B hesabını sildi, giriş ekranına döndü');

  console.log(`\nSonuç: ${pass} geçti, ${fail} kaldı`);
  await pool.end(); process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
