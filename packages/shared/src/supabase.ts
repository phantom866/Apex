import { createClient, SupabaseClient, User, Session } from '@supabase/supabase-js';
import { Incident } from './models/incident';

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  avatarUrl?: string;
  updatedAt?: string;
}

export interface UserIntegration {
  id?: string;
  userId: string;
  provider: string; // 'vercel', etc.
  token: string;
  teamId?: string | null;
  accountData?: Record<string, any>;
  updatedAt?: string;
}

/**
 * Resolves Supabase credentials from runtime environment or globalThis.
 */
export function getSupabaseEnvConfig(): { url: string | null; anonKey: string | null } {
  let url: string | null = null;
  let anonKey: string | null = null;

  const g = typeof globalThis !== 'undefined' ? (globalThis as any) : {};
  if (g.process && g.process.env) {
    url = g.process.env.VITE_SUPABASE_URL || g.process.env.SUPABASE_URL || null;
    anonKey = g.process.env.VITE_SUPABASE_ANON_KEY || g.process.env.SUPABASE_ANON_KEY || null;
  }

  if (typeof window !== 'undefined') {
    const win = window as any;
    if (win.__APEX_SUPABASE_URL__) url = win.__APEX_SUPABASE_URL__;
    if (win.__APEX_SUPABASE_KEY__) anonKey = win.__APEX_SUPABASE_KEY__;
  }

  return { url, anonKey };
}

const _clientCache = new Map<string, SupabaseClient>();

/**
 * Creates or retrieves a typed Supabase client.
 * Returns null if Supabase URL and Key are not yet configured.
 */
export function createApexSupabaseClient(
  customUrl?: string | null,
  customKey?: string | null
): SupabaseClient | null {
  const env = getSupabaseEnvConfig();
  const url = customUrl || env.url;
  const anonKey = customKey || env.anonKey;

  if (!url || !anonKey || url === 'your_supabase_project_url' || anonKey === 'your_supabase_anon_key') {
    return null;
  }

  const cacheKey = `${url}:::${anonKey}`;
  const existing = _clientCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  try {
    const client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    _clientCache.set(cacheKey, client);
    return client;
  } catch (err) {
    console.warn('[Supabase] Failed to initialize client:', err);
    return null;
  }
}

/**
 * Initiates Google OAuth authentication via Supabase.
 */
export async function signInWithGoogle(
  client: SupabaseClient,
  redirectTo?: string
): Promise<{ error: Error | null }> {
  try {
    const redirect =
      redirectTo ||
      (typeof window !== 'undefined' ? `${window.location.origin}` : undefined);

    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirect,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });

    return { error: error ? new Error(error.message) : null };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Signs out the current user session.
 */
export async function signOutSupabase(client: SupabaseClient): Promise<{ error: Error | null }> {
  try {
    const { error } = await client.auth.signOut();
    return { error: error ? new Error(error.message) : null };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Saves or updates a user integration (e.g. Vercel token) in public.user_integrations
 */
export async function saveUserIntegration(
  client: SupabaseClient,
  userId: string,
  provider: string,
  token: string,
  teamId?: string | null,
  accountData?: Record<string, any>
): Promise<{ success: boolean; error: string | null }> {
  try {
    const { error } = await client
      .from('user_integrations')
      .upsert(
        {
          user_id: userId,
          provider,
          token,
          team_id: teamId || null,
          account_data: accountData || {},
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,provider' }
      );

    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true, error: null };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fetches stored integration (e.g. Vercel token) for a user
 */
export async function fetchUserIntegration(
  client: SupabaseClient,
  userId: string,
  provider = 'vercel'
): Promise<UserIntegration | null> {
  try {
    const { data, error } = await client
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .maybeSingle();

    if (error || !data) return null;

    return {
      id: data.id,
      userId: data.user_id,
      provider: data.provider,
      token: data.token,
      teamId: data.team_id,
      accountData: data.account_data,
      updatedAt: data.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Syncs an incident to Supabase public.user_incidents
 */
export async function syncIncidentToSupabase(
  client: SupabaseClient,
  userId: string,
  incident: Incident
): Promise<void> {
  try {
    await client.from('user_incidents').upsert({
      id: incident.id,
      user_id: userId,
      title: incident.title,
      description: incident.description,
      severity: incident.severity,
      status: incident.status,
      category: incident.category,
      affected_service: incident.affectedService,
      root_cause_analysis: incident.rootCauseAnalysis,
      metadata: incident.metadata || {},
      recommended_actions: incident.recommendedActions || [],
      detected_at: incident.detectedAt,
      updated_at: incident.updatedAt,
    });
  } catch (err) {
    console.warn('[Supabase Sync] Could not sync incident:', err);
  }
}

/**
 * Fetches all incidents registered for a user from Supabase
 */
export async function fetchUserIncidentsFromSupabase(
  client: SupabaseClient,
  userId: string
): Promise<Incident[]> {
  try {
    const { data, error } = await client
      .from('user_incidents')
      .select('*')
      .eq('user_id', userId)
      .order('detected_at', { ascending: false });

    if (error || !data) return [];

    return data.map((row: any) => ({
      id: row.id,
      title: row.title,
      description: row.description || '',
      severity: row.severity,
      status: row.status,
      category: row.category,
      affectedService: row.affected_service,
      rootCauseAnalysis: row.root_cause_analysis,
      metadata: row.metadata || {},
      recommendedActions: row.recommended_actions || [],
      detectedAt: row.detected_at,
      updatedAt: row.updated_at,
    }));
  } catch {
    return [];
  }
}

export type { User, Session, SupabaseClient };
