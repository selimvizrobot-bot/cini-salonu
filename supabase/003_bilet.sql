-- Çini Salonu · 003 · Oyun masası bileti: 1 elmas = 1 saat (oyun başına)
-- 002_elmas.sql'den SONRA çalıştırılır. Tekrar çalıştırılabilir.

alter table public.elmas_ledger drop constraint if exists elmas_ledger_reason_check;
alter table public.elmas_ledger add constraint elmas_ledger_reason_check
  check (reason in ('hosgeldin','mesaj','hediye','oyun','satin_alma','iade','yonetici'));

create table if not exists public.game_passes (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  game         text not null check (game in ('slot','poker','okey')),
  valid_until  timestamptz not null,
  primary key (user_id, game)
);

-- Geçerli bilet varsa onu döndürür; yoksa 1 elmas düşer ve 1 saatlik bilet verir.
create or replace function public.oyun_bileti(g text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare v timestamptz; u uuid := auth.uid();
begin
  if u is null or not is_active(u) then raise exception 'Oynamak için giriş yap.'; end if;
  if g not in ('slot','poker','okey') then raise exception 'Bilinmeyen oyun.'; end if;
  select valid_until into v from game_passes where user_id = u and game = g;
  if v is not null and v > now() then return v; end if;
  perform spend_elmas(u, 1, 'oyun');
  insert into game_passes (user_id, game, valid_until) values (u, g, now() + interval '1 hour')
    on conflict (user_id, game) do update set valid_until = excluded.valid_until
    returning valid_until into v;
  return v;
end $$;

alter table public.game_passes enable row level security;
revoke all on public.game_passes from anon, authenticated;
grant select on public.game_passes to authenticated;
drop policy if exists gp_sel on public.game_passes;
create policy gp_sel on public.game_passes for select to authenticated using (user_id = auth.uid());

revoke execute on function public.oyun_bileti(text) from public, anon;
grant execute on function public.oyun_bileti(text) to authenticated;
