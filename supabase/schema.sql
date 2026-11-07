-- ==============================================================================
-- APEX Platform — Supabase Schema & Real-Time Sync
-- ==============================================================================
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql)
--
-- Features:
-- 1. User Profiles linked to Supabase / Google OAuth auth.users
-- 2. User Integrations (persists Vercel token, team ID, account across devices)
-- 3. Incidents store (syncs incidents between Desktop and Mobile)
-- 4. Investigation Reports (syncs root-cause cascade analyses)
-- 5. Row Level Security (RLS) so each user only accesses their own data
-- ==============================================================================

-- 1. PROFILES TABLE (Auto-synced from Google OAuth)
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  full_name text,
  avatar_url text,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Trigger to automatically create profile on Google / OAuth sign up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture', '')
  )
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, profiles.full_name),
    avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url),
    updated_at = timezone('utc'::text, now());
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- 2. USER INTEGRATIONS TABLE (Vercel, GitHub, etc.)
create table if not exists public.user_integrations (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  provider text not null, -- 'vercel', etc.
  token text not null,
  team_id text,
  account_data jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint unique_user_provider unique (user_id, provider)
);

alter table public.user_integrations enable row level security;

create policy "Users can manage own integrations"
  on public.user_integrations for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- 3. USER INCIDENTS TABLE (Syncs incident operations across Desktop & Mobile)
create table if not exists public.user_projects (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  user_email text,
  user_name text,
  project_id text not null,
  project_name text not null,
  framework text,
  production_url text,
  setup_completed boolean default false not null,
  setup_completed_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  constraint unique_user_project unique (user_id, project_id)
);

alter table public.user_projects enable row level security;

create policy "Users can manage own projects"
  on public.user_projects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 4. USER INCIDENTS TABLE (Syncs incident operations across Desktop & Mobile)
create table if not exists public.user_incidents (
  id text primary key,
  user_id uuid references auth.users on delete cascade not null,
  title text not null,
  description text,
  severity text not null default 'medium',
  status text not null default 'detected',
  category text default 'availability',
  affected_service text not null,
  root_cause_analysis text,
  metadata jsonb default '{}'::jsonb,
  recommended_actions jsonb default '[]'::jsonb,
  detected_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.user_incidents enable row level security;

create policy "Users can manage own incidents"
  on public.user_incidents for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- 5. USER INVESTIGATION REPORTS TABLE (Syncs correlated root-cause reports)
create table if not exists public.user_reports (
  id text primary key,
  user_id uuid references auth.users on delete cascade not null,
  title text not null,
  summary text,
  probable_root_cause text,
  root_cause_service text,
  severity text not null,
  affected_services text[] default '{}',
  cascade_data jsonb default '[]'::jsonb,
  evidence jsonb default '[]'::jsonb,
  remediation_steps text[] default '{}',
  is_simulated boolean default false,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.user_reports enable row level security;

create policy "Users can manage own reports"
  on public.user_reports for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- 5. ENABLE REALTIME BROADCAST
alter publication supabase_realtime add table public.user_incidents;
alter publication supabase_realtime add table public.user_integrations;
alter publication supabase_realtime add table public.user_projects;
alter publication supabase_realtime add table public.user_reports;
