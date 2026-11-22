-- Çini Salonu · 006: yönetim paneli (şikâyetler, yasaklama, ödemeler, elmas düzeltme)
-- Yöneticiler yoneticiler tablosundadır; eklemek için SQL Editor:
--   insert into public.yoneticiler (user_id) values ('<kullanıcı-id>');
-- Her yönetim işlemi yonetim_kayit tablosuna yazılır.

create table if not exists public.yoneticiler (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.yonetim_kayit (
  id         bigint generated always as identity primary key,
  yonetici   uuid references auth.users(id) on delete set null,
  islem      text not null,
  hedef      uuid,
  ayrinti    text,
  created_at timestamptz not null default now()
);
alter table public.yoneticiler   enable row level security;
alter table public.yonetim_kayit enable row level security;
revoke all on public.yoneticiler, public.yonetim_kayit from anon, authenticated;

create or replace function public.yonetici_mi() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from yoneticiler where user_id = auth.uid())
$$;

create or replace function public.yonetici_sart() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not yonetici_mi() then raise exception 'Bu işlem için yetkin yok.'; end if;
end $$;

create or replace function public.yonetim_log(p_islem text, p_hedef uuid, p_ayrinti text) returns void
language sql security definer set search_path = public as $$
  insert into yonetim_kayit (yonetici, islem, hedef, ayrinti) values (auth.uid(), p_islem, p_hedef, left(p_ayrinti, 500))
$$;

