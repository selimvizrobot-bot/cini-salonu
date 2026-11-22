\set ON_ERROR_STOP 0
\set A '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set B '''bbbbbbbb-0000-0000-0000-00000000000b'''
insert into auth.users values (:A,'ea@x'),(:B,'eb@x');
set role authenticated;
select set_config('request.jwt.claim.sub', :A, false);
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values (:A,'Elmas_A','1985-01-01','erkek','kadin',now());
select set_config('request.jwt.claim.sub', :B, false);
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values (:B,'Elmas_B','1990-01-01','kadin','erkek',now());
\echo '--- E1 hoş geldin elması (beklenen 20)'
select elmas from wallets;
\echo '--- E2 kullanıcı kendi cüzdanını yazamaz (beklenen HATA)'
update wallets set elmas = 9999;
\echo '--- E3 spend_elmas / admin_elmas_ekle istemciye kapalı (beklenen 2 HATA)'
select spend_elmas(:B, 1, 'mesaj');
select admin_elmas_ekle(:B, 1000);
select set_config('request.jwt.claim.sub', :A, false);
insert into friendships (addressee) values (:B);
select set_config('request.jwt.claim.sub', :B, false);
update friendships set status='kabul';
\echo '--- E4 B mesaj atar → 19'
insert into messages (receiver, body) values (:A, 'selam');
select elmas from wallets;
\echo '--- E5 hediye nar (5) → 14, fiyat tetikleyiciden'
insert into gifts (receiver, kind) values (:A, 'nar') returning kind, price;
select elmas from wallets;
\echo '--- E6 fiyatı istemci belirleyemez (beklenen HATA: price sütunu kapalı)'
insert into gifts (receiver, kind, price) values (:A, 'yildiz', 0);
\echo '--- E7 A, aldığı hediyeyi görür ama A nın elması değişmez (beklenen 20)'
select set_config('request.jwt.claim.sub', :A, false);
select kind from gifts;
select elmas from wallets;
\echo '--- E8 B elması bitirince mesaj atamaz'
reset role;
update wallets set elmas = 0 where user_id = :B::uuid;
set role authenticated;
select set_config('request.jwt.claim.sub', :B, false);
insert into messages (receiver, body) values (:A, 'son mesaj');
select count(*) as b_mesaj from messages where sender = :B::uuid;
\echo '--- E9 yönetici satın almayı onaylar → 50'
reset role;
select admin_elmas_ekle(:B::uuid, 50, 'satin_alma', 'test-odeme-1');
set role authenticated;
select set_config('request.jwt.claim.sub', :B, false);
select elmas from wallets;
\echo '--- E10 hareket dökümü (yalnız kendi)'
select delta, reason from elmas_ledger order by id;
\echo '--- E11 arkadaş olmayana hediye (beklenen HATA)'
reset role;
insert into auth.users values ('cccccccc-0000-0000-0000-00000000000c','ec@x');
set role authenticated;
select set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-00000000000c', false);
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values ('cccccccc-0000-0000-0000-00000000000c','Elmas_C','1990-01-01','kadin','erkek',now());
insert into gifts (receiver, kind) values (:A, 'lale');
