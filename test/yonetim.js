// Yönetim testi: 006_yonetim.sql yetkileri ve işlemleri + yonetim.html (jsdom, gerçek veritabanına bağlı sahte istemci)
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const { JSDOM } = require('jsdom'), { Pool } = require('pg');
execSync(path.join(__dirname, 'kur.sh') + ' yt', { stdio: 'ignore' });
const pool = new Pool({ host: '/tmp', port: 5499, user: 'postgres', database: 'yt' });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const Y = '11111111-0000-0000-0000-0000000000a1', U1 = '22222222-0000-0000-0000-0000000000b2', U2 = '33333333-0000-0000-0000-0000000000c3';
async function as(role, uid, sql, p) {
  const c = await pool.connect();
  try { await c.query('begin'); await c.query('set local role ' + role); await c.query("select set_config('request.jwt.claim.sub',$1,true)", [uid || '']);
    const r = await c.query(sql, p); await c.query('commit'); return { rows: r.rows }; }
  catch (e) { await c.query('rollback'); return { err: e.message }; } finally { c.release(); }
}
const TABLO = ['yonetim_sikayetler', 'yonetim_kullanicilar', 'yonetim_odemeler'];
async function rpcSql(uid, fn, a = {}) {
  const k = Object.keys(a), args = k.map((x, i) => `${x} => $${i + 1}`).join(', ');
  const sql = TABLO.includes(fn) ? `select * from public.${fn}(${args})` : `select public.${fn}(${args}) as v`;
  const r = await as(uid ? 'authenticated' : 'anon', uid, sql, k.map(x => a[x]));
  if (r.err) return { data: null, error: { message: r.err } };
  return { data: TABLO.includes(fn) ? r.rows : r.rows[0].v, error: null };
}
const HTML = fs.readFileSync(path.join(__dirname, '..', 'yonetim.html'), 'utf8');
function ac(uid) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/yonetim.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: uid ? { user: { id: uid } } : null } }) }, rpc: (f, a) => rpcSql(uid, f, a) }) }; } });
  const d = dom.window.document;
  return { w: dom.window, d, q: s => d.querySelector(s), t: s => (d.querySelector(s) || {}).textContent || '', tik: el => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) };
}

