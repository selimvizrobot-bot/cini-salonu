-- Çini Salonu · 002 · Elmas (mesaj hakkı) ve hediye sistemi
-- schema.sql'den SONRA çalıştırılır. Tekrar çalıştırılabilir.
-- İlkeler: elmas yalnız mağazadan alınır (oyunda kazanılmaz) · oyuncular arasında aktarılamaz
--          her özel mesaj 1 elmas · hediye elmas harcar, alana elmas/jeton geçmez · kadın ve erkek için aynı fiyat

-- ───────────── tablolar ─────────────
create table if not exists public.wallets (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  elmas       int not null default 0 check (elmas >= 0),
  updated_at  timestamptz not null default now()
);

create table if not exists public.elmas_ledger (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  delta       int not null,
  reason      text not null check (reason in ('hosgeldin','mesaj','hediye','satin_alma','iade','yonetici')),
  ref         text,
  created_at  timestamptz not null default now()
);
create index if not exists elmas_ledger_user on public.elmas_ledger (user_id, created_at desc);

create table if not exists public.gifts (
  id          bigint generated always as identity primary key,
  sender      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  receiver    uuid not null references public.profiles(id) on delete cascade,
  kind        text not null check (kind in ('lale','fincan','nar','yildiz')),
  price       int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists gifts_pair on public.gifts (least(sender, receiver), greatest(sender, receiver), created_at);

-- ───────────── fiyatlar ─────────────
create or replace function public.gift_price(k text) returns int
language sql immutable as $$
  select case k when 'lale' then 2 when 'fincan' then 3 when 'nar' then 5 when 'yildiz' then 10 end
$$;

-- elmas düş: yetmezse hata (aynı işlemde mesaj/hediye de geri alınır)
create or replace function public.spend_elmas(u uuid, n int, why text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update wallets set elmas = elmas - n, updated_at = now() where user_id = u and elmas >= n;
  if not found then
    raise exception 'Elmasın yetmiyor. Mağazadan elmas alabilirsin.';
  end if;
  insert into elmas_ledger (user_id, delta, reason) values (u, -n, why);
end $$;

-- ───────────── yeni profile cüzdan + 20 hoş geldin elması ─────────────
create or replace function public.trg_profile_wallet() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into wallets (user_id, elmas) values (new.id, 20) on conflict (user_id) do nothing;
  if found then
    insert into elmas_ledger (user_id, delta, reason) values (new.id, 20, 'hosgeldin');
  end if;
  return new;
end $$;
drop trigger if exists profile_wallet on public.profiles;
create trigger profile_wallet after insert on public.profiles
  for each row execute function public.trg_profile_wallet();

-- mevcut profillere cüzdan
insert into public.elmas_ledger (user_id, delta, reason)
  select p.id, 20, 'hosgeldin' from public.profiles p
   where not exists (select 1 from public.wallets w where w.user_id = p.id);
insert into public.wallets (user_id, elmas)
  select id, 20 from public.profiles on conflict (user_id) do nothing;

-- ───────────── mesaj: önceki kurallar + 1 elmas ─────────────
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
  perform spend_elmas(new.sender, 1, 'mesaj');
  return new;
end $$;

-- ───────────── hediye ─────────────
create or replace function public.trg_gift_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not are_friends(new.sender, new.receiver) or is_blocked(new.sender, new.receiver) then
    raise exception 'Hediyeyi yalnızca arkadaşlarına gönderebilirsin.';
  end if;
  if (select count(*) from gifts
      where sender = new.sender and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'Çok hızlı hediye gönderiyorsun, biraz bekle.';
  end if;
  new.price := gift_price(new.kind);
  perform spend_elmas(new.sender, new.price, 'hediye');
  return new;
end $$;
drop trigger if exists gift_guard on public.gifts;
create trigger gift_guard before insert on public.gifts
  for each row execute function public.trg_gift_guard();

-- ───────────── yönetici: satın alma onaylanınca elmas ekleme ─────────────
-- Yalnız Supabase panelinden (SQL Editor) ya da ödeme sağlayıcısının sunucu tarafı (service_role) çağırır.
create or replace function public.admin_elmas_ekle(u uuid, n int, why text default 'satin_alma', r text default null)
returns int language plpgsql security definer set search_path = public as $$
declare yeni int;
begin
  if n <= 0 then raise exception 'Miktar pozitif olmalı.'; end if;
  insert into wallets (user_id, elmas) values (u, 0) on conflict (user_id) do nothing;
  update wallets set elmas = elmas + n, updated_at = now() where user_id = u returning elmas into yeni;
  insert into elmas_ledger (user_id, delta, reason, ref) values (u, n, why, r);
  return yeni;
end $$;

-- ───────────── yetkiler ─────────────
alter table public.wallets      enable row level security;
alter table public.elmas_ledger enable row level security;
alter table public.gifts        enable row level security;

revoke all on public.wallets, public.elmas_ledger, public.gifts from anon, authenticated;
revoke execute on function public.spend_elmas(uuid,int,text), public.admin_elmas_ekle(uuid,int,text,text) from public, anon, authenticated;

-- cüzdan ve hareketler: yalnız sahibi görür; kimse istemciden yazamaz
grant select on public.wallets, public.elmas_ledger to authenticated;
drop policy if exists w_sel on public.wallets;
create policy w_sel on public.wallets for select to authenticated using (user_id = auth.uid());
drop policy if exists l_sel on public.elmas_ledger;
create policy l_sel on public.elmas_ledger for select to authenticated using (user_id = auth.uid());

-- hediyeler: taraflar görür; yalnız gönderen yazar (fiyatı tetikleyici belirler)
grant select on public.gifts to authenticated;
grant insert (receiver, kind) on public.gifts to authenticated;
drop policy if exists g_sel on public.gifts;
create policy g_sel on public.gifts for select to authenticated using (auth.uid() in (sender, receiver));
drop policy if exists g_ins on public.gifts;
create policy g_ins on public.gifts for insert to authenticated
  with check (sender = auth.uid() and public.is_active(auth.uid()));

-- canlı akış
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.gifts, public.wallets;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
