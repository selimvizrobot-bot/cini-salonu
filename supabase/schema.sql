-- Çini Salonu · sosyal katman şeması (Supabase / PostgreSQL 15+)
-- Supabase SQL Editor'e olduğu gibi yapıştırıp çalıştırın.
-- İlkeler: yalnız 18+ · bot ya da sahte profil yok · mesajlaşma parayla satılmaz
--          özel mesaj yalnız karşılıklı kabul edilen arkadaşlar arasında
--          engelleme, şikâyet, otomatik inceleme · link/IBAN paylaşımı kapalı · hesabı silme hakkı (KVKK)

-- ───────────── tablolar ─────────────
create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  nick             text not null unique
                   check (char_length(nick) between 3 and 20 and nick ~ '^[A-Za-z0-9_çğıöşüÇĞİÖŞÜ]+$'),
  birth_date       date not null,
  gender           text not null check (gender in ('kadin','erkek','belirtmek_istemiyorum')),
  looking_for      text not null default 'arkadas' check (looking_for in ('arkadas','kadin','erkek','herkes')),
  city             text check (char_length(city) <= 40),
  bio              text check (char_length(bio) <= 300),
  visible          boolean not null default true,
  kvkk_consent_at  timestamptz not null,
  terms_version    text not null default '1.0',
  under_review     boolean not null default false,
  banned           boolean not null default false,
  created_at       timestamptz not null default now()
);

create table if not exists public.friendships (
  id          bigint generated always as identity primary key,
  requester   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  addressee   uuid not null references public.profiles(id) on delete cascade,
  status      text not null default 'bekliyor' check (status in ('bekliyor','kabul')),
  created_at  timestamptz not null default now(),
  check (requester <> addressee)
);
create unique index if not exists friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));

create table if not exists public.blocks (
  blocker     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  blocked     uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  sender      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  receiver    uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 500),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists messages_pair on public.messages (least(sender, receiver), greatest(sender, receiver), created_at);

create table if not exists public.room_messages (
  id           bigint generated always as identity primary key,
  room         text not null check (room in ('genel','slot','poker','okey')),
  sender       uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  sender_nick  text,
  body         text not null check (char_length(body) between 1 and 200),
  created_at   timestamptz not null default now()
);
create index if not exists room_messages_room on public.room_messages (room, created_at desc);

create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  reporter    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  reported    uuid not null references public.profiles(id) on delete cascade,
  reason      text not null check (reason in ('taciz','sahte_profil','dolandiricilik','cinsel_icerik','resit_olmayan','diger')),
  details     text check (char_length(details) <= 500),
  message_id  bigint,
  status      text not null default 'acik' check (status in ('acik','incelendi')),
  created_at  timestamptz not null default now(),
  check (reporter <> reported)
);

-- ───────────── yardımcı işlevler ─────────────
create or replace function public.is_active(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = u and not banned)
$$;

create or replace function public.is_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from blocks where (blocker = a and blocked = b) or (blocker = b and blocked = a))
$$;

create or replace function public.are_friends(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from friendships
                 where status = 'kabul'
                   and least(requester, addressee) = least(a, b)
                   and greatest(requester, addressee) = greatest(a, b))
$$;

create or replace function public.has_unsafe_content(t text) returns boolean
language sql immutable as $$
  select t ~* '(https?://|www\.|\.(com|net|org|xyz|io|me|link)\M|t\.me/|wa\.me/|\mTR[0-9]{2}[ ]?[0-9]{4})'
$$;

-- ───────────── kurallar (tetikleyiciler) ─────────────
create or replace function public.trg_profiles_guard() returns trigger
language plpgsql as $$
begin
  if new.birth_date > (current_date - interval '18 years')::date then
    raise exception 'Çini Salonu yalnızca 18 yaş ve üstü içindir.';
  end if;
  if tg_op = 'UPDATE' and new.birth_date <> old.birth_date then
    raise exception 'Doğum tarihi sonradan değiştirilemez.';
  end if;
  if has_unsafe_content(coalesce(new.bio, '')) then
    raise exception 'Güvenliğin için profilde link veya IBAN paylaşılamaz.';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function public.trg_profiles_guard();

create or replace function public.trg_friend_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if is_blocked(new.requester, new.addressee) then
    raise exception 'Bu kişiye istek gönderilemez.';
  end if;
  if not is_active(new.addressee) then
    raise exception 'Kişi bulunamadı.';
  end if;
  if (select count(*) from friendships
      where requester = new.requester and created_at > now() - interval '1 day') >= 30 then
    raise exception 'Günlük arkadaşlık isteği sınırına ulaştın (30).';
  end if;
  return new;