-- ── özet ──
create or replace function public.yonetim_ozet() returns json
language plpgsql security definer set search_path = public as $$
declare gun timestamptz := date_trunc('day', now() at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul';
        ay  timestamptz := date_trunc('month', now() at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul';
begin
  perform yonetici_sart();
  return json_build_object(
    'kullanici',     (select count(*) from profiles),
    'bugun_yeni',    (select count(*) from profiles where created_at >= gun),
    'acik_sikayet',  (select count(*) from reports where status = 'acik'),
    'incelemede',    (select count(*) from profiles where under_review and not banned),
    'yasakli',       (select count(*) from profiles where banned),
    'odeme_bugun',   (select coalesce(sum(tutar), 0) from odemeler where durum = 'odendi' and created_at >= gun),
    'odeme_ay',      (select coalesce(sum(tutar), 0) from odemeler where durum = 'odendi' and created_at >= ay),
    'odeme_ay_adet', (select count(*) from odemeler where durum = 'odendi' and created_at >= ay),
    'odeme_toplam',  (select coalesce(sum(tutar), 0) from odemeler where durum = 'odendi'),
    'odeme_sorunlu', (select count(*) from odemeler where durum = 'inceleme' or (durum = 'bekliyor' and hata is not null)));
end $$;

-- ── şikâyetler ──
create or replace function public.yonetim_sikayetler(p_durum text default 'acik', p_limit int default 50)
returns table (id bigint, created_at timestamptz, reason text, details text, status text,
               sikayetci text, hedef uuid, hedef_nick text, hedef_yasakli boolean, hedef_incelemede boolean,
               hedef_sikayet int, mesaj text)
language plpgsql security definer set search_path = public as $$
begin
  perform yonetici_sart();
  return query
    select r.id, r.created_at, r.reason, r.details, r.status, a.nick, r.reported, b.nick, b.banned, b.under_review,
           (select count(*)::int from reports x where x.reported = r.reported),
           (select m.body from messages m where m.id = r.message_id)
    from reports r join profiles a on a.id = r.reporter join profiles b on b.id = r.reported
    where p_durum is null or r.status = p_durum
    order by r.created_at desc limit least(greatest(p_limit, 1), 200);
end $$;

create or replace function public.yonetim_karar(p_rapor bigint, p_karar text, p_not text default null) returns text
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  perform yonetici_sart();
  select reported into h from reports where id = p_rapor;
  if h is null then raise exception 'Şikâyet bulunamadı.'; end if;
  if p_karar = 'kapat' then
    update reports set status = 'incelendi' where id = p_rapor;
  elsif p_karar = 'yasakla' then
    if exists (select 1 from yoneticiler where user_id = h) then raise exception 'Yönetici yasaklanamaz.'; end if;
    update profiles set banned = true where id = h;
    update reports set status = 'incelendi' where reported = h and status = 'acik';
  elsif p_karar = 'temize_cikar' then
    update profiles set under_review = false where id = h;
    update reports set status = 'incelendi' where reported = h and status = 'acik';
  else
    raise exception 'Bilinmeyen karar.';
  end if;
  perform yonetim_log('sikayet_' || p_karar, h, 'rapor ' || p_rapor || coalesce(' · ' || p_not, ''));
  return p_karar;
end $$;

-- ── kullanıcılar ──
create or replace function public.yonetim_kullanicilar(p_ara text default '', p_limit int default 30)
returns table (id uuid, nick text, created_at timestamptz, gender text, city text, banned boolean, under_review boolean,
               elmas int, sikayet int, odenen numeric)
language plpgsql security definer set search_path = public as $$
begin
  perform yonetici_sart();
  return query
    select p.id, p.nick, p.created_at, p.gender, p.city, p.banned, p.under_review,
           coalesce((select w.elmas from wallets w where w.user_id = p.id), 0),
           (select count(*)::int from reports r where r.reported = p.id),
           (select coalesce(sum(o.tutar), 0) from odemeler o where o.user_id = p.id and o.durum = 'odendi')
    from profiles p
    where coalesce(p_ara, '') = '' or p.nick ilike '%' || replace(replace(p_ara, '%', ''), '_', '\_') || '%'
    order by p.created_at desc limit least(greatest(p_limit, 1), 100);
end $$;

create or replace function public.yonetim_kullanici(p_user uuid, p_islem text, p_not text default null) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform yonetici_sart();
  if not exists (select 1 from profiles where id = p_user) then raise exception 'Kullanıcı bulunamadı.'; end if;
  if p_islem in ('yasakla', 'incelemeye_al') and exists (select 1 from yoneticiler where user_id = p_user) then
    raise exception 'Yönetici yasaklanamaz.';
  end if;
  if    p_islem = 'yasakla'           then update profiles set banned = true where id = p_user;
  elsif p_islem = 'yasagi_kaldir'     then update profiles set banned = false where id = p_user;
  elsif p_islem = 'incelemeye_al'     then update profiles set under_review = true where id = p_user;
  elsif p_islem = 'incelemeden_cikar' then update profiles set under_review = false where id = p_user;
  else raise exception 'Bilinmeyen işlem.';
  end if;
  perform yonetim_log(p_islem, p_user, p_not);
  return p_islem;
end $$;

-- elmas düzeltme: + ekler, − düşer (bakiye eksiye inmez); hareket dökümüne 'yonetici' diye yazılır
create or replace function public.yonetim_elmas(p_user uuid, p_n int, p_not text) returns int
language plpgsql security definer set search_path = public as $$
declare yeni int;
begin
  perform yonetici_sart();
  if p_n = 0 or abs(p_n) > 1000 then raise exception 'Miktar -1000 ile 1000 arasında, 0 dışında olmalı.'; end if;
  if coalesce(trim(p_not), '') = '' then raise exception 'Açıklama yaz.'; end if;
  insert into wallets (user_id, elmas) values (p_user, 0) on conflict (user_id) do nothing;
  update wallets set elmas = elmas + p_n, updated_at = now() where user_id = p_user and elmas + p_n >= 0 returning elmas into yeni;
  if yeni is null then raise exception 'Bakiye eksiye düşemez.'; end if;
  insert into elmas_ledger (user_id, delta, reason, ref) values (p_user, p_n, 'yonetici', left(p_not, 200));
  perform yonetim_log('elmas', p_user, p_n || ' · ' || p_not);
  return yeni;
end $$;

-- ── ödemeler ──
create or replace function public.yonetim_odemeler(p_limit int default 50)
returns table (id uuid, created_at timestamptz, nick text, paket text, elmas int, tutar numeric, durum text,
               iyzico_payment_id text, hata text)
language plpgsql security definer set search_path = public as $$
begin
  perform yonetici_sart();
  return query
    select o.id, o.created_at, p.nick, o.paket, o.elmas, o.tutar, o.durum, o.iyzico_payment_id, o.hata
    from odemeler o left join profiles p on p.id = o.user_id
    order by o.created_at desc limit least(greatest(p_limit, 1), 200);
end $$;

-- ── yetkiler ──
revoke execute on function public.yonetici_mi(), public.yonetici_sart(), public.yonetim_log(text, uuid, text),
  public.yonetim_ozet(), public.yonetim_sikayetler(text, int), public.yonetim_karar(bigint, text, text),
  public.yonetim_kullanicilar(text, int), public.yonetim_kullanici(uuid, text, text),
  public.yonetim_elmas(uuid, int, text), public.yonetim_odemeler(int) from public, anon, authenticated;
grant execute on function public.yonetici_mi(),
  public.yonetim_ozet(), public.yonetim_sikayetler(text, int), public.yonetim_karar(bigint, text, text),
  public.yonetim_kullanicilar(text, int), public.yonetim_kullanici(uuid, text, text),
  public.yonetim_elmas(uuid, int, text), public.yonetim_odemeler(int) to authenticated;
