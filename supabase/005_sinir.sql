-- Çini Salonu · 005: aylık harcama sınırı (sorumlu oyun)
-- Varsayılan ve en yüksek sınır ayda 1000 ₺. Kullanıcı sınırı düşürürse hemen geçerli olur,
-- yükseltirse 24 saat sonra. Ay, İstanbul saatiyle ayın 1'inde başlar.
-- Sayılanlar: ödenen, incelemedeki ve son 1 saatte açılmış (henüz tamamlanabilecek) ödemeler.

create table if not exists public.harcama_siniri (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  aylik      numeric(10,2) not null default 1000 check (aylik >= 0 and aylik <= 1000),
  yeni       numeric(10,2) check (yeni >= 0 and yeni <= 1000),
  yeni_tarih timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.harcama_siniri enable row level security;
revoke all on public.harcama_siniri from anon, authenticated;   -- istemci yalnız RPC ile okur/yazar

create or replace function public.sinir_tavan() returns numeric language sql immutable as $$ select 1000::numeric $$;

-- geçerli sınır; zamanı gelmiş yükseltmeyi uygular
create or replace function public.gecerli_sinir(u uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare s harcama_siniri%rowtype;
begin
  select * into s from harcama_siniri where user_id = u for update;
  if not found then return sinir_tavan(); end if;
  if s.yeni is not null and s.yeni_tarih <= now() then
    update harcama_siniri set aylik = s.yeni, yeni = null, yeni_tarih = null, updated_at = now() where user_id = u;
    return s.yeni;
  end if;
  return s.aylik;
end $$;

create or replace function public.bu_ay_harcama(u uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(tutar), 0) from odemeler
  where user_id = u
    and created_at >= (date_trunc('month', now() at time zone 'Europe/Istanbul') at time zone 'Europe/Istanbul')
    and (durum in ('odendi', 'inceleme') or (durum = 'bekliyor' and created_at > now() - interval '1 hour'))
$$;

-- 004'teki koruma + sınır denetimi
create or replace function public.trg_odeme_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare e int; t numeric; n int; h numeric; s numeric;
begin
  if tg_op = 'INSERT' then
    if new.user_id is null or not is_active(new.user_id) then
      raise exception 'Elmas almak için profilin olmalı.';
    end if;
    select count(*) into n from odemeler where user_id = new.user_id and created_at > now() - interval '1 hour';
    if n >= 10 then raise exception 'Çok fazla ödeme denemesi. Biraz sonra tekrar dene.'; end if;
    select b.elmas, b.tutar into e, t from paket_bilgi(new.paket) b;
    if e is null then raise exception 'Geçersiz paket.'; end if;
    h := bu_ay_harcama(new.user_id); s := gecerli_sinir(new.user_id);
    if h + t > s then
      raise exception 'Bu alım aylık harcama sınırını aşıyor (bu ay % ₺, sınır % ₺). Sınırı Ayarlar''dan görebilirsin.',
        replace(to_char(h, 'FM999990.00'), '.', ','), replace(to_char(s, 'FM999990.00'), '.', ',');
    end if;
    new.elmas := e; new.tutar := t; new.durum := 'bekliyor';
    new.token := null; new.iyzico_payment_id := null; new.created_at := now();
  else
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

-- ───────────── istemci RPC'leri ─────────────
create or replace function public.harcama_durumu() returns json
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); s harcama_siniri%rowtype; g numeric;
begin
  if u is null then raise exception 'Giriş yapmalısın.'; end if;
  g := gecerli_sinir(u);
  select * into s from harcama_siniri where user_id = u;
  return json_build_object('sinir', g, 'harcanan', bu_ay_harcama(u), 'tavan', sinir_tavan(),
                           'yeni', s.yeni, 'yeni_tarih', s.yeni_tarih);
end $$;

create or replace function public.harcama_siniri_ayarla(n numeric) returns json
language plpgsql security definer set search_path = public as $$
declare u uuid := auth.uid(); g numeric;
begin
  if u is null then raise exception 'Giriş yapmalısın.'; end if;
  if n is null or n < 0 or n > sinir_tavan() then raise exception 'Sınır 0 ile % ₺ arasında olmalı.', sinir_tavan(); end if;
  n := round(n, 2);
  g := gecerli_sinir(u);
  insert into harcama_siniri (user_id) values (u) on conflict (user_id) do nothing;
  if n <= g then
    update harcama_siniri set aylik = n, yeni = null, yeni_tarih = null, updated_at = now() where user_id = u;
  else
    update harcama_siniri set yeni = n, yeni_tarih = now() + interval '24 hours', updated_at = now() where user_id = u;
  end if;
  return harcama_durumu();
end $$;

revoke execute on function public.gecerli_sinir(uuid), public.bu_ay_harcama(uuid),
  public.harcama_durumu(), public.harcama_siniri_ayarla(numeric) from public, anon, authenticated;
grant execute on function public.harcama_durumu(), public.harcama_siniri_ayarla(numeric) to authenticated;
