/**
 * KnowledgeBasePanel
 *
 * Lets a logged-in user:
 *  1. Pick a project (from connected Vercel projects, or type a custom name)
 *  2. Upload a README.md (file picker or paste)
 *  3. See chunking progress and upload result
 *  4. View all their previously uploaded documents (per-user, from the server)
 *  5. Delete a document from the knowledge base
 *
 * All knowledge is stored in Qdrant scoped by userId + projectId, so each
 * user only ever sees their own data.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { User, SupabaseClient, UploadReadmeResponse } from '@apex/shared';
import { VercelProjectItem } from './LogInvestigationPanel';

const currentHost =
  typeof window !== 'undefined' && window.location.hostname
    ? window.location.hostname
    : 'localhost';
const API_URL = import.meta.env.VITE_SERVER_URL || `http://${currentHost}:3001`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeStatusResponse {
  qdrantConfigured: boolean;
  qdrantReachable: boolean;
  collectionName: string;
  collectionExists: boolean;
  geminiConfigured: boolean;
  totalDocuments: number;
}

interface StoredDocument {
  id: string;
  userId: string;
  userEmail?: string;
  projectId: string;
  projectName: string;
  filename: string;
  chunkCount: number;
  uploadedAt: string;
  status: 'pending' | 'embedded' | 'failed';
  errorMessage?: string;
}

export interface KnowledgeBasePanelProps {
  currentUser?: User | null;
  supabaseClient?: SupabaseClient | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function fileSizeLabel(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function KnowledgeBasePanel({
  currentUser,
  supabaseClient: _supabaseClient,
}: KnowledgeBasePanelProps = {}) {
  // ── infrastructure status ──────────────────────────────────────────────
  const [kbStatus, setKbStatus] = useState<KnowledgeStatusResponse | null>(null);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);

  // ── vercel projects ────────────────────────────────────────────────────
  const [vercelProjects, setVercelProjects] = useState<VercelProjectItem[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  // ── project selection ──────────────────────────────────────────────────
  const [projectMode, setProjectMode] = useState<'vercel' | 'custom'>('vercel');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [customProjectId, setCustomProjectId] = useState('');
  const [customProjectName, setCustomProjectName] = useState('');

  // ── file / content ─────────────────────────────────────────────────────
  const [readmeContent, setReadmeContent] = useState('');
  const [filename, setFilename] = useState('README.md');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── upload state ───────────────────────────────────────────────────────
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadReadmeResponse | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // ── documents list ─────────────────────────────────────────────────────
  const [documents, setDocuments] = useState<StoredDocument[]>([]);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── active tab ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'upload' | 'library'>('upload');

  // ── Fetch KB status ────────────────────────────────────────────────────
  const checkStatus = useCallback(async () => {
    setIsCheckingStatus(true);
    try {
      const res = await fetch(`${API_URL}/api/knowledge/status`);
      const data = await res.json();
      setKbStatus(data);
    } catch {
      setKbStatus(null);
    } finally {
      setIsCheckingStatus(false);
    }
  }, []);

  // ── Fetch Vercel projects ──────────────────────────────────────────────
  const fetchVercelProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    try {
      const res = await fetch(`${API_URL}/api/vercel/projects`);
      const data = await res.json();
      if (data.success && Array.isArray(data.projects)) {
        setVercelProjects(data.projects);
        if (data.projects.length > 0 && !selectedProjectId) {
          setSelectedProjectId(data.projects[0].id);
        }
      }
    } catch {
      /* Vercel not connected — that's OK, user can use custom mode */
    } finally {
      setIsLoadingProjects(false);
    }
  }, [selectedProjectId]);

  // ── Fetch user's document library ─────────────────────────────────────
  const fetchDocuments = useCallback(async () => {
    if (!currentUser?.id) return;
    setIsLoadingDocs(true);
    try {
      const res = await fetch(
        `${API_URL}/api/knowledge/documents?userId=${encodeURIComponent(currentUser.id)}`
      );
      const data = await res.json();
      if (data.success) setDocuments(data.documents || []);
    } catch {
      /* silently fail */
    } finally {
      setIsLoadingDocs(false);
    }
  }, [currentUser?.id]);

  useEffect(() => {
    checkStatus();
    fetchVercelProjects();
  }, [checkStatus, fetchVercelProjects]);

  useEffect(() => {
    if (activeTab === 'library') fetchDocuments();
  }, [activeTab, fetchDocuments]);

  // ── File picker handler ────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    setUploadResult(null);
    setUploadError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      setReadmeContent((ev.target?.result as string) || '');
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ── Derived project info ───────────────────────────────────────────────
  const resolvedProjectId =
    projectMode === 'vercel' ? selectedProjectId : customProjectId.trim();

  const resolvedProjectName =
    projectMode === 'vercel'
      ? vercelProjects.find((p) => p.id === selectedProjectId)?.name || selectedProjectId
      : customProjectName.trim() || customProjectId.trim();

  // ── Upload handler ─────────────────────────────────────────────────────
  const handleUpload = async () => {
    if (!currentUser?.id) {
      setUploadError('You must be signed in to upload documents.');
      return;
    }
    if (!readmeContent.trim()) {
      setUploadError('No README content — paste content or pick a .md file.');
      return;
    }
    if (!resolvedProjectId) {
      setUploadError('Please select or enter a project identifier.');
      return;
    }

    setIsUploading(true);
    setUploadResult(null);
    setUploadError(null);

    try {
      const payload = {
        content: readmeContent,
        projectId: resolvedProjectId,
        projectName: resolvedProjectName,
        filename,
        userId: currentUser.id,
        userEmail: currentUser.email ?? undefined,
      };

      const res = await fetch(`${API_URL}/api/knowledge/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data: UploadReadmeResponse & { message?: string; duplicate?: boolean } =
        await res.json();

      if (data.success) {
        setUploadResult(data);
        // Refresh library if user is on that tab
        if (activeTab === 'library') fetchDocuments();
      } else {
        setUploadError(data.error || 'Upload failed.');
      }
    } catch (err: unknown) {
      setUploadError(
        `Server unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setIsUploading(false);
    }
  };

  // ── Delete document ────────────────────────────────────────────────────
  const handleDelete = async (docId: string) => {
    setDeletingId(docId);
    try {
      const res = await fetch(`${API_URL}/api/knowledge/documents/${encodeURIComponent(docId)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        setDocuments((prev) => prev.filter((d) => d.id !== docId));
      }
    } catch {
      /* silent */
    } finally {
      setDeletingId(null);
    }
  };

  // ── Chunk count estimate ───────────────────────────────────────────────
  const estimatedChunks = readmeContent
    ? Math.max(1, Math.ceil(readmeContent.length / 1500))
    : 0;

  // ──────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100">

      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3 bg-slate-900/40">
        <div className="flex items-center space-x-2.5">
          <div className="h-2.5 w-2.5 rounded-full bg-teal-400 animate-pulse" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Knowledge Base — README Indexer
          </h2>
        </div>

        {/* Status pill */}
        {!isCheckingStatus && kbStatus && (
          <div className="flex items-center gap-2">
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                kbStatus.qdrantReachable
                  ? 'border-teal-700/60 bg-teal-900/30 text-teal-300'
                  : kbStatus.qdrantConfigured
                  ? 'border-amber-700/60 bg-amber-900/30 text-amber-300'
                  : 'border-slate-700 bg-slate-900 text-slate-400'
              }`}
            >
              {kbStatus.qdrantReachable
                ? `Qdrant ● Connected`
                : kbStatus.qdrantConfigured
                ? 'Qdrant ● Unreachable'
                : 'Qdrant ○ Not configured'}
            </span>
            <span
              className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                kbStatus.geminiConfigured
                  ? 'border-indigo-700/60 bg-indigo-900/30 text-indigo-300'
                  : 'border-slate-700 bg-slate-900 text-slate-400'
              }`}
            >
              {kbStatus.geminiConfigured ? 'Gemini ● Ready' : 'Gemini ○ No key'}
            </span>
          </div>
        )}
      </div>

      {/* ── Tab bar ── */}
      <div className="flex border-b border-slate-800 bg-slate-900/60 px-4 pt-1">
        <button
          onClick={() => setActiveTab('upload')}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition ${
            activeTab === 'upload'
              ? 'border-teal-500 text-teal-300 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          1. Upload README
        </button>
        <button
          onClick={() => setActiveTab('library')}
          className={`px-4 py-2 text-xs font-medium border-b-2 transition ${
            activeTab === 'library'
              ? 'border-teal-500 text-teal-300 font-semibold'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          2. My Knowledge Library{documents.length > 0 ? ` (${documents.length})` : ''}
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* TAB 1 — UPLOAD                                                    */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'upload' && (
        <div className="flex flex-col flex-1 overflow-y-auto p-4 space-y-4">

          {/* Auth gate */}
          {!currentUser && (
            <div className="rounded-xl border border-amber-800/50 bg-amber-950/20 p-4 text-xs text-amber-300 flex items-start gap-2">
              <span className="text-base mt-0.5">⚠</span>
              <div>
                <div className="font-semibold mb-0.5">Sign in required</div>
                <div className="text-amber-400/80">
                  Please sign in with Google (top-right) to upload README files. Each document is
                  stored in your private vector space, scoped to your account.
                </div>
              </div>
            </div>
          )}

          {/* ── Step 1: Choose project ── */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal-800 text-teal-200 text-[9px] font-bold">1</span>
              Select Project
            </div>

            {/* Mode toggle */}
            <div className="flex rounded-lg border border-slate-800 bg-slate-950 p-0.5">
              <button
                onClick={() => setProjectMode('vercel')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition ${
                  projectMode === 'vercel'
                    ? 'bg-slate-800 text-slate-100 shadow'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <span className="mr-1.5">▲</span>Vercel Project
              </button>
              <button
                onClick={() => setProjectMode('custom')}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition ${
                  projectMode === 'custom'
                    ? 'bg-slate-800 text-slate-100 shadow'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <span className="mr-1.5">✏</span>Custom
              </button>
            </div>

            {projectMode === 'vercel' ? (
              isLoadingProjects ? (
                <div className="text-xs text-slate-500 flex items-center gap-2">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
                  Loading Vercel projects...
                </div>
              ) : vercelProjects.length === 0 ? (
                <div className="text-xs text-slate-500">
                  No Vercel projects found. Connect Vercel in the Log Investigation panel first, or
                  switch to Custom mode.
                </div>
              ) : (
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 focus:border-teal-500 focus:outline-none"
                >
                  {vercelProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.framework ? ` (${p.framework})` : ''}
                    </option>
                  ))}
                </select>
              )
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Project ID (e.g. my-app or prj_xxx)"
                  value={customProjectId}
                  onChange={(e) => setCustomProjectId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:border-teal-500 focus:outline-none font-mono"
                />
                <input
                  type="text"
                  placeholder="Project display name (optional)"
                  value={customProjectName}
                  onChange={(e) => setCustomProjectName(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 placeholder-slate-600 focus:border-teal-500 focus:outline-none"
                />
              </div>
            )}

            {resolvedProjectId && (
              <div className="text-[10px] text-slate-500">
                Project ID: <span className="font-mono text-slate-400">{resolvedProjectId}</span>
                {resolvedProjectName !== resolvedProjectId && (
                  <> · Name: <span className="text-slate-400">{resolvedProjectName}</span></>
                )}
              </div>
            )}
          </div>

          {/* ── Step 2: Load README ── */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal-800 text-teal-200 text-[9px] font-bold">2</span>
              Load README Content
            </div>

            {/* File upload button */}
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt,.markdown"
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-medium text-slate-200 transition"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Pick .md file
              </button>
              {readmeContent && (
                <span className="text-[10px] text-slate-400 font-mono">
                  {filename} · {fileSizeLabel(readmeContent.length)} · ~{estimatedChunks} chunk{estimatedChunks !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {/* Paste area */}
            <textarea
              rows={10}
              value={readmeContent}
              onChange={(e) => {
                setReadmeContent(e.target.value);
                setUploadResult(null);
                setUploadError(null);
              }}
              placeholder={`# My Project\n\nPaste README markdown here, or use the file picker above.\n\nThe content will be chunked by headings and paragraphs, embedded via Gemini text-embedding-004, and stored in Qdrant scoped to your account and this project.`}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-xs text-slate-300 placeholder-slate-600 font-mono focus:border-teal-500 focus:outline-none resize-none leading-relaxed"
            />
          </div>

          {/* ── Step 3: Upload ── */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <div className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal-800 text-teal-200 text-[9px] font-bold">3</span>
              Index into Qdrant
            </div>

            {/* Info strip */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-[10px] text-slate-400 space-y-1">
              <div>• Markdown is split by headings/paragraphs into chunks of ~1500 chars</div>
              <div>• Each chunk is embedded with <span className="text-indigo-400">Gemini text-embedding-004</span> (768-dim)</div>
              <div>• Vectors are upserted into Qdrant collection <span className="font-mono text-teal-400">apex_knowledge</span></div>
              <div>• Each point carries your <span className="text-teal-300">userId</span> + <span className="text-teal-300">projectId</span> for per-user scoping</div>
            </div>

            <button
              onClick={handleUpload}
              disabled={isUploading || !currentUser || !readmeContent.trim() || !resolvedProjectId}
              className="w-full rounded-lg bg-teal-700 hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed py-2.5 text-xs font-semibold text-white transition shadow-md shadow-teal-800/30 flex items-center justify-center gap-2"
            >
              {isUploading ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Embedding & uploading to Qdrant…
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                  </svg>
                  Upload README to Knowledge Base
                </>
              )}
            </button>

            {/* Error */}
            {uploadError && (
              <div className="rounded-lg border border-rose-800/60 bg-rose-950/30 p-3 text-xs text-rose-300 flex items-start gap-2">
                <span>⚠</span>
                <span>{uploadError}</span>
              </div>
            )}

            {/* Success */}
            {uploadResult?.success && (
              <div className="rounded-lg border border-teal-700/50 bg-teal-950/30 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-teal-300">
                  <span>✓</span>
                  <span>Successfully indexed into Qdrant</span>
                </div>
                <div className="text-[10px] text-slate-400 space-y-0.5 font-mono">
                  <div>Document ID: <span className="text-slate-300">{uploadResult.documentId}</span></div>
                  <div>Chunks uploaded: <span className="text-teal-300 font-semibold">{uploadResult.chunkCount}</span></div>
                  <div>Collection: <span className="text-teal-400">{uploadResult.collectionName}</span></div>
                  <div>Project: <span className="text-slate-300">{resolvedProjectName}</span></div>
                  <div>User: <span className="text-slate-300">{currentUser?.email}</span></div>
                </div>
                <button
                  onClick={() => setActiveTab('library')}
                  className="text-[10px] text-teal-400 hover:text-teal-200 underline transition"
                >
                  View in My Knowledge Library →
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* TAB 2 — LIBRARY                                                   */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'library' && (
        <div className="flex flex-col flex-1 overflow-y-auto p-4 space-y-3">

          {!currentUser ? (
            <div className="rounded-xl border border-amber-800/50 bg-amber-950/20 p-4 text-xs text-amber-300">
              Sign in to view your uploaded documents.
            </div>
          ) : isLoadingDocs ? (
            <div className="flex items-center gap-2 text-xs text-slate-400 py-6 justify-center">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-teal-500 border-t-transparent" />
              Loading your knowledge library…
            </div>
          ) : documents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center space-y-2">
              <div className="text-2xl">📚</div>
              <div className="text-xs font-semibold text-slate-300">No documents indexed yet</div>
              <div className="text-[10px] text-slate-500">
                Upload a README from the first tab to start building your knowledge base.
              </div>
              <button
                onClick={() => setActiveTab('upload')}
                className="mt-2 text-[10px] text-teal-400 hover:text-teal-200 underline transition"
              >
                Go to Upload →
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-500">
                  {documents.length} document{documents.length !== 1 ? 's' : ''} · user: {currentUser.email}
                </span>
                <button
                  onClick={fetchDocuments}
                  className="text-[10px] text-teal-400 hover:text-teal-200 transition"
                >
                  ↻ Refresh
                </button>
              </div>

              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-base flex-shrink-0">
                        {doc.status === 'embedded' ? '📄' : doc.status === 'failed' ? '⚠️' : '⏳'}
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-200 truncate">
                          {doc.filename}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate">
                          {doc.projectName}
                          <span className="ml-1 font-mono text-slate-600">({doc.projectId})</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold ${
                          doc.status === 'embedded'
                            ? 'border-teal-700/60 bg-teal-950/40 text-teal-300'
                            : doc.status === 'failed'
                            ? 'border-rose-700/60 bg-rose-950/40 text-rose-300'
                            : 'border-amber-700/60 bg-amber-950/40 text-amber-300'
                        }`}
                      >
                        {doc.status.toUpperCase()}
                      </span>
                      <button
                        onClick={() => handleDelete(doc.id)}
                        disabled={deletingId === doc.id}
                        className="rounded border border-slate-700 hover:border-rose-700 bg-slate-800 hover:bg-rose-950/40 px-2 py-0.5 text-[9px] text-slate-400 hover:text-rose-300 transition disabled:opacity-40"
                      >
                        {deletingId === doc.id ? '…' : 'Delete'}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-slate-500">
                    <span>{doc.chunkCount} chunk{doc.chunkCount !== 1 ? 's' : ''}</span>
                    <span>Uploaded {formatDate(doc.uploadedAt)}</span>
                    <span className="font-mono">{doc.id.slice(0, 8)}…</span>
                  </div>

                  {doc.status === 'failed' && doc.errorMessage && (
                    <div className="rounded border border-rose-800/40 bg-rose-950/20 px-2 py-1.5 text-[10px] text-rose-300">
                      {doc.errorMessage}
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
