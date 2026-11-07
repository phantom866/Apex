/**
 * APEX NOVA — Desktop App
 *
 * Screen flow:
 *  1. LoginScreen       — unauthenticated, Google Sign-In
 *  2. ProjectsScreen    — Vercel project list + setup status per project
 *  3. SetupScreen       — README upload for a chosen project → Qdrant indexing
 *  4. DashboardScreen   — live logs + incident feed for a specific project
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Incident,
  WsServerMessage,
  WsClientMessage,
  User,
  SupabaseClient,
  createApexSupabaseClient,
  signInWithGoogle,
  signOutSupabase,
  fetchUserIntegration,
  saveUserIntegration,
  syncIncidentToSupabase,
  UploadReadmeResponse,
} from '@apex/shared';
import LogInvestigationPanel, { VercelProjectItem } from './LogInvestigationPanel';

const currentHost =
  typeof window !== 'undefined' && window.location.hostname
    ? window.location.hostname
    : 'localhost';
const WS_URL = import.meta.env.VITE_WS_URL || `ws://${currentHost}:3001/ws`;
const API_URL = import.meta.env.VITE_SERVER_URL || `http://${currentHost}:3001`;

const DEFAULT_SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://rpfixehzgjydwfqlxdiu.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwZml4ZWh6Z2p5ZHdmcWx4ZGl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwMjIyNDksImV4cCI6MjEwOTU5ODI0OX0.W4jCs59TlthAW2ev87CjVzo9pkqHp5xHt6vc7r4YsJQ';

type AppScreen = 'auth-loading' | 'login' | 'projects' | 'setup' | 'dashboard';

// Projects that have been indexed (stored in localStorage per userId)
function getIndexedProjects(userId: string): string[] {
  try {
    const raw = localStorage.getItem(`apex_indexed_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function addIndexedProject(userId: string, projectId: string) {
  const list = getIndexedProjects(userId);
  if (!list.includes(projectId)) {
    localStorage.setItem(`apex_indexed_${userId}`, JSON.stringify([...list, projectId]));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 1 — Login
// ─────────────────────────────────────────────────────────────────────────────

function LoginScreen({
  onLogin,
}: {
  onLogin: (user: User, client: SupabaseClient) => void;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supabase] = useState<SupabaseClient | null>(() =>
    createApexSupabaseClient(DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY)
  );

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      if (u) onLogin(u, supabase);
    });
  }, [supabase, onLogin]);

  const handleGoogleSignIn = async () => {
    if (!supabase) { setError('Supabase not configured'); return; }
    setIsLoading(true);
    setError(null);
    const { error: err } = await signInWithGoogle(supabase);
    if (err) { setError(err.message); setIsLoading(false); }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-slate-950">
      <div className="w-full max-w-sm space-y-8 px-6">
        {/* Logo */}
        <div className="text-center space-y-3">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-600 shadow-2xl shadow-indigo-500/40">
            <span className="text-3xl font-black text-white">A</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">APEX NOVA</h1>
            <p className="mt-1 text-sm text-slate-400">Autonomous Platform for Engineering eXcellence</p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-8 shadow-2xl space-y-6 backdrop-blur">
          <div className="space-y-1 text-center">
            <h2 className="text-base font-semibold text-slate-100">Welcome back</h2>
            <p className="text-xs text-slate-400">Sign in to monitor your Vercel projects</p>
          </div>

          <button
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 active:bg-slate-100 px-4 py-3 text-sm font-semibold text-slate-800 shadow-lg transition disabled:opacity-50"
          >
            <svg className="h-5 w-5 flex-shrink-0" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            <span>{isLoading ? 'Redirecting to Google…' : 'Continue with Google'}</span>
          </button>

          {error && (
            <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">
              ⚠ {error}
            </div>
          )}

          <p className="text-center text-[11px] text-slate-500 leading-relaxed">
            Your incidents and project data are scoped to your account and stored securely.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 2 — Projects list
// ─────────────────────────────────────────────────────────────────────────────

