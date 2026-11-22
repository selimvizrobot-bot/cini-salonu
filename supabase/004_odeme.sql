-- Çini Salonu · 004: iyzico ile elmas satışı
-- Ödeme kaydını yalnız sunucu fonksiyonu (Edge Function "odeme", service_role) yazar.
-- Paket fiyatı ve elmas miktarı burada sabittir; istemcinin ya da fonksiyonun gönderdiğine güvenilmez.
-- Elmas yalnız odeme_tamamla() ile, iyzico'dan doğrulanmış ödemeye karşılık bir kez yüklenir.

create or replace function public.paket_bilgi(p text, out elmas int, out tutar numeric)
language sql immutable as $$
  select v.e, v.t from (values ('e50', 50, 29.99), ('e150', 150, 79.99), ('e400', 400, 179.99)) v(k, e, t)
  where v.k = p
$$;

create table if not exists public.odemeler (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,  -- hesap silinse de muhasebe kaydı kalır
  paket             text not null,
  elmas             int not null check (elmas > 0),
  tutar             numeric(10,2) not null check (tutar > 0),
  durum             text not null default 'bekliyor' check (durum in ('bekliyor','inceleme','odendi','hata')),
  token             text unique,
  iyzico_payment_id text,
  hata              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists odemeler_user_idx on public.odemeler (user_id, created_at desc);

create or replace function public.trg_odeme_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare e int; t numeric; n int;
begin
  if tg_op = 'INSERT' then
    if new.user_id is null or not is_active(new.user_id) then
      raise exception 'Elmas almak için profilin olmalı.';
    end if;
    select count(*) into n from odemeler where user_id = new.user_id and created_at > now() - interval '1 hour';
    if n >= 10 then raise exception 'Çok fazla ödeme denemesi. Biraz sonra tekrar dene.'; end if;
    select b.elmas, b.tutar into e, t from paket_bilgi(new.paket) b;
    if e is null then raise exception 'Geçersiz paket.'; end if;
    new.elmas := e; new.tutar := t; new.durum := 'bekliyor';
    new.token := null; new.iyzico_payment_id := null; new.created_at := now();
  else
    -- kimin, ne kadar, hangi paket: değişmez
    new.id := old.id; new.user_id := old.user_id; new.paket := old.paket;
    new.elmas := old.elmas; new.tutar := old.tutar; new.created_at := old.created_at;
    if old.durum = 'odendi' then
      new.durum := 'odendi'; new.iyzico_payment_id := old.iyzico_payment_id;
    elsif new.durum = 'odendi' and coalesce(current_setting('cini.odeme', true), '') <> 'evet' then
      raise exception 'Ödeme yalnız doğrulamayla tamamlanır.';
    end if;
    if old.token is not null then new.token := old.token; end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists odeme_guard on public.odemeler;
create trigger odeme_guard before insert or update on public.odemeler
  for each row execute function public.trg_odeme_guard();

-- Doğrulanmış ödemeyi tamamla: bir kez elmas yükler (aynı ödeme ikinci kez gelirse 'zaten').
create or replace function public.odeme_tamamla(p_id uuid, p_payment_id text) returns text
language plpgsql security definer set search_path = public as $$
declare o odemeler%rowtype;
begin
  select * into o from odemeler where id = p_id for update;
  if not found then return 'yok'; end if;
  if o.durum = 'odendi' then return 'zaten'; end if;
  perform set_config('cini.odeme', 'evet', true);
  update odemeler set durum = 'odendi', iyzico_payment_id = p_payment_id, hata = null where id = p_id;
  perform set_config('cini.odeme', '', true);
  if o.user_id is null then return 'kullanici_yok'; end if;
  perform admin_elmas_ekle(o.user_id, o.elmas, 'satin_alma', 'iyzico:' || coalesce(p_payment_id, p_id::text));
  return 'ok';
end $$;

-- ───────────── yetkiler ─────────────
alter table public.odemeler enable row level security;
revoke all on public.odemeler from anon, authenticated;
grant select, insert, update on public.odemeler to service_role;
grant select (id, paket, elmas, tutar, durum, created_at) on public.odemeler to authenticated;
drop policy if exists o_sel on public.odemeler;
create policy o_sel on public.odemeler for select to authenticated using (user_id = auth.uid());

revoke execute on function public.odeme_tamamla(uuid, text), public.trg_odeme_guard() from public, anon, authenticated;
grant execute on function public.odeme_tamamla(uuid, text) to service_role;
grant execute on function public.paket_bilgi(text) to anon, authenticated, service_role;