end $$;
drop trigger if exists friend_guard on public.friendships;
create trigger friend_guard before insert on public.friendships
  for each row execute function public.trg_friend_guard();

create or replace function public.trg_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not are_friends(new.sender, new.receiver) or is_blocked(new.sender, new.receiver) then
    raise exception 'Yalnızca arkadaşlarınla özel mesajlaşabilirsin.';
  end if;
  if has_unsafe_content(new.body) then
    raise exception 'Güvenliğin için mesajda link veya IBAN paylaşılamaz.';
  end if;
  if (select count(*) from messages
      where sender = new.sender and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Çok hızlı yazıyorsun, biraz bekle.';
  end if;
  return new;
end $$;
drop trigger if exists message_guard on public.messages;
create trigger message_guard before insert on public.messages
  for each row execute function public.trg_message_guard();

create or replace function public.trg_room_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if has_unsafe_content(new.body) then
    raise exception 'Güvenliğin için sohbette link veya IBAN paylaşılamaz.';
  end if;
  if exists (select 1 from room_messages
             where sender = new.sender and created_at > now() - interval '3 seconds') then
    raise exception 'Çok hızlı yazıyorsun, biraz bekle.';
  end if;
  new.sender_nick := (select nick from profiles where id = new.sender);
  return new;
end $$;
drop trigger if exists room_guard on public.room_messages;
create trigger room_guard before insert on public.room_messages
  for each row execute function public.trg_room_guard();

-- engellenince arkadaşlık ve bekleyen istek silinir
create or replace function public.trg_block_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from friendships
   where least(requester, addressee) = least(new.blocker, new.blocked)
     and greatest(requester, addressee) = greatest(new.blocker, new.blocked);
  return new;
end $$;
drop trigger if exists block_cleanup on public.blocks;
create trigger block_cleanup after insert on public.blocks
  for each row execute function public.trg_block_cleanup();

-- 24 saatte 3 farklı kişiden şikâyet ya da "reşit olmayan" şikâyeti → profil incelemeye alınır, listeden çıkar
create or replace function public.trg_report_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.reason = 'resit_olmayan'
     or (select count(distinct reporter) from reports
         where reported = new.reported and created_at > now() - interval '1 day') >= 3 then
    update profiles set under_review = true where id = new.reported;
  end if;
  return new;
end $$;
drop trigger if exists report_review on public.reports;
create trigger report_review after insert on public.reports
  for each row execute function public.trg_report_review();

-- ───────────── istemcinin çağırdığı işlevler ─────────────
-- Tanışma listesi: karşılıklı arama tercihine uyan, görünür, engelsiz, henüz bağlantısı olmayan kişiler.
-- Doğum tarihi hiç dışarı verilmez; yalnız yaş döner.
create or replace function public.discover(p_limit int default 30)
returns table (id uuid, nick text, age int, gender text, looking_for text, city text, bio text)
language sql stable security definer set search_path = public as $$
  with me as (select * from profiles where id = auth.uid() and not banned)
  select p.id, p.nick, date_part('year', age(p.birth_date))::int, p.gender, p.looking_for, p.city, p.bio
    from profiles p, me
   where p.id <> me.id and p.visible and not p.banned and not p.under_review
     and not is_blocked(me.id, p.id)
     and (me.looking_for in ('arkadas','herkes') or p.gender = me.looking_for)
     and (p.looking_for in ('arkadas','herkes') or p.looking_for = me.gender)
     and not exists (select 1 from friendships f
                      where least(f.requester, f.addressee) = least(me.id, p.id)
                        and greatest(f.requester, f.addressee) = greatest(me.id, p.id))
   order by p.created_at desc
   limit least(greatest(p_limit, 1), 50)
$$;

-- Bağlantılı kişilerin (istek, arkadaş, mesaj) kartları
create or replace function public.people(ids uuid[])
returns table (id uuid, nick text, age int, gender text, city text, bio text)
language sql stable security definer set search_path = public as $$
  select p.id, p.nick, date_part('year', age(p.birth_date))::int, p.gender, p.city, p.bio
    from profiles p
   where p.id = any(ids) and not p.banned and auth.uid() is not null
     and not is_blocked(auth.uid(), p.id)
$$;

-- KVKK: hesabı ve tüm verileri silme
create or replace function public.delete_me() returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.users where id = auth.uid()
$$;

-- ───────────── satır güvenliği (RLS) ve yetkiler ─────────────
alter table public.profiles      enable row level security;
alter table public.friendships   enable row level security;
alter table public.blocks        enable row level security;
alter table public.messages      enable row level security;
alter table public.room_messages enable row level security;
alter table public.reports       enable row level security;

revoke all on public.profiles, public.friendships, public.blocks, public.messages,
              public.room_messages, public.reports from anon, authenticated;
revoke execute on function public.discover(int), public.people(uuid[]), public.delete_me(),
       public.is_active(uuid), public.is_blocked(uuid,uuid), public.are_friends(uuid,uuid) from public, anon;
grant usage on schema public to authenticated;
grant execute on function public.discover(int), public.people(uuid[]), public.delete_me(),
      public.is_active(uuid), public.is_blocked(uuid,uuid), public.are_friends(uuid,uuid) to authenticated;

-- profiles: herkes yalnız kendi satırını görür/yazar; inceleme ve ban sütunları istemciye kapalı
grant select on public.profiles to authenticated;
grant insert (id, nick, birth_date, gender, looking_for, city, bio, visible, kvkk_consent_at, terms_version) on public.profiles to authenticated;
grant update (nick, gender, looking_for, city, bio, visible) on public.profiles to authenticated;
drop policy if exists p_sel on public.profiles;
create policy p_sel on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists p_ins on public.profiles;
create policy p_ins on public.profiles for insert to authenticated with check (id = auth.uid());
drop policy if exists p_upd on public.profiles;
create policy p_upd on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- friendships: taraflar görür; yalnız gönderen oluşturur; yalnız alıcı kabul eder; iki taraf da silebilir
grant select, delete on public.friendships to authenticated;
grant insert (addressee) on public.friendships to authenticated;
grant update (status) on public.friendships to authenticated;
drop policy if exists f_sel on public.friendships;
create policy f_sel on public.friendships for select to authenticated using (auth.uid() in (requester, addressee));
drop policy if exists f_ins on public.friendships;
create policy f_ins on public.friendships for insert to authenticated
  with check (requester = auth.uid() and status = 'bekliyor' and public.is_active(auth.uid()));
drop policy if exists f_upd on public.friendships;
create policy f_upd on public.friendships for update to authenticated
  using (addressee = auth.uid()) with check (addressee = auth.uid() and status = 'kabul');
drop policy if exists f_del on public.friendships;
create policy f_del on public.friendships for delete to authenticated using (auth.uid() in (requester, addressee));

-- blocks: yalnız engelleyen görür
grant select, delete on public.blocks to authenticated;
grant insert (blocked) on public.blocks to authenticated;
drop policy if exists b_all on public.blocks;
create policy b_all on public.blocks for all to authenticated using (blocker = auth.uid()) with check (blocker = auth.uid());

-- messages: taraflar okur; yalnız gönderen yazar; okundu bilgisini alıcı işaretler
grant select on public.messages to authenticated;
grant insert (receiver, body) on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;
drop policy if exists m_sel on public.messages;
create policy m_sel on public.messages for select to authenticated using (auth.uid() in (sender, receiver));
drop policy if exists m_ins on public.messages;
create policy m_ins on public.messages for insert to authenticated
  with check (sender = auth.uid() and public.is_active(auth.uid()));
drop policy if exists m_upd on public.messages;
create policy m_upd on public.messages for update to authenticated using (receiver = auth.uid()) with check (receiver = auth.uid());

-- room_messages: giriş yapan herkes okur (engellediklerini görmez); yalnız aktif hesap yazar
grant select on public.room_messages to authenticated;
grant insert (room, body) on public.room_messages to authenticated;
drop policy if exists r_sel on public.room_messages;
create policy r_sel on public.room_messages for select to authenticated using (not public.is_blocked(auth.uid(), sender));
drop policy if exists r_ins on public.room_messages;
create policy r_ins on public.room_messages for insert to authenticated
  with check (sender = auth.uid() and public.is_active(auth.uid()));

-- reports: kullanıcı şikâyet yazar ve yalnız kendi şikâyetlerini görür; inceleme Supabase panelinden yapılır
grant select on public.reports to authenticated;
grant insert (reported, reason, details, message_id) on public.reports to authenticated;
drop policy if exists rp_sel on public.reports;
create policy rp_sel on public.reports for select to authenticated using (reporter = auth.uid());
drop policy if exists rp_ins on public.reports;
create policy rp_ins on public.reports for insert to authenticated with check (reporter = auth.uid());

-- ───────────── canlı akış (Supabase Realtime) ─────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.messages, public.room_messages, public.friendships;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
