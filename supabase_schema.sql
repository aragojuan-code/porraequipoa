-- PORRA EQUIPO A — SUPABASE STARTER
-- Fase 1: Auth + perfiles + porras privadas + miembros + entrada con código.
-- Ejecutar en Supabase SQL Editor.
-- Importante: NO guardamos contraseñas. Supabase Auth las gestiona.

create extension if not exists pgcrypto;

-- =========================
-- 1. PROFILES
-- =========================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Profiles are readable by authenticated users" on public.profiles;
create policy "Profiles are readable by authenticated users"
on public.profiles
for select
to authenticated
using (true);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
on public.profiles
for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);


-- =========================
-- 2. POOLS
-- =========================

create table if not exists public.pools (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  invite_code text unique not null,
  is_public boolean default false,
  first_match_kickoff timestamptz,
  predictions_close_at timestamptz,
  created_at timestamptz default now()
);

alter table public.pools enable row level security;

-- Helper: comprobar si el usuario pertenece a una porra.
create or replace function public.is_pool_member(pool_uuid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.pool_members pm
    where pm.pool_id = pool_uuid
      and pm.user_id = auth.uid()
  );
$$;

-- Helper: comprobar si el usuario es owner/admin de una porra.
create or replace function public.is_pool_admin(pool_uuid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.pool_members pm
    where pm.pool_id = pool_uuid
      and pm.user_id = auth.uid()
      and pm.role in ('owner', 'admin')
  );
$$;

drop policy if exists "Users can create own pools" on public.pools;
create policy "Users can create own pools"
on public.pools
for insert
to authenticated
with check (auth.uid() = owner_id);

drop policy if exists "Members can read their pools" on public.pools;
create policy "Members can read their pools"
on public.pools
for select
to authenticated
using (
  owner_id = auth.uid()
  or public.is_pool_member(id)
);

drop policy if exists "Pool admins can update their pools" on public.pools;
create policy "Pool admins can update their pools"
on public.pools
for update
to authenticated
using (
  owner_id = auth.uid()
  or public.is_pool_admin(id)
)
with check (
  owner_id = auth.uid()
  or public.is_pool_admin(id)
);


-- =========================
-- 3. POOL MEMBERS
-- =========================

create table if not exists public.pool_members (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz default now(),
  unique(pool_id, user_id)
);

alter table public.pool_members enable row level security;

drop policy if exists "Members can read members of their pools" on public.pool_members;
create policy "Members can read members of their pools"
on public.pool_members
for select
to authenticated
using (
  user_id = auth.uid()
  or public.is_pool_member(pool_id)
);

drop policy if exists "Users can insert themselves as members" on public.pool_members;
create policy "Users can insert themselves as members"
on public.pool_members
for insert
to authenticated
with check (
  user_id = auth.uid()
);

drop policy if exists "Pool admins can update memberships" on public.pool_members;
create policy "Pool admins can update memberships"
on public.pool_members
for update
to authenticated
using (public.is_pool_admin(pool_id))
with check (public.is_pool_admin(pool_id));


-- =========================
-- 4. JOIN POOL BY CODE
-- =========================
-- Esta función permite entrar con código después de login.
-- Devuelve el pool_id al que te has unido.

create or replace function public.join_pool_by_code(code_input text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_pool_id uuid;
begin
  select id into target_pool_id
  from public.pools
  where upper(invite_code) = upper(trim(code_input))
  limit 1;

  if target_pool_id is null then
    raise exception 'Código de porra no encontrado';
  end if;

  insert into public.pool_members (pool_id, user_id, role)
  values (target_pool_id, auth.uid(), 'member')
  on conflict (pool_id, user_id) do nothing;

  return target_pool_id;
end;
$$;


-- =========================
-- 5. CREATE POOL WITH OWNER MEMBERSHIP
-- =========================
-- Crea porra y añade automáticamente al creador como owner.

create or replace function public.create_pool_with_owner(pool_name text)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  new_pool public.pools;
  generated_code text;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión';
  end if;

  if length(trim(pool_name)) < 3 then
    raise exception 'El nombre de la porra es demasiado corto';
  end if;

  generated_code := 'ATEAM-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));

  insert into public.pools (owner_id, name, invite_code)
  values (auth.uid(), trim(pool_name), generated_code)
  returning * into new_pool;

  insert into public.pool_members (pool_id, user_id, role)
  values (new_pool.id, auth.uid(), 'owner');

  return new_pool;
end;
$$;


-- =========================
-- 6. VIEW: MY POOLS
-- =========================

create or replace view public.my_pools as
select
  p.id,
  p.name,
  p.invite_code,
  p.owner_id,
  p.created_at,
  pm.role,
  (
    select count(*)
    from public.pool_members pm2
    where pm2.pool_id = p.id
  ) as member_count
from public.pools p
join public.pool_members pm on pm.pool_id = p.id
where pm.user_id = auth.uid();

grant select on public.my_pools to authenticated;
