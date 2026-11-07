import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  createApexSupabaseClient,
  signInWithGoogle,
  signOutSupabase,
  fetchUserIntegration,
  User,
  SupabaseClient
} from '@apex/shared';

const DEFAULT_SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://rpfixehzgjydwfqlxdiu.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwZml4ZWh6Z2p5ZHdmcWx4ZGl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwMjIyNDksImV4cCI6MjEwOTU5ODI0OX0.W4jCs59TlthAW2ev87CjVzo9pkqHp5xHt6vc7r4YsJQ';

export interface MobileSupabaseAuthBarProps {
  onUserChange?: (user: User | null, supabase: SupabaseClient | null) => void;
  onVercelTokenSynced?: (token: string, teamId?: string) => void;
}

export default function MobileSupabaseAuthBar({
  onUserChange,
  onVercelTokenSynced,
}: MobileSupabaseAuthBarProps) {
  const [supabase, setSupabase] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Preserve callback references to prevent infinite re-render loops
  const onUserChangeRef = useRef(onUserChange);
  const onVercelTokenSyncedRef = useRef(onVercelTokenSynced);
  const lastNotifiedUserIdRef = useRef<string | null>(null);
  const lastNotifiedClientRef = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    onUserChangeRef.current = onUserChange;
  }, [onUserChange]);

  useEffect(() => {
    onVercelTokenSyncedRef.current = onVercelTokenSynced;
  }, [onVercelTokenSynced]);

  const notifyUserChange = useCallback((u: User | null, client: SupabaseClient | null) => {
    const userId = u?.id || null;
    if (lastNotifiedUserIdRef.current === userId && lastNotifiedClientRef.current === client) {
      return;
    }
    lastNotifiedUserIdRef.current = userId;
    lastNotifiedClientRef.current = client;
    onUserChangeRef.current?.(u, client);
  }, []);

  const [supabaseUrl, setSupabaseUrl] = useState<string>(() => {
    return (
      (typeof window !== 'undefined' ? localStorage.getItem('apex_supabase_url') : '') ||
      DEFAULT_SUPABASE_URL
    );
  });
  const [supabaseAnonKey, setSupabaseAnonKey] = useState<string>(() => {
    return (
      (typeof window !== 'undefined' ? localStorage.getItem('apex_supabase_anon_key') : '') ||
      DEFAULT_SUPABASE_ANON_KEY
    );
  });

  const initClient = useCallback((url: string, key: string) => {
    if (!url || !key) {
      setSupabase(null);
      setIsLoading(false);
      notifyUserChange(null, null);
      return;
    }

    const client = createApexSupabaseClient(url, key);
    if (!client) {
      setSupabase(null);
      setIsLoading(false);
      notifyUserChange(null, null);
      return;
    }

    setSupabase(client);

    client.auth.getSession().then(({ data }) => {
      const currentUser = data.session?.user || null;
      setUser(currentUser);
      notifyUserChange(currentUser, client);

      if (currentUser) {
        fetchUserIntegration(client, currentUser.id, 'vercel').then((integration) => {
          if (integration && integration.token) {
            onVercelTokenSyncedRef.current?.(integration.token, integration.teamId || undefined);
          }
        });
      }
      setIsLoading(false);
    });

    const { data: authListener } = client.auth.onAuthStateChange(
      async (event, session) => {
        const authUser = session?.user || null;
        setUser(authUser);
        notifyUserChange(authUser, client);

        if (authUser && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
          const integration = await fetchUserIntegration(client, authUser.id, 'vercel');
          if (integration && integration.token) {
            onVercelTokenSyncedRef.current?.(integration.token, integration.teamId || undefined);
          }
        }
      }
    );

    return () => {
      authListener.subscription.unsubscribe();
    };
  }, [notifyUserChange]);

  useEffect(() => {
    const cleanup = initClient(supabaseUrl, supabaseAnonKey);
    return () => cleanup?.();
  }, [supabaseUrl, supabaseAnonKey, initClient]);

  const handleGoogleSignIn = async () => {
    if (!supabase) {
      setShowConfigModal(true);
      return;
    }
    setAuthError(null);
    setIsLoading(true);

    const { error } = await signInWithGoogle(supabase);
    if (error) {
      setAuthError(error.message);
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (!supabase) return;
    setIsLoading(true);
    await signOutSupabase(supabase);
    setUser(null);
    notifyUserChange(null, supabase);
    setIsLoading(false);
  };

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabaseUrl.trim() || !supabaseAnonKey.trim()) {
      setAuthError('Both Supabase Project URL and Anon Key are required.');
      return;
    }
    localStorage.setItem('apex_supabase_url', supabaseUrl.trim());
    localStorage.setItem('apex_supabase_anon_key', supabaseAnonKey.trim());
    setShowConfigModal(false);
    setAuthError(null);
    initClient(supabaseUrl.trim(), supabaseAnonKey.trim());
  };

  const userFullName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email?.split('@')[0] ||
    'User';
  const avatarUrl = user?.user_metadata?.avatar_url || user?.user_metadata?.picture;

  return (
    <div className="border-b border-slate-800/80 bg-slate-900/60 px-3 py-2 flex items-center justify-between">
      {user ? (
        <div className="flex-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={userFullName}
                className="h-6 w-6 rounded-full object-cover border border-slate-700"
              />
            ) : (
              <div className="h-6 w-6 rounded-full bg-violet-700 text-xs font-bold text-white flex items-center justify-center">
                {userFullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-slate-200 leading-tight">
                {userFullName}
              </span>
              <span className="text-[10px] text-emerald-400 flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Synced across devices
              </span>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            className="rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2 py-1 text-[11px] text-slate-300"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="flex-1 flex items-center gap-2">
          <button
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="flex-1 flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 active:bg-slate-200 py-1.5 text-xs font-semibold text-slate-800 shadow-md transition disabled:opacity-60"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            <span>{isLoading ? 'Connecting...' : 'Sign in with Google'}</span>
          </button>
          <button
            onClick={() => setShowConfigModal(true)}
            className="p-1.5 rounded-lg border border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200"
            title="Configure Supabase"
          >
            ⚙
          </button>
        </div>
      )}

      {/* Config Modal for Mobile */}
      {showConfigModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl space-y-3">
            <div className="flex items-start justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Connect Supabase Project
              </h3>
              <button
                onClick={() => setShowConfigModal(false)}
                className="text-slate-500 hover:text-slate-300"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Provide your Supabase URL & Anon Key to sync Google login and Vercel logs on mobile.
            </p>

            <form onSubmit={handleSaveConfig} className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-slate-300">Project URL</label>
                <input
                  type="text"
                  placeholder="https://xyz.supabase.co"
                  value={supabaseUrl}
                  onChange={(e) => setSupabaseUrl(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              <div>
                <label className="text-[11px] font-medium text-slate-300">Public Anon Key</label>
                <input
                  type="password"
                  placeholder="eyJhbGci..."
                  value={supabaseAnonKey}
                  onChange={(e) => setSupabaseAnonKey(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 font-mono"
                />
              </div>

              {authError && (
                <div className="text-[11px] text-rose-300 bg-rose-950/40 p-2 rounded border border-rose-800">
                  {authError}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="submit"
                  className="flex-1 rounded-lg bg-emerald-600 py-1.5 text-xs font-semibold text-white"
                >
                  Save & Connect
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfigModal(false)}
                  className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