function ProjectsScreen({
  user,
  supabase,
  onSelectProject,
  onSignOut,
}: {
  user: User;
  supabase: SupabaseClient;
  onSelectProject: (project: VercelProjectItem, isSetup: boolean) => void;
  onSignOut: () => void;
}) {
  const [vercelToken, setVercelToken] = useState('');
  const [vercelTeamId, setVercelTeamId] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [vercelUser, setVercelUser] = useState<{ username: string; name?: string } | null>(null);
  const [projects, setProjects] = useState<VercelProjectItem[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [indexedProjectIds, setIndexedProjectIds] = useState<string[]>(() => getIndexedProjects(user.id));

  // Refresh indexed list when we return to projects screen
  useEffect(() => {
    setIndexedProjectIds(getIndexedProjects(user.id));
  }, [user.id]);

  const userFullName =
    user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User';
  const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture;

  // On mount: check if server already has a Vercel token (from .env or previous session)
  useEffect(() => {
    checkVercelStatus();
  }, []);

  const checkVercelStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/vercel/status`);
      const data = await res.json();
      if (data.configured && data.valid && data.user) {
        setIsConnected(true);
        setVercelUser(data.user);
        fetchProjects();
        return;
      }
    } catch { /* server not ready */ }

    // Try loading from Supabase user_integrations
    const integration = await fetchUserIntegration(supabase, user.id, 'vercel');
    if (integration?.token) {
      await connectWithToken(integration.token, integration.teamId || undefined, false);
    }
  };

  const fetchProjects = async () => {
    setIsLoadingProjects(true);
    try {
      const res = await fetch(`${API_URL}/api/vercel/projects`);
      const data = await res.json();
      if (data.success && Array.isArray(data.projects)) {
        setProjects(data.projects);
      }
    } catch { /* ignore */ }
    finally { setIsLoadingProjects(false); }
  };

  const connectWithToken = async (token: string, teamId?: string, saveToSupabase = true) => {
    setIsConnecting(true);
    setConnectError(null);
    try {
      const res = await fetch(`${API_URL}/api/vercel/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, teamId: teamId || undefined }),
      });
      const data = await res.json();
      if (data.success && data.user) {
        setIsConnected(true);
        setVercelUser(data.user);
        if (saveToSupabase) {
          await saveUserIntegration(supabase, user.id, 'vercel', token, teamId || null, {
            username: data.user.username,
            email: data.user.email,
            name: data.user.name,
          });
        }
        setVercelToken('');
        fetchProjects();
      } else {
        setConnectError(data.error || 'Authentication failed.');
      }
    } catch (err: unknown) {
      setConnectError(`Connection error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsConnecting(false); }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vercelToken.trim()) return;
    await connectWithToken(vercelToken.trim(), vercelTeamId.trim() || undefined);
  };

  const handleDisconnect = async () => {
    await fetch(`${API_URL}/api/vercel/token`, { method: 'DELETE' }).catch(() => {});
    setIsConnected(false);
    setVercelUser(null);
    setProjects([]);
  };

  const filteredProjects = projects.filter(
    (p) =>
      !search.trim() ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.framework && p.framework.toLowerCase().includes(search.toLowerCase()))
  );

  const readyProjects = filteredProjects.filter((p) => indexedProjectIds.includes(p.id));
  const newProjects = filteredProjects.filter((p) => !indexedProjectIds.includes(p.id));

  const deploymentColor = (state?: string) => {
    if (!state) return 'bg-slate-700 text-slate-300';
    if (state === 'READY') return 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    if (state === 'ERROR') return 'bg-rose-500/20 text-rose-300 border border-rose-500/30';
    return 'bg-amber-500/20 text-amber-300 border border-amber-500/30';
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-900/80 px-5 backdrop-blur flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white shadow-lg shadow-indigo-500/20 text-sm">A</div>
          <div>
            <h1 className="text-sm font-semibold text-slate-100">APEX <span className="text-xs font-normal text-indigo-400">NOVA</span></h1>
            <p className="text-[10px] text-slate-500">Projects</p>
          </div>
        </div>

        {/* User info + sign out */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5">
            {avatarUrl ? (
              <img src={avatarUrl} alt={userFullName} className="h-6 w-6 rounded-full object-cover border border-slate-700" />
            ) : (
              <div className="h-6 w-6 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                {userFullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="text-xs font-semibold text-slate-200 leading-tight">{userFullName}</div>
              <div className="text-[10px] text-slate-500">{user.email}</div>
            </div>
            <button
              onClick={onSignOut}
              className="ml-2 rounded border border-slate-700 hover:border-rose-700 bg-slate-800 hover:bg-rose-950/40 px-2 py-0.5 text-[10px] text-slate-400 hover:text-rose-300 transition"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* Not connected to Vercel */}
        {!isConnected ? (
          <div className="flex items-start justify-center pt-16 px-4">
            <div className="w-full max-w-md space-y-6">
              <div className="text-center space-y-2">
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-2xl mx-auto">▲</div>
                <h2 className="text-lg font-semibold text-slate-100">Connect Vercel</h2>
                <p className="text-sm text-slate-400">Link your Vercel account to list and monitor your projects.</p>
              </div>

              <form onSubmit={handleConnect} className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-slate-300">Personal Access Token</label>
                    <a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer" className="text-[11px] text-indigo-400 hover:text-indigo-300 underline">
                      Get token ↗
                    </a>
                  </div>
                  <div className="relative">
                    <input
                      type={showToken ? 'text' : 'password'}
                      placeholder="vcp_... or legacy token"
                      value={vercelToken}
                      onChange={(e) => setVercelToken(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 pr-10 text-xs text-slate-200 placeholder-slate-600 font-mono focus:border-indigo-500 focus:outline-none"
                    />
                    <button type="button" onClick={() => setShowToken(!showToken)} className="absolute right-2.5 top-2.5 text-[10px] text-slate-500 hover:text-slate-300">
                      {showToken ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-slate-400">Team ID (optional)</label>
                  <input
                    type="text"
                    placeholder="Leave blank for personal account"
                    value={vercelTeamId}
                    onChange={(e) => setVercelTeamId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                {connectError && (
                  <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">⚠ {connectError}</div>
                )}

                <button
                  type="submit"
                  disabled={isConnecting || !vercelToken.trim()}
                  className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 py-2.5 text-xs font-semibold text-white transition shadow-md"
                >
                  {isConnecting ? 'Connecting…' : 'Connect Vercel Account'}
                </button>
              </form>
            </div>
          </div>
        ) : (
          /* Connected — show project list */
          <div className="px-5 py-5 space-y-5 max-w-5xl mx-auto">
            {/* Connected bar */}
            <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <div className="h-7 w-7 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-xs font-bold text-white">
                  {vercelUser?.username?.charAt(0).toUpperCase() || '▲'}
                </div>
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-slate-200">{vercelUser?.name || vercelUser?.username}</span>
                    <span className="text-[10px] text-slate-500 font-mono">@{vercelUser?.username}</span>
                  </div>
                  <p className="text-[10px] text-slate-500">{projects.length} project{projects.length !== 1 ? 's' : ''} loaded</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={fetchProjects} disabled={isLoadingProjects} className="rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2.5 py-1 text-[11px] text-slate-300 transition">
                  {isLoadingProjects ? 'Refreshing…' : '↻ Refresh'}
                </button>
                <button onClick={handleDisconnect} className="rounded border border-slate-700 bg-transparent hover:bg-rose-950/40 hover:border-rose-700/60 px-2.5 py-1 text-[11px] text-slate-400 hover:text-rose-300 transition">
                  Disconnect
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="relative">
              <svg className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search projects…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 pl-9 pr-4 py-2 text-xs text-slate-200 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            {/* Grid — two sections */}
            {isLoadingProjects ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="h-36 rounded-xl border border-slate-800 bg-slate-900/60 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="space-y-8">

                {/* ── Section 1: Ready projects ── */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                      Your Projects
                    </h3>
                    <span className="rounded-full bg-teal-900/40 border border-teal-700/40 px-2 py-0.5 text-[9px] text-teal-400 font-medium">
                      {readyProjects.length} ready
                    </span>
                  </div>

                  {readyProjects.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-800 py-10 text-center text-xs text-slate-600">
                      No projects set up yet — add one below.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {readyProjects.map((project) => {
                        const latestDeploy = project.latestDeployments?.[0];
                        return (
                          <button
                            key={project.id}
                            onClick={() => onSelectProject(project, true)}
                            className="group text-left rounded-xl border border-teal-800/40 hover:border-teal-500/60 bg-teal-950/10 hover:bg-teal-950/20 p-4 transition-all shadow-sm space-y-3"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg bg-teal-900/40 text-teal-200 font-bold text-sm">▲</div>
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-slate-100 truncate">{project.name}</div>
                                  {project.framework && <div className="text-[10px] text-slate-500 mt-0.5">{project.framework}</div>}
                                </div>
                              </div>
                              <span className="flex-shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold bg-teal-500/15 text-teal-300 border border-teal-500/30">
                                ✓ Ready
                              </span>
                            </div>
                            {latestDeploy && (
                              <div className="flex items-center gap-1.5">
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${deploymentColor(latestDeploy.readyState)}`}>
                                  {latestDeploy.readyState}
                                </span>
                                {project.productionUrl && (
                                  <span className="text-[10px] text-slate-500 truncate font-mono">
                                    {project.productionUrl.replace('https://', '')}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="text-[11px] text-teal-600 group-hover:text-teal-400 transition flex items-center gap-1">
                              <span className="h-1.5 w-1.5 rounded-full bg-teal-400 animate-pulse" /> Open dashboard →
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* ── Section 2: Add new project ── */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                      Add New Project
                    </h3>
                    <span className="rounded-full bg-slate-800 border border-slate-700 px-2 py-0.5 text-[9px] text-slate-500 font-medium">
                      {newProjects.length} available
                    </span>
                  </div>

                  {newProjects.length === 0 && !search.trim() ? (
                    <div className="rounded-xl border border-dashed border-slate-800 py-6 text-center text-xs text-slate-600">
                      All your Vercel projects have been set up.
                    </div>
                  ) : newProjects.length === 0 ? (
                    <div className="py-4 text-center text-xs text-slate-600">No projects match your search.</div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {newProjects.map((project) => {
                        const latestDeploy = project.latestDeployments?.[0];
                        return (
                          <button
                            key={project.id}
                            onClick={() => onSelectProject(project, false)}
                            className="group text-left rounded-xl border border-slate-800 hover:border-indigo-500/40 bg-slate-900/60 hover:bg-slate-900 p-4 transition-all shadow-sm space-y-3 opacity-80 hover:opacity-100"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-800 group-hover:bg-slate-700 transition text-slate-400 font-bold text-sm">▲</div>
                                <div className="min-w-0">
                                  <div className="text-sm font-semibold text-slate-300 truncate">{project.name}</div>
                                  {project.framework && <div className="text-[10px] text-slate-600 mt-0.5">{project.framework}</div>}
                                </div>
                              </div>
                              <span className="flex-shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold bg-slate-800 text-slate-500 border border-slate-700">
                                Setup
                              </span>
                            </div>
                            {latestDeploy && (
                              <div className="flex items-center gap-1.5">
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${deploymentColor(latestDeploy.readyState)}`}>
                                  {latestDeploy.readyState}
                                </span>
                                {project.productionUrl && (
                                  <span className="text-[10px] text-slate-600 truncate font-mono">
                                    {project.productionUrl.replace('https://', '')}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="text-[11px] text-slate-600 group-hover:text-indigo-400 transition">
                              Upload README to set up →
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 3 — Setup (README upload)
// ─────────────────────────────────────────────────────────────────────────────

function SetupScreen({
  user,
  project,
  onSetupComplete,
  onBack,
}: {
  user: User;
  project: VercelProjectItem;
  onSetupComplete: () => void;
  onBack: () => void;
}) {
  const [readmeContent, setReadmeContent] = useState('');
  const [filename, setFilename] = useState('README.md');
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState<(UploadReadmeResponse & { message?: string }) | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    setResult(null);
    setUploadError(null);
    const reader = new FileReader();
    reader.onload = (ev) => setReadmeContent((ev.target?.result as string) || '');
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleUpload = async () => {
    if (!readmeContent.trim()) { setUploadError('Please add README content first.'); return; }
    setIsUploading(true);
    setUploadError(null);
    setResult(null);
    try {
      const res = await fetch(`${API_URL}/api/knowledge/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: readmeContent,
          projectId: project.id,
          projectName: project.name,
          filename,
          userId: user.id,
          userEmail: user.email,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data);
        addIndexedProject(user.id, project.id);
      } else {
        setUploadError(data.error || 'Upload failed.');
      }
    } catch (err: unknown) {
      setUploadError(`Server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsUploading(false);
    }
  };

  const estimatedChunks = readmeContent ? Math.max(1, Math.ceil(readmeContent.length / 1500)) : 0;

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="flex h-14 items-center gap-3 border-b border-slate-800 bg-slate-900/80 px-5 backdrop-blur flex-shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Projects
        </button>
        <span className="text-slate-700">/</span>
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded bg-slate-800 text-xs font-bold text-white">▲</div>
          <span className="text-sm font-semibold text-slate-200">{project.name}</span>
          {project.framework && <span className="text-xs text-slate-500">{project.framework}</span>}
        </div>
        <span className="ml-auto rounded-full border border-amber-600/40 bg-amber-950/30 px-2 py-0.5 text-[10px] text-amber-300 font-medium">
          Setup Required
        </span>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-5 py-8 space-y-6">
          {/* Intro */}
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-white">Set up <span className="text-indigo-400">{project.name}</span></h2>
            <p className="text-sm text-slate-400 leading-relaxed">
              Upload the README for this project. APEX will chunk it, generate vector embeddings,
              and store them in Qdrant so the AI can give project-aware root-cause analysis.
            </p>
          </div>

          {/* How it works */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-2">
            <div className="text-xs font-semibold text-slate-300 mb-3">How it works</div>
            {[
              ['📄', 'Upload README', 'Markdown is split by headings and paragraphs into ~1500-char chunks'],
              ['🧠', 'Generate embeddings', 'Each chunk is embedded with Gemini text-embedding-001 (3072-dim)'],
              ['🗄️', 'Store in Qdrant', `Vectors are saved in collection "${project.name.toLowerCase().replace(/\s+/g, '-')}" scoped to your account`],
              ['📊', 'View live logs', 'Your project dashboard shows real Vercel logs + AI incident detection'],
            ].map(([icon, title, desc]) => (
              <div key={title as string} className="flex items-start gap-3 py-1.5">
                <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
                <div>
                  <div className="text-xs font-medium text-slate-200">{title}</div>
                  <div className="text-[11px] text-slate-500 leading-relaxed">{desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Upload card */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
            {/* File button */}
            <div className="flex items-center gap-3">
              <input ref={fileInputRef} type="file" accept=".md,.txt,.markdown" className="hidden" onChange={handleFileSelect} />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Pick README file
              </button>
              {readmeContent && (
                <span className="text-[10px] text-slate-400 font-mono">
                  {filename} · {(readmeContent.length / 1000).toFixed(1)}k chars · ~{estimatedChunks} chunk{estimatedChunks !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Textarea */}
            <textarea
              rows={12}
              value={readmeContent}
              onChange={(e) => { setReadmeContent(e.target.value); setResult(null); setUploadError(null); }}
              placeholder={`# ${project.name}\n\nPaste your README.md content here, or use the file picker above.\n\nAPEX will extract knowledge from this document to provide context-aware incident analysis for this project.`}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-xs text-slate-300 placeholder-slate-600 font-mono focus:border-indigo-500 focus:outline-none resize-none leading-relaxed"
            />

            {/* Upload button */}
            <button
              onClick={handleUpload}
              disabled={isUploading || !readmeContent.trim()}
              className="w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed py-3 text-sm font-semibold text-white transition shadow-lg shadow-indigo-500/20 flex items-center justify-center gap-2"
            >
              {isUploading ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Embedding & uploading to Qdrant…
                </>
              ) : (
                <>
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  Index README into Knowledge Base
                </>
              )}
            </button>

            {uploadError && (
              <div className="rounded-lg border border-rose-800/60 bg-rose-950/30 px-3 py-2.5 text-xs text-rose-300 flex items-start gap-2">
                <span className="flex-shrink-0">⚠</span> {uploadError}
              </div>
            )}

            {result?.success && (
              <div className="rounded-xl border border-teal-700/50 bg-teal-950/30 p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-teal-300">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Project indexed successfully
                </div>
                <div className="text-[11px] text-slate-400 space-y-0.5 font-mono">
                  <div>Chunks: <span className="text-teal-300 font-semibold">{result.chunkCount}</span></div>
                  <div>Collection: <span className="text-teal-400">{result.collectionName}</span></div>
                  <div>Document: <span className="text-slate-300">{result.documentId?.slice(0, 16)}…</span></div>
                </div>
                <button
                  onClick={onSetupComplete}
                  className="w-full rounded-xl bg-teal-700 hover:bg-teal-600 py-2.5 text-sm font-semibold text-white transition shadow-md shadow-teal-700/20 flex items-center justify-center gap-2"
                >
                  Open Project Dashboard →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN 4 — Dashboard (live logs + incidents for a specific project)
// ─────────────────────────────────────────────────────────────────────────────

function DashboardScreen({
  user,
  supabase,
  project,
  onBack,
}: {
  user: User;
  supabase: SupabaseClient;
  project: VercelProjectItem;
  onBack: () => void;
}) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [aiAnalysisMap, setAiAnalysisMap] = useState<Record<string, { analysis: string; rootCause: string; mitigations: string[] }>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [rightPanel, setRightPanel] = useState<'logs' | 'incident'>('logs');

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectWs = useCallback(() => {
    if (socketRef.current && (socketRef.current.readyState === WebSocket.CONNECTING || socketRef.current.readyState === WebSocket.OPEN)) return;
    setWsStatus('connecting');
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;
    ws.onopen = () => {
      setWsStatus('connected');
      ws.send(JSON.stringify({ type: 'subscribe_incidents' } as WsClientMessage));
    };
    ws.onmessage = (event) => {
      try {
        const msg: WsServerMessage = JSON.parse(event.data);
        if (msg.type === 'incident_created') {
          setIncidents((prev) => prev.some((i) => i.id === msg.incident.id) ? prev : [msg.incident, ...prev]);
        } else if (msg.type === 'incident_updated') {
          setIncidents((prev) => prev.map((i) => i.id === msg.incident.id ? msg.incident : i));
          setSelectedIncident((curr) => curr?.id === msg.incident.id ? msg.incident : curr);
        } else if (msg.type === 'ai_analysis_result') {
          setAiAnalysisMap((prev) => ({
            ...prev,
            [msg.incidentId]: { analysis: msg.analysis, rootCause: msg.suggestedRootCause, mitigations: msg.recommendedMitigations },
          }));
          setIsAnalyzing(false);
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      setWsStatus('disconnected');
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(connectWs, 3000);
    };
    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connectWs();
    fetch(`${API_URL}/api/incidents`).then((r) => r.json()).then((d) => {
      if (d.success && Array.isArray(d.data)) setIncidents(d.data);
    }).catch(() => {});
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (socketRef.current) { socketRef.current.onclose = null; socketRef.current.close(); }
    };
  }, [connectWs]);

  const handleRequestAnalysis = (incidentId: string) => {
    setIsAnalyzing(true);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'request_ai_analysis', incidentId } as WsClientMessage));
    } else {
      fetch(`${API_URL}/api/incidents/${incidentId}/analyze`, { method: 'POST' })
        .then((r) => r.json())
        .then((res) => {
          if (res.success) {
            setAiAnalysisMap((prev) => ({
              ...prev,
              [incidentId]: { analysis: res.data.analysis, rootCause: res.data.suggestedRootCause, mitigations: res.data.recommendedMitigations },
            }));
            const inc = incidents.find((i) => i.id === incidentId);
            if (inc) syncIncidentToSupabase(supabase, user.id, { ...inc, rootCauseAnalysis: res.data.suggestedRootCause });
          }
        })
        .finally(() => setIsAnalyzing(false));
    }
  };

  const handleSelectIncident = (incidentId: string) => {
    const found = incidents.find((i) => i.id === incidentId);
    if (found) { setSelectedIncident(found); setRightPanel('incident'); }
  };

  const userFullName = user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User';
  const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture;

  return (
    <div className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-900/80 px-5 backdrop-blur flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Projects
          </button>
          <span className="text-slate-700">/</span>
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-slate-800 text-xs font-bold text-white">▲</div>
            <span className="text-sm font-semibold text-slate-200">{project.name}</span>
            {project.framework && <span className="text-xs text-slate-500">{project.framework}</span>}
          </div>
          <span className="rounded-full border border-teal-600/40 bg-teal-950/30 px-2 py-0.5 text-[10px] text-teal-300 font-medium">
            ● Live
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* WS status */}
          <div className="flex items-center gap-1.5 rounded border border-slate-800 bg-slate-900 px-2.5 py-1 text-xs">
            <span className={`h-2 w-2 rounded-full ${wsStatus === 'connected' ? 'bg-emerald-400 animate-pulse' : wsStatus === 'connecting' ? 'bg-amber-400' : 'bg-rose-500'}`} />
            <span className="capitalize text-slate-400">{wsStatus}</span>
          </div>

          {/* View switcher */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-950 p-0.5">
            <button
              onClick={() => setRightPanel('logs')}
              className={`rounded px-3 py-1 text-xs font-medium transition ${rightPanel === 'logs' ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Live Logs
            </button>
            <button
              onClick={() => setRightPanel('incident')}
              className={`rounded px-3 py-1 text-xs font-medium transition ${rightPanel === 'incident' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
            >
              Incidents {incidents.length > 0 ? `(${incidents.length})` : ''}
            </button>
          </div>

          {/* User avatar */}
          <div className="flex items-center gap-1.5">
            {avatarUrl ? (
              <img src={avatarUrl} alt={userFullName} className="h-7 w-7 rounded-full object-cover border border-slate-700" />
            ) : (
              <div className="h-7 w-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                {userFullName.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Body — split layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: incident feed */}
        <aside className="flex w-72 flex-col border-r border-slate-800 bg-slate-900/40 flex-shrink-0">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Incidents ({incidents.length})
            </h2>
            <button
              onClick={() => fetch(`${API_URL}/api/incidents`).then((r) => r.json()).then((d) => d.success && setIncidents(d.data))}
              className="text-[11px] text-indigo-400 hover:text-indigo-300 transition"
            >
              Refresh
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {incidents.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-xs text-slate-600">All clear</div>
            ) : (
              incidents.map((inc) => {
                const isSelected = selectedIncident?.id === inc.id;
                const sev = inc.severity === 'critical' ? 'border-rose-500/50 bg-rose-950/20 text-rose-300'
                  : inc.severity === 'high' ? 'border-amber-500/50 bg-amber-950/20 text-amber-300'
                  : 'border-blue-500/50 bg-blue-950/20 text-blue-300';
                return (
                  <div
                    key={inc.id}
                    onClick={() => { setSelectedIncident(inc); setRightPanel('incident'); }}
                    className={`cursor-pointer rounded-lg border p-3 transition-all ${isSelected ? 'border-indigo-500 bg-indigo-950/30' : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'}`}
                  >
                    <div className="flex items-start justify-between">
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${sev}`}>{inc.severity}</span>
                      <span className="text-[9px] text-slate-500 capitalize">{inc.status}</span>
                    </div>
                    <p className="mt-1.5 text-xs font-medium text-slate-200 line-clamp-2">{inc.title}</p>
                    <p className="mt-0.5 text-[10px] text-slate-500 font-mono">{inc.affectedService}</p>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Right: logs or incident detail */}
        {rightPanel === 'logs' ? (
          <section className="flex flex-1 flex-col overflow-hidden">
            <LogInvestigationPanel
              onSelectIncident={handleSelectIncident}
              currentUser={user}
              supabaseClient={supabase}
              initialProjectId={project.id}
              initialProject={project}
              showProjectSelector={false}
            />
          </section>
        ) : (
          <section className="flex flex-1 flex-col overflow-y-auto bg-slate-950 p-6">
            {selectedIncident ? (
              <div className="max-w-3xl space-y-5">
                {/* Incident header */}
                <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
                  <div className="flex items-center justify-between">
                    <span className="rounded-md bg-indigo-950 border border-indigo-700 px-2 py-1 text-xs font-mono text-indigo-300">
                      {selectedIncident.affectedService}
                    </span>
                    <div className="flex items-center gap-2">
                      {selectedIncident.status === 'detected' && (
                        <button
                          onClick={() => socketRef.current?.readyState === WebSocket.OPEN && socketRef.current.send(JSON.stringify({ type: 'acknowledge_incident', incidentId: selectedIncident.id, status: 'investigating' } as WsClientMessage))}
                          className="rounded bg-slate-800 hover:bg-slate-700 px-3 py-1.5 text-xs text-slate-200 transition"
                        >
                          Acknowledge
                        </button>
                      )}
                      <button
                        disabled={isAnalyzing}
                        onClick={() => handleRequestAnalysis(selectedIncident.id)}
                        className="rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-3.5 py-1.5 text-xs font-medium text-white shadow-md transition"
                      >
                        {isAnalyzing ? 'Analyzing…' : 'Run AI Root-Cause Analysis'}
                      </button>
                    </div>
                  </div>
                  <h2 className="mt-3 text-lg font-semibold text-white">{selectedIncident.title}</h2>
                  <p className="mt-1 text-xs text-slate-400 leading-relaxed">{selectedIncident.description}</p>
                </div>

                {/* AI Analysis */}
                <div className="rounded-xl border border-indigo-900/40 bg-gradient-to-b from-indigo-950/20 to-slate-900/60 p-5">
                  <div className="flex items-center gap-2 text-indigo-400 mb-3">
                    <div className="h-2 w-2 rounded-full bg-indigo-400" />
                    <h3 className="text-xs font-semibold uppercase tracking-wider">NOVA AI Root-Cause Analysis</h3>
                  </div>
                  {aiAnalysisMap[selectedIncident.id] ? (
                    <div className="space-y-3 text-xs">
                      <p className="text-slate-300">{aiAnalysisMap[selectedIncident.id].analysis}</p>
                      <div className="rounded bg-slate-900/80 p-3 border border-slate-800">
                        <span className="font-semibold text-indigo-300">Root Cause: </span>
                        <p className="mt-1 text-slate-200">{aiAnalysisMap[selectedIncident.id].rootCause}</p>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-300">Mitigations:</span>
                        <ul className="mt-1 space-y-1 list-disc list-inside text-slate-300">
                          {aiAnalysisMap[selectedIncident.id].mitigations.map((m, i) => <li key={i}>{m}</li>)}
                        </ul>
                      </div>
                    </div>
                  ) : selectedIncident.rootCauseAnalysis ? (
                    <p className="text-xs text-slate-300">{selectedIncident.rootCauseAnalysis}</p>
                  ) : (
                    <p className="text-xs text-slate-500 italic">Click "Run AI Root-Cause Analysis" to analyse this incident with Gemini.</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-600 space-y-2">
                <svg className="h-10 w-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <p className="text-sm">Select an incident from the left panel</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT — orchestrates screens
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('auth-loading');
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [supabaseClient, setSupabaseClient] = useState<SupabaseClient | null>(null);
  const [selectedProject, setSelectedProject] = useState<VercelProjectItem | null>(null);

  // Initialize Supabase and check existing session on mount
  useEffect(() => {
    const client = createApexSupabaseClient(DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY);
    if (!client) { setScreen('login'); return; }
    setSupabaseClient(client);

    client.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      if (u) {
        setAuthUser(u);
        // Sync stored Vercel token to server
        fetchUserIntegration(client, u.id, 'vercel').then((integration) => {
          if (integration?.token) {
            fetch(`${API_URL}/api/vercel/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: integration.token, teamId: integration.teamId }),
            }).catch(() => {});
          }
        });
        setScreen('projects');
      } else {
        setScreen('login');
      }
    });

    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      const u = session?.user || null;
      if (u && screen !== 'projects' && screen !== 'setup' && screen !== 'dashboard') {
        setAuthUser(u);
        setScreen('projects');
      }
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const handleLogin = useCallback((user: User, client: SupabaseClient) => {
    setAuthUser(user);
    setSupabaseClient(client);
    setScreen('projects');
  }, []);

  const handleSignOut = useCallback(async () => {
    if (supabaseClient) await signOutSupabase(supabaseClient);
    setAuthUser(null);
    setSelectedProject(null);
    setScreen('login');
  }, [supabaseClient]);

  const handleSelectProject = useCallback((project: VercelProjectItem, isSetup: boolean) => {
    setSelectedProject(project);
    setScreen(isSetup ? 'dashboard' : 'setup');
  }, []);

  const handleSetupComplete = useCallback(() => {
    setScreen('dashboard');
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────

  if (screen === 'auth-loading') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950">
        <div className="space-y-3 text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
          <p className="text-xs text-slate-500">Loading…</p>
        </div>
      </div>
    );
  }

  if (screen === 'login') {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (screen === 'projects' && authUser && supabaseClient) {
    return (
      <ProjectsScreen
        user={authUser}
        supabase={supabaseClient}
        onSelectProject={handleSelectProject}
        onSignOut={handleSignOut}
      />
    );
  }

  if (screen === 'setup' && authUser && selectedProject) {
    return (
      <SetupScreen
        user={authUser}
        project={selectedProject}
        onSetupComplete={handleSetupComplete}
        onBack={() => setScreen('projects')}
      />
    );
  }

  if (screen === 'dashboard' && authUser && supabaseClient && selectedProject) {
    return (
      <DashboardScreen
        user={authUser}
        supabase={supabaseClient}
        project={selectedProject}
        onBack={() => setScreen('projects')}
      />
    );
  }

  // Fallback
  return <LoginScreen onLogin={handleLogin} />;
}
