import { useEffect, useState, useRef, useCallback } from 'react';
import {
  Incident,
  WsServerMessage,
  WsClientMessage,
  User,
  SupabaseClient,
  fetchUserIncidentsFromSupabase,
  syncIncidentToSupabase,
} from '@apex/shared';
import MobileSupabaseAuthBar from './SupabaseAuthBar';

const currentHost = typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : 'localhost';
const WS_URL = import.meta.env.VITE_WS_URL || `ws://${currentHost}:3001/ws`;
const API_URL = import.meta.env.VITE_SERVER_URL || `http://${currentHost}:3001`;

export default function App() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [activeTab, setActiveTab] = useState<'incidents' | 'diagnostics'>('incidents');
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [aiAnalysisMap, setAiAnalysisMap] = useState<Record<string, { analysis: string; rootCause: string; mitigations: string[] }>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [supabaseClient, setSupabaseClient] = useState<SupabaseClient | null>(null);

  const handleUserChange = useCallback((u: User | null, client: SupabaseClient | null) => {
    setAuthUser(u);
    setSupabaseClient(client);
    if (u && client) {
      fetchUserIncidentsFromSupabase(client, u.id).then((synced) => {
        if (synced && synced.length > 0) {
          setIncidents((prev) => {
            const map = new Map(prev.map(i => [i.id, i]));
            synced.forEach(s => map.set(s.id, s));
            return Array.from(map.values());
          });
        }
      });
    }
  }, []);

  const handleVercelTokenSynced = useCallback((token: string, teamId?: string) => {
    fetch(`${API_URL}/api/vercel/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, teamId }),
    }).catch((err) => console.warn('[Mobile Sync] Could not sync Vercel token with server:', err));
  }, []);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connectWs = useCallback(() => {
    if (socketRef.current && (socketRef.current.readyState === WebSocket.CONNECTING || socketRef.current.readyState === WebSocket.OPEN)) {
      return;
    }
    setWsStatus('connecting');
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;

    ws.onopen = () => {
      setWsStatus('connected');
      const subscribeMsg: WsClientMessage = { type: 'subscribe_incidents' };
      ws.send(JSON.stringify(subscribeMsg));
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsServerMessage = JSON.parse(event.data);
        if (msg.type === 'incident_created') {
          setIncidents((prev) => {
            const exists = prev.some((i) => i.id === msg.incident.id);
            if (exists) return prev;
            return [msg.incident, ...prev];
          });
        } else if (msg.type === 'incident_updated') {
          setIncidents((prev) =>
            prev.map((i) => (i.id === msg.incident.id ? msg.incident : i))
          );
          setSelectedIncident((curr) => (curr?.id === msg.incident.id ? msg.incident : curr));
        } else if (msg.type === 'ai_analysis_result') {
          setAiAnalysisMap((prev) => ({
            ...prev,
            [msg.incidentId]: {
              analysis: msg.analysis,
              rootCause: msg.suggestedRootCause,
              mitigations: msg.recommendedMitigations
            }
          }));
          setIsAnalyzing(false);
        }
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(connectWs, 3000);
    };

    ws.onerror = (err) => {
      console.error('WS Error:', err);
      ws.close();
    };
  }, []);

  useEffect(() => {
    connectWs();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.onerror = null;
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [connectWs]);

  useEffect(() => {
    fetch(`${API_URL}/api/incidents`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && Array.isArray(data.data)) {
          setIncidents(data.data);
          if (data.data.length > 0 && !selectedIncident) {
            setSelectedIncident(data.data[0]);
          }
        }
      })
      .catch((err) => console.warn('Could not fetch initial incidents:', err));
  }, []);

  const handleAcknowledge = (incidentId: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      const msg: WsClientMessage = {
        type: 'acknowledge_incident',
        incidentId,
        status: 'investigating'
      };
      socketRef.current.send(JSON.stringify(msg));
    }
    const target = incidents.find(i => i.id === incidentId);
    if (target && supabaseClient && authUser) {
      syncIncidentToSupabase(supabaseClient, authUser.id, { ...target, status: 'investigating' });
    }
  };

  const handleRequestAnalysis = (incidentId: string) => {
    setIsAnalyzing(true);
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      const msg: WsClientMessage = {
        type: 'request_ai_analysis',
        incidentId
      };
      socketRef.current.send(JSON.stringify(msg));
    } else {
      fetch(`${API_URL}/api/incidents/${incidentId}/analyze`, { method: 'POST' })
        .then((r) => r.json())
        .then((res) => {
          if (res.success) {
            setAiAnalysisMap((prev) => ({
              ...prev,
              [incidentId]: {
                analysis: res.data.analysis,
                rootCause: res.data.suggestedRootCause,
                mitigations: res.data.recommendedMitigations
              }
            }));
            const updated = incidents.find(i => i.id === incidentId);
            if (updated && supabaseClient && authUser) {
              syncIncidentToSupabase(supabaseClient, authUser.id, {
                ...updated,
                rootCauseAnalysis: res.data.suggestedRootCause,
              });
            }
          }
        })
        .finally(() => setIsAnalyzing(false));
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100 max-w-md mx-auto shadow-2xl border-x border-slate-900">
      {/* Mobile Header */}
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-slate-800 bg-slate-950/90 px-4 backdrop-blur">
        <div className="flex items-center space-x-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 font-bold text-xs text-white">
            A
          </div>
          <span className="font-semibold text-sm tracking-wide">APEX Mobile</span>
        </div>

        <div className="flex items-center space-x-1.5 rounded-full border border-slate-800 bg-slate-900 px-2.5 py-1 text-[11px]">
          <span
            className={`h-2 w-2 rounded-full ${
              wsStatus === 'connected'
                ? 'bg-emerald-400 animate-pulse'
                : wsStatus === 'connecting'
                ? 'bg-amber-400'
                : 'bg-rose-500'
            }`}
          />
          <span className="capitalize text-slate-400">{wsStatus}</span>
        </div>
      </header>

      {/* Supabase Google Auth Sync Bar */}
      <MobileSupabaseAuthBar
        onUserChange={handleUserChange}
        onVercelTokenSynced={handleVercelTokenSynced}
      />

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-900/40 px-3 pt-2">
        <button
          onClick={() => setActiveTab('incidents')}
          className={`flex-1 pb-2.5 text-xs font-medium border-b-2 transition ${
            activeTab === 'incidents'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-slate-400 hover:text-slate-300'
          }`}
        >
          Incidents ({incidents.length})
        </button>
        <button
          onClick={() => setActiveTab('diagnostics')}
          className={`flex-1 pb-2.5 text-xs font-medium border-b-2 transition ${
            activeTab === 'diagnostics'
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-slate-400 hover:text-slate-300'
          }`}
        >
          AI Diagnostics
        </button>
      </div>

      {/* Body View */}
      <main className="flex-1 overflow-y-auto p-4 space-y-3 pb-20">
        {activeTab === 'incidents' && (
          <>
            {incidents.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-500">
                All systems nominal. No open incidents.
              </div>
            ) : (
              incidents.map((incident) => {
                const severityBadge =
                  incident.severity === 'critical'
                    ? 'bg-rose-950/60 border-rose-800 text-rose-300'
                    : incident.severity === 'high'
                    ? 'bg-amber-950/60 border-amber-800 text-amber-300'
                    : 'bg-blue-950/60 border-blue-800 text-blue-300';

                return (
                  <div
                    key={incident.id}
                    className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 shadow-sm"
                  >
                    <div className="flex items-center justify-between">
                      <span className={`rounded-md border px-2 py-0.5 text-[10px] uppercase font-semibold ${severityBadge}`}>
                        {incident.severity}
                      </span>
                      <span className="text-[10px] text-slate-400 capitalize">
                        {incident.status}
                      </span>
                    </div>

                    <h2 className="mt-2 text-sm font-semibold text-slate-100">
                      {incident.title}
                    </h2>
                    <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                      {incident.description}
                    </p>

                    <div className="mt-3 flex items-center justify-between border-t border-slate-800/80 pt-3">
                      <span className="rounded bg-slate-800/80 px-2 py-0.5 text-[10px] text-slate-400 font-mono">
                        {incident.affectedService}
                      </span>

                      <div className="flex space-x-2">
                        {incident.status === 'detected' && (
                          <button
                            onClick={() => handleAcknowledge(incident.id)}
                            className="rounded bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 active:scale-95 transition"
                          >
                            Ack
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setSelectedIncident(incident);
                            setActiveTab('diagnostics');
                            handleRequestAnalysis(incident.id);
                          }}
                          className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white shadow-sm shadow-indigo-600/30 hover:bg-indigo-500 active:scale-95 transition"
                        >
                          Diagnose
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}

        {activeTab === 'diagnostics' && (
          <div className="space-y-4">
            {selectedIncident ? (
              <>
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500">Selected Incident</div>
                  <h3 className="mt-1 text-sm font-semibold text-slate-200">{selectedIncident.title}</h3>
                  <p className="mt-0.5 text-xs text-slate-400">{selectedIncident.affectedService}</p>
                </div>

                <div className="rounded-xl border border-indigo-900/40 bg-indigo-950/20 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase text-indigo-400">NOVA Root-Cause</span>
                    <button
                      disabled={isAnalyzing}
                      onClick={() => handleRequestAnalysis(selectedIncident.id)}
                      className="text-xs text-indigo-400 underline disabled:opacity-50"
                    >
                      {isAnalyzing ? 'Analyzing...' : 'Re-run'}
                    </button>
                  </div>

                  {aiAnalysisMap[selectedIncident.id] ? (
                    <div className="mt-3 space-y-3 text-xs">
                      <div>
                        <span className="font-semibold text-slate-300">Summary: </span>
                        <p className="mt-0.5 text-slate-300">{aiAnalysisMap[selectedIncident.id].analysis}</p>
                      </div>

                      <div className="rounded-lg bg-slate-900/90 p-3 border border-slate-800">
                        <span className="font-semibold text-indigo-300">Probable Root Cause: </span>
                        <p className="mt-1 text-slate-200">{aiAnalysisMap[selectedIncident.id].rootCause}</p>
                      </div>

                      <div>
                        <span className="font-semibold text-slate-300">Recommended Steps:</span>
                        <ul className="mt-1 list-disc list-inside space-y-1 text-slate-300">
                          {aiAnalysisMap[selectedIncident.id].mitigations.map((step, idx) => (
                            <li key={idx}>{step}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : (
                    <div className="py-6 text-center text-xs text-slate-400">
                      Tap 'Diagnose' on an incident to invoke Gemini reasoning.
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="py-12 text-center text-xs text-slate-500">
                Please select an incident first.
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
