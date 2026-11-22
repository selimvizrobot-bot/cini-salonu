-- Çini Salonu · 007: Google Play ödemeleri (Android uygulaması)
-- Uygulama içinden elmas Google Play ödeme sistemiyle satılır (Play kuralı). Akış:
--   play_on_kontrol  → satın almadan önce profil ve aylık harcama sınırı denetimi
--   (Google Play ödeme ekranı)
--   play_tamamla     → Edge Function satın almayı Google'dan doğruladıktan sonra çağırır; token başına bir kez yükler

alter table public.odemeler add column if not exists kaynak text not null default 'iyzico';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'odemeler_kaynak_check') then
    alter table public.odemeler add constraint odemeler_kaynak_check check (kaynak in ('iyzico', 'play'));
  end if;
end $$;
grant select (kaynak) on public.odemeler to authenticated;

-- 005'teki koruma: Google'ın zaten tahsil ettiği Play ödemesi kaydedilirken sınır ve deneme sayısı denetlenmez
create or replace function public.trg_odeme_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare e int; t numeric; n int; h numeric; s numeric;
        play boolean := coalesce(current_setting('cini.play', true), '') = 'evet';
begin
  if tg_op = 'INSERT' then
    if new.user_id is null or (not play and not is_active(new.user_id)) then
      raise exception 'Elmas almak için profilin olmalı.';
    end if;
    select b.elmas, b.tutar into e, t from paket_bilgi(new.paket) b;
    if e is null then raise exception 'Geçersiz paket.'; end if;
    if not play then
      select count(*) into n from odemeler where user_id = new.user_id and created_at > now() - interval '1 hour';
      if n >= 10 then raise exception 'Çok fazla ödeme denemesi. Biraz sonra tekrar dene.'; end if;
      h := bu_ay_harcama(new.user_id); s := gecerli_sinir(new.user_id);
      if h + t > s then
        raise exception 'Bu alım aylık harcama sınırını aşıyor (bu ay % ₺, sınır % ₺). Sınırı Ayarlar''dan görebilirsin.',
          replace(to_char(h, 'FM999990.00'), '.', ','), replace(to_char(s, 'FM999990.00'), '.', ',');
      end if;
    end if;
    new.kaynak := case when play then 'play' else 'iyzico' end;
    new.elmas := e; new.tutar := t; new.durum := 'bekliyor';
    new.token := null; new.iyzico_payment_id := null; new.created_at := now();
  else
    new.id := old.id; new.user_id := old.user_id; new.paket := old.paket; new.kaynak := old.kaynak;
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

-- 004'teki tamamlama: hareket dökümüne kaynağa göre 'iyzico:' ya da 'play:' yazar
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
  perform admin_elmas_ekle(o.user_id, o.elmas, 'satin_alma', o.kaynak || ':' || coalesce(p_payment_id, p_id::text));
  return 'ok';
end $$;

-- satın almadan önce: profil, paket ve aylık sınır (hata mesajıyla durur)
create or replace function public.play_on_kontrol(p_user uuid, p_paket text) returns json
language plpgsql security definer set search_path = public as $$
declare e int; t numeric; h numeric; s numeric;
begin
  if p_user is null or not is_active(p_user) then raise exception 'Elmas almak için profilin olmalı.'; end if;
  select b.elmas, b.tutar into e, t from paket_bilgi(p_paket) b;
  if e is null then raise exception 'Geçersiz paket.'; end if;
  h := bu_ay_harcama(p_user); s := gecerli_sinir(p_user);
  if h + t > s then
    raise exception 'Bu alım aylık harcama sınırını aşıyor (bu ay % ₺, sınır % ₺). Sınırı Ayarlar''dan görebilirsin.',
      replace(to_char(h, 'FM999990.00'), '.', ','), replace(to_char(s, 'FM999990.00'), '.', ',');
  end if;
  return json_build_object('ok', true, 'elmas', e, 'tutar', t);
end $$;

-- Google'dan doğrulanmış satın alma: token başına bir kez kayıt + elmas
create or replace function public.play_tamamla(p_user uuid, p_paket text, p_token text, p_siparis text) returns json
language plpgsql security definer set search_path = public as $$
declare o odemeler%rowtype; yeni uuid;
begin
  if coalesce(p_token, '') = '' then raise exception 'Satın alma jetonu yok.'; end if;
  perform pg_advisory_xact_lock(hashtext('play:' || p_token));
  select * into o from odemeler where token = p_token;
  if found then
    if o.user_id is distinct from p_user then raise exception 'Bu satın alma başka bir hesaba ait.'; end if;
    return json_build_object('durum', 'zaten', 'elmas', 0);
  end if;
  perform set_config('cini.play', 'evet', true);
  insert into odemeler (user_id, paket) values (p_user, p_paket) returning id into yeni;
  update odemeler set token = p_token where id = yeni;
  perform set_config('cini.play', '', true);
  perform odeme_tamamla(yeni, coalesce(nullif(p_siparis, ''), left(p_token, 40)));
  select * into o from odemeler where id = yeni;
  return json_build_object('durum', 'ok', 'elmas', o.elmas);
end $$;

revoke execute on function public.odeme_tamamla(uuid, text) from public, anon, authenticated;
grant execute on function public.odeme_tamamla(uuid, text) to service_role;
revoke execute on function public.play_on_kontrol(uuid, text), public.play_tamamla(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.play_on_kontrol(uuid, text), public.play_tamamla(uuid, text, text, text) to service_role;
