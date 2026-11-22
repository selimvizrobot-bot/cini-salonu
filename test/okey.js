// Okey testleri: kural motoru + 3 bilgisayarla otomatik oynanan eller (sunucusuz önizleme modu)
const fs = require('fs'), path = require('path'), { JSDOM } = require('jsdom');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/window\.CINI_CONFIG=\{[^}]*\}/, "window.CINI_CONFIG={url:'',key:''}");
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m); };

(async () => {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) { w.matchMedia = () => ({ matches: true }); } });
  const w = dom.window, d = w.document, q = s => d.querySelector(s);
  await sleep(50); q('#aYes').click();
  const { canFinish, findFinish, useful, state } = w.OkeyTest;
  const T = (c, n) => ({ c, n, f: false }), F = () => ({ c: -1, n: 0, f: true });
  const OK = { c: 2, n: 5 };                    // okey: Mavi 5
  const R = 0, Y = 1, B = 2, K = 3;

  console.log('Kural motoru');
  const base = [T(R,1),T(R,2),T(R,3), T(R,4),T(R,5),T(R,6),T(R,7), T(Y,9),T(B,9),T(K,9), T(K,11),T(K,12),T(K,13),T(K,1)];
  ok(canFinish(base, OK), 'Seriler + grup + 11-12-13-1 serisi biter');
  const withWild = base.slice(); withWild[4] = T(B,5);
  ok(canFinish(withWild, OK), 'Okey taşı (Mavi 5) eksik taşın yerine geçer');
  const fake = [T(B,3),T(B,4),F(),T(B,6), T(R,1),T(R,2),T(R,3), T(Y,9),T(B,9),T(K,9), T(K,11),T(K,12),T(K,13),T(K,1)];
  ok(canFinish(fake, OK), 'Sahte okey, okeyin değeri (Mavi 5) olarak sayılır');
  const pairs = [T(R,1),T(R,1),T(Y,2),T(Y,2),T(B,3),T(B,3),T(K,4),T(K,4),T(R,9),T(R,9),T(Y,11),T(Y,11),T(B,13),T(B,13)];
  ok(canFinish(pairs, OK), 'Yedi çift ile biter');
  const bad = base.slice(); bad[13] = T(Y,8);
  ok(!canFinish(bad, OK), 'Bir taş uymayınca bitmez');
  const wrap = [T(K,12),T(K,13),T(K,1),T(K,2), T(R,1),T(R,2),T(R,3), T(R,4),T(R,5),T(R,6), T(Y,9),T(B,9),T(K,9),T(R,9)];
  ok(!canFinish(wrap, OK), '13-1-2 dönüşü kabul edilmez');
  const grp4 = [T(R,7),T(Y,7),T(B,7),T(K,7), T(R,1),T(R,2),T(R,3), T(Y,4),T(Y,5),T(Y,6), T(K,10),T(K,11),T(K,12),T(K,13)];
  ok(canFinish(grp4, OK), '4\'lü grup + seriler biter');
  const dupGroup = [T(R,7),T(R,7),T(B,7), T(R,1),T(R,2),T(R,3), T(Y,4),T(Y,5),T(Y,6), T(K,10),T(K,11),T(K,12),T(K,13), T(Y,1)];
  ok(!canFinish(dupGroup, OK), 'Aynı renkten iki taşlı grup geçersiz');
  const fifteen = base.concat([T(Y,3)]);
  ok(findFinish(fifteen, OK) === 14, 'Fazla taş bulunup atılınca biter (findFinish)');
  ok(useful(T(R,2), base, OK) > useful(T(Y,8), base.concat([T(Y,8)]), OK), 'Yapay zekâ işe yarar taşı daha değerli görür');

  console.log('Masa');
  q('.tabs button[data-t="okey"]').click(); await sleep(20);
  ok(/Bilgisayar · Lale/.test(q('#seat1').textContent), 'Rakipler "Bilgisayar" diye etiketli');
  let wins = 0, losses = 0, draws = 0, errs = 0, turns = 0;
  w.addEventListener('error', () => errs++);
  const t0 = Date.now();
  for (let hand = 0; hand < 25; hand++) {
    const S0 = JSON.parse(w.localStorage.getItem('cini-salonu')).coins;
    q('#oNew').click(); await sleep(30);
    const O = state(); const bet = O.bet;
    if (hand === 0) {
      ok(O.hands[0].length === 15 && O.hands.slice(1).every(h => h.length === 14) && O.pile.length === 48, 'Dağıtım: 15/14/14/14 taş, ortada 48');
      ok(!O.ind.f && O.ok.n === O.ind.n % 13 + 1 && O.ok.c === O.ind.c, 'Okey göstergenin bir üstü: ' + q('#oOk').textContent);
      ok(d.querySelectorAll('#oRack .ot').length === 15, 'Istakada 15 taş çizildi');
    }
    let guard = 0;
    while (O.phase === 'play' && guard++ < 400) {
      if (O.turn !== 0) { await sleep(25); continue; }
      turns++;
      if (O.hands[0].length === 14) q('#oPile').click();
      if (O.phase !== 'play') break;
      const h = O.hands[0], fi = findFinish(h, O.ok);
      if (fi >= 0) { O.sel = fi; q('#oFin').click(); break; }
      let wi = 0, ws = 1e9; h.forEach((t, k) => { const u = useful(t, h, O.ok); if (u < ws) { ws = u; wi = k; } });
      O.sel = wi; q('#oDisc').click(); await sleep(10);
    }
    const S1 = JSON.parse(w.localStorage.getItem('cini-salonu')).coins;
    const msg = q('#oMsg').textContent;
    if (/Eli bitirdin/.test(msg)) { wins++; if (S1 - S0 !== 3 * bet) errs++; }
    else if (/berabere/.test(msg)) { draws++; if (S1 !== S0) errs++; }
    else if (/eli bitirdi/.test(msg)) { losses++; if (S0 - S1 !== bet) errs++; }
    else errs++;
  }
  ok(errs === 0, `25 el sorunsuz bitti (sen ${wins} · bilgisayar ${losses} · berabere ${draws}), jeton hesabı her elde doğru`);
  ok(wins + losses + draws === 25, 'Her el bir sonuçla kapandı');
  console.log(`  (${turns} hamle, ${Date.now() - t0} ms)`);
  q('#oNew').click(); await sleep(20); const O = state();
  O.sel = 0; q('#oFin').click(); await sleep(5);
  ok(O.phase === 'play' && /bitmiyor|çekmen/.test(q('#oMsg').textContent + q('#toast').textContent), 'Bitmeyen el "Bitir" ile kapanmıyor');
  console.log(`\nSonuç: ${pass} geçti, ${fail} kaldı`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