(async () => {
  await pool.query(`insert into auth.users values ($1,'y@x.test'),($2,'u1@x.test'),($3,'u2@x.test')`, [Y, U1, U2]);
  for (const [id, nick, g] of [[Y, 'Yonetici', 'erkek'], [U1, 'Lale_34', 'kadin'], [U2, 'Supheli_1', 'erkek']])
    await pool.query(`insert into public.profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at,city) values ($1,$2,'1985-01-01',$3,'herkes',now(),'İzmir')`, [id, nick, g]);
  await pool.query(`insert into public.yoneticiler values ($1)`, [Y]);
  const c = await pool.connect();
  await c.query('set session_replication_role = replica');
  const mid = (await c.query(`insert into public.messages (sender,receiver,body) values ($1,$2,'Bana IBAN at, para lazım') returning id`, [U2, U1])).rows[0].id;
  await c.query('reset session_replication_role'); c.release();
  await pool.query(`insert into public.reports (reporter,reported,reason,details,message_id) values ($1,$2,'dolandiricilik','Para istiyor',$3)`, [U1, U2, mid]);
  await pool.query(`insert into public.reports (reporter,reported,reason) values ($1,$2,'resit_olmayan')`, [Y, U2]);
  await as('service_role', null, `insert into public.odemeler (user_id,paket) values ($1,'e150')`, [U1]);

  console.log('Yetkiler');
  let r = await rpcSql(U1, 'yonetim_ozet'); ok(/yetkin yok/.test(r.error?.message || ''), 'Normal kullanıcı yönetim özetini göremez');
  r = await rpcSql(U1, 'yonetim_karar', { p_rapor: 1, p_karar: 'yasakla' }); ok(/yetkin yok/.test(r.error?.message || ''), 'Normal kullanıcı karar veremez');
  r = await rpcSql(U1, 'yonetim_elmas', { p_user: U1, p_n: 500, p_not: 'x' }); ok(/yetkin yok/.test(r.error?.message || ''), 'Normal kullanıcı kendine elmas ekleyemez');
  r = await rpcSql(U1, 'yonetici_mi'); ok(r.data === false, 'yonetici_mi: normal kullanıcı için hayır');
  r = await rpcSql(null, 'yonetim_ozet'); ok(/permission/.test(r.error?.message || ''), 'Girişsiz çağrı reddedildi');
  r = await as('authenticated', U1, 'select * from public.yoneticiler'); ok(/permission/.test(r.err || ''), 'Yönetici listesi okunamaz');
  r = await as('authenticated', U1, `insert into public.yoneticiler values ('${U1}')`); ok(/permission/.test(r.err || ''), 'Kimse kendini yönetici yapamaz');
  r = await as('authenticated', U1, 'select * from public.yonetim_kayit'); ok(/permission/.test(r.err || ''), 'İşlem kaydı okunamaz');

  console.log('İşlemler (veritabanı)');
  r = await rpcSql(Y, 'yonetici_mi'); ok(r.data === true, 'yonetici_mi: yönetici için evet');
  r = await rpcSql(Y, 'yonetim_ozet'); const o = r.data;
  ok(o.kullanici === 3 && o.acik_sikayet === 2 && o.incelemede === 1 && o.yasakli === 0, `Özet: 3 profil, 2 açık şikâyet, 1 incelemede (${JSON.stringify(o).slice(0, 90)})`);
  r = await rpcSql(Y, 'yonetim_sikayetler', { p_durum: 'acik', p_limit: 50 });
  const dol = r.data.find(x => x.reason === 'dolandiricilik');
  ok(r.data.length === 2 && dol.mesaj === 'Bana IBAN at, para lazım' && dol.sikayetci === 'Lale_34' && dol.hedef_sikayet === 2, 'Şikâyet listesi: kim, kimi, açıklama ve şikâyet edilen mesaj');
  r = await rpcSql(Y, 'yonetim_kullanicilar', { p_ara: 'lale', p_limit: 30 }); ok(r.data.length === 1 && r.data[0].nick === 'Lale_34', 'Takma adla arama (büyük/küçük harf duyarsız)');
  r = await rpcSql(Y, 'yonetim_kullanicilar', { p_ara: 'L_le', p_limit: 30 }); ok(r.data.length === 0, 'Aramada "_" joker değil, harf olarak aranıyor');
  r = await rpcSql(Y, 'yonetim_kullanici', { p_user: Y, p_islem: 'yasakla' }); ok(/Yönetici yasaklanamaz/.test(r.error?.message || ''), 'Yönetici yasaklanamaz');
  r = await rpcSql(Y, 'yonetim_elmas', { p_user: U1, p_n: 50, p_not: 'Telafi: ödeme gecikti' });
  const w = (await pool.query('select elmas from public.wallets where user_id=$1', [U1])).rows[0].elmas;
  const led = (await pool.query(`select delta,ref from public.elmas_ledger where user_id=$1 and reason='yonetici'`, [U1])).rows;
  ok(r.data === 70 && w === 70 && led.length === 1 && led[0].delta === 50, 'Elmas düzeltme: +50 → 70, dökümde "yonetici"');
  r = await rpcSql(Y, 'yonetim_elmas', { p_user: U1, p_n: -500, p_not: 'deneme' }); ok(/eksiye/.test(r.error?.message || ''), 'Bakiye eksiye düşürülemez');
  r = await rpcSql(Y, 'yonetim_elmas', { p_user: U1, p_n: 5000, p_not: 'deneme' }); ok(/-1000 ile 1000/.test(r.error?.message || ''), 'Tek seferde en fazla 1000');
  r = await rpcSql(Y, 'yonetim_elmas', { p_user: U1, p_n: 5, p_not: '  ' }); ok(/Açıklama/.test(r.error?.message || ''), 'Açıklamasız düzeltme yapılamaz');
  r = await rpcSql(Y, 'yonetim_odemeler', { p_limit: 10 }); ok(r.data.length === 1 && r.data[0].nick === 'Lale_34' && r.data[0].tutar === '79.99', 'Ödeme listesi');

  console.log('Yönetim sayfası');
  let P = ac(null); await sleep(150); ok(/giriş yap/.test(P.t('#app')), 'Girişsiz: giriş yapma uyarısı');
  P = ac(U1); await sleep(150); ok(/yalnız yöneticiler/.test(P.t('#app')) && P.q('#nav').hidden, 'Normal kullanıcı paneli göremez');
  P = ac(Y); await sleep(250);
  ok(/Açık şikâyet/.test(P.t('#app')) && /Bu ayki satış/.test(P.t('#app')) && P.d.querySelectorAll('#nav button').length === 4, 'Yönetici: özet kartları ve 4 sekme');
  P.tik(P.q('#nav [data-s="sikayet"]')); await sleep(250);
  ok(P.d.querySelectorAll('[data-r]').length === 2 && /Bana IBAN at/.test(P.t('#app')) && /Dolandırıcılık/.test(P.t('#app')), 'Şikâyetler kartlarda, mesaj görünüyor');
  const kart = [...P.d.querySelectorAll('[data-r]')].find(x => /Dolandırıcılık/.test(x.textContent));
  const yb = kart.querySelector('[data-k="yasakla"]'); P.tik(yb); await sleep(150);
  ok(/Emin misin/.test(yb.textContent) && (await pool.query('select banned from public.profiles where id=$1', [U2])).rows[0].banned === false, 'Yasakla ilk tıkta yalnız onay istiyor');
  P.tik(yb); await sleep(300);
  const p2 = (await pool.query('select banned from public.profiles where id=$1', [U2])).rows[0];
  const acik = (await pool.query(`select count(*)::int n from public.reports where reported=$1 and status='acik'`, [U2])).rows[0].n;
  const kayit = (await pool.query(`select islem, yonetici from public.yonetim_kayit order by id desc limit 1`)).rows[0];
  ok(p2.banned && acik === 0 && kayit.islem === 'sikayet_yasakla' && kayit.yonetici === Y, 'İkinci tıkta yasaklandı, şikâyetleri kapandı, işlem kaydı yazıldı');
  ok(/yasaklandı/.test(P.t('#toast')) && /şikâyet yok/.test(P.t('#app')), 'Liste yenilendi: açık şikâyet kalmadı');
  P.tik(P.q('#nav [data-s="kullanici"]')); await sleep(250);
  P.q('#kA').value = 'Supheli'; P.tik(P.q('#kB')); await sleep(250);
  const ku = P.q('[data-u]'); ok(P.d.querySelectorAll('[data-u]').length === 1 && /yasaklı/.test(ku.textContent), 'Kullanıcı arandı, yasaklı etiketiyle göründü');
  P.tik(ku.querySelector('[data-i="yasagi_kaldir"]')); await sleep(300);
  ok((await pool.query('select banned from public.profiles where id=$1', [U2])).rows[0].banned === false && /Yasak kaldırıldı/.test(P.t('#toast')), 'Yasak kaldırıldı');
  const k2 = P.q('[data-u]'); k2.querySelector('.eM').value = '25'; k2.querySelector('.eN').value = 'Hatalı yasak telafisi'; P.tik(k2.querySelector('[data-e]')); await sleep(300);
  ok(/Yeni bakiye: 45 elmas/.test(P.t('#toast')), 'Panelden elmas eklendi: ' + P.t('#toast'));
  P.tik(P.q('#nav [data-s="odeme"]')); await sleep(250);
  ok(/Lale_34/.test(P.t('#app')) && /79,99 ₺/.test(P.t('#app')) && /Bekliyor/.test(P.t('#app')), 'Ödemeler tablosu');
  await pool.query(`insert into public.reports (reporter,reported,reason,details) values ($1,$2,'diger','<img src=x onerror=alert(1)>')`, [U2, U1]);
  P.tik(P.q('#nav [data-s="sikayet"]')); await sleep(250);
  ok(!P.q('#app img') && /<img src=x onerror=alert\(1\)>/.test(P.t('#app')), 'Kullanıcı yazısı HTML olarak çalışmıyor, düz metin görünüyor');

  console.log(`\nSonuç: ${pass} geçti, ${fail} kaldı`);
  await pool.end(); process.exit(fail ? 1 : 0);
})().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
