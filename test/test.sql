\set ON_ERROR_STOP 0
\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''bbbbbbbb-0000-0000-0000-000000000002'''
\set C '''cccccccc-0000-0000-0000-000000000003'''
\set D '''dddddddd-0000-0000-0000-000000000004'''
insert into auth.users values (:A,'a@x'),(:B,'b@x'),(:C,'c@x'),(:D,'d@x');

set role authenticated;
-- A: erkek, kadın arıyor
select set_config('request.jwt.claim.sub', :A, false);
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values (:A,'Selim_A','1990-01-01','erkek','kadin',now());
\echo '--- T1 beklenen HATA: 18 yaş altı'
select set_config('request.jwt.claim.sub', :D, false);
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values (:D,'Kucuk','2012-01-01','kadin','erkek',now());
\echo '--- T2 beklenen HATA: başkası adına profil'
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values (:B,'Sahte','1990-01-01','kadin','erkek',now());
\echo '--- T3 beklenen HATA: banned sütunu yazılamaz'
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at,banned) values (:D,'Dd','1990-01-01','kadin','erkek',now(),false);
-- B: kadın, erkek arıyor ; C: kadın, kadın arıyor
select set_config('request.jwt.claim.sub', :B, false);
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at,city) values (:B,'Ayse_B','1995-05-05','kadin','erkek',now(),'İstanbul');
select set_config('request.jwt.claim.sub', :C, false);
insert into profiles (id,nick,birth_date,gender,looking_for,kvkk_consent_at) values (:C,'Cem_C','1992-02-02','kadin','kadin',now());

\echo '--- T4 A başkalarının satırını göremez (beklenen 1 satır, yalnız kendisi)'
select set_config('request.jwt.claim.sub', :A, false);
select nick from profiles;
\echo '--- T5 discover: A için yalnız Ayse_B (C kadın arıyor, uymaz); doğum tarihi yok, yaş var'
select nick, age, gender from discover();
\echo '--- T6 beklenen HATA: arkadaş olmadan özel mesaj'
insert into messages (receiver, body) values (:B, 'merhaba');
\echo '--- T7 A -> B istek'
insert into friendships (addressee) values (:B) returning requester = :A::uuid as dogru_gonderen, status;
\echo '--- T8 beklenen 0 satır: A kendi isteğini kabul edemez'
update friendships set status='kabul' where addressee = :B::uuid returning id;
\echo '--- T9 B kabul eder'
select set_config('request.jwt.claim.sub', :B, false);
update friendships set status='kabul' where requester = :A::uuid returning status;
\echo '--- T10 mesaj gider'
insert into messages (receiver, body) values (:A, 'Selam, iyi oyunlar') returning body;
\echo '--- T11 beklenen HATA: IBAN'
insert into messages (receiver, body) values (:A, 'şuraya at TR12 0006 1000');
\echo '--- T12 beklenen HATA: link'
insert into messages (receiver, body) values (:A, 'bak https://site.com');
\echo '--- T13 C, A-B mesajlarını göremez (beklenen 0)'
select set_config('request.jwt.claim.sub', :C, false);
select count(*) from messages;
\echo '--- T14 masa sohbeti, takma ad tetikleyiciden'
insert into room_messages (room, body) values ('slot','Bugün şanslıyım') returning sender_nick;
\echo '--- T15 beklenen HATA: 3 saniye kuralı'
insert into room_messages (room, body) values ('slot','tekrar');
\echo '--- T16 B, A yı engeller → arkadaşlık silinir, mesaj kapanır'
select set_config('request.jwt.claim.sub', :B, false);
insert into blocks (blocked) values (:A);
select count(*) as arkadaslik_kalan from friendships;
select set_config('request.jwt.claim.sub', :A, false);
\echo '--- T17 beklenen HATA: engellenen mesaj atamaz'
insert into messages (receiver, body) values (:B, 'neden?');
\echo '--- T18 beklenen HATA: engellenen yeniden istek atamaz'
insert into friendships (addressee) values (:B);
\echo '--- T19 A discover: B artık görünmez (beklenen 0)'
select count(*) from discover();
\echo '--- T20 reşit olmayan şikâyeti → inceleme'
select set_config('request.jwt.claim.sub', :C, false);
insert into reports (reported, reason) values (:A, 'resit_olmayan');
reset role;
select nick, under_review from profiles where id = :A::uuid;
\echo '--- T21 KVKK silme'
set role authenticated;
select set_config('request.jwt.claim.sub', :C, false);
select delete_me();
reset role;
select count(*) as c_kalan from profiles where id = :C::uuid;
\echo '--- T22 beklenen HATA: anon hiçbir şey okuyamaz'
set role anon;
select count(*) from profiles;
select * from discover();
