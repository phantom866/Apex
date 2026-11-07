import { Router, Request, Response } from 'express';
import { ApexWebSocketManager } from '../websocket';
import { diagnoseProjectLogs } from '../gemini';

// Runtime in-memory token cache (persists for the server process duration)
let runtimeVercelToken: string | null = process.env.VERCEL_TOKEN || null;
let runtimeVercelTeamId: string | null = process.env.VERCEL_TEAM_ID || null;

export function getVercelToken(req?: Request): string | null {
  const headerToken = req?.headers['x-vercel-token'] as string | undefined;
  const queryToken = req?.query?.token as string | undefined;
  return headerToken || queryToken || runtimeVercelToken || process.env.VERCEL_TOKEN || null;
}

export function getVercelTeamId(req?: Request): string | null {
  const headerTeam = req?.headers['x-vercel-team-id'] as string | undefined;
  const queryTeam = req?.query?.teamId as string | undefined;
  return headerTeam || queryTeam || runtimeVercelTeamId || process.env.VERCEL_TEAM_ID || null;
}

interface VercelApiOptions {
  token: string;
  teamId?: string | null;
  method?: string;
  body?: unknown;
}

async function vercelFetch<T>(path: string, options: VercelApiOptions): Promise<T> {
  const url = new URL(`https://api.vercel.com${path}`);
  if (options.teamId) {
    url.searchParams.set('teamId', options.teamId);
  }

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'APEX-Operations-Platform/0.1.0'
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    let parsedMessage = errorBody;
    try {
      const parsed = JSON.parse(errorBody);
      parsedMessage = parsed.error?.message || parsed.message || errorBody;
    } catch {
      // Keep errorBody
    }
    throw new Error(`Vercel API error (${response.status}): ${parsedMessage || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export interface VercelProjectSummary {
  id: string;
  name: string;
  framework: string | null;
  updatedAt: number;
  createdAt: number;
  productionUrl?: string;
  latestDeployments?: Array<{
    id: string;
    url: string;
    readyState: string;
    createdAt: number;
    meta?: Record<string, string>;
  }>;
}

export interface VercelDeploymentEvent {
  id?: string;
  serial?: string;
  created?: number;
  date?: number;
  type?: string;
  payload?: any;
  text?: string;
}

/** Formats a single Vercel deployment event into a standardized log line for APEX parser */
export function formatVercelEventToLogLine(event: VercelDeploymentEvent, projectName: string): string {
  const rawTs = event.created || event.date || (event.payload && event.payload.date) || Date.now();
  const isoTime = new Date(rawTs).toISOString();

  let level = 'INFO';
  let message = '';

  const payload = event.payload;

  if (typeof payload === 'string') {
    message = payload;
  } else if (payload && typeof payload === 'object') {
    // Detect level
    if (typeof payload.level === 'string') {
      const lvl = payload.level.toLowerCase();
      if (lvl === 'error' || lvl === 'fatal' || lvl === 'err') level = 'ERROR';
      else if (lvl === 'warn' || lvl === 'warning') level = 'WARN';
      else if (lvl === 'debug') level = 'DEBUG';
      else level = 'INFO';
    } else if (typeof payload.statusCode === 'number') {
      if (payload.statusCode >= 500) level = 'ERROR';
      else if (payload.statusCode >= 400) level = 'WARN';
    }

    if (payload.text && typeof payload.text === 'string') {
      message = payload.text;
    } else if (payload.message && typeof payload.message === 'string') {
      message = payload.message;
    } else if (payload.info && typeof payload.info === 'object') {
      const info = payload.info;
      const path = info.path || '';
      const method = info.method || 'REQUEST';
      const status = payload.statusCode || '';
      message = `${method} ${path} ${status ? `-> ${status}` : ''}`.trim();
    } else {
      message = JSON.stringify(payload);
    }
  } else if (typeof event.text === 'string') {
    message = event.text;
  } else {
    message = JSON.stringify(event);
  }

  // Remove trailing newlines from inside message
  message = message.trim().replace(/\r?\n/g, ' ');

  // Auto-upgrade level if explicit error keywords exist in message
  if (level === 'INFO') {
    if (
      /error|fatal|exception|timed out|504|500|econnrefused|econnreset|failed/i.test(message) &&
      !/0 errors|no error/i.test(message)
    ) {
      level = 'ERROR';
    } else if (/warn|warning|deprecated/i.test(message)) {
      level = 'WARN';
    }
  }

  return `${isoTime} [${level}] [${projectName}] ${message}`;
}

export function createVercelRouter(_wsManager: ApexWebSocketManager): Router {
  const router = Router();

  /**
   * GET /api/vercel/status
   * Checks whether a Vercel token is configured and validates it with Vercel /v2/user.
   */
  router.get('/status', async (req: Request, res: Response): Promise<void> => {
    const token = getVercelToken(req);
    const teamId = getVercelTeamId(req);

    if (!token) {
      res.json({
        configured: false,
        valid: false,
        user: null,
        message: 'No Vercel token configured. Provide one in .env or via the APEX Vercel panel.'
      });
      return;
    }

    try {
      const user = await vercelFetch<{ user: { id: string; username: string; email: string; name: string; avatar?: string } }>(
        '/v2/user',
        { token, teamId }
      );

      res.json({
        configured: true,
        valid: true,
        user: user.user,
        teamId: teamId || null
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(200).json({
        configured: true,
        valid: false,
        user: null,
        error: msg
      });
    }
  });

  /**
   * POST /api/vercel/token
   * Validates and sets the token in runtime memory.
   */
  router.post('/token', async (req: Request, res: Response): Promise<void> => {
    const { token, teamId } = req.body as { token?: string; teamId?: string };

    if (!token || typeof token !== 'string') {
      res.status(400).json({ success: false, error: 'A valid Vercel API token is required.' });
      return;
    }

    try {
      const user = await vercelFetch<{ user: { id: string; username: string; email: string; name: string; avatar?: string } }>(
        '/v2/user',
        { token, teamId: teamId || null }
      );

      runtimeVercelToken = token.trim();
      runtimeVercelTeamId = teamId ? teamId.trim() : null;

      res.json({
        success: true,
        user: user.user,
        message: `Successfully connected to Vercel account: ${user.user.username || user.user.email}`
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(401).json({
        success: false,
        error: `Failed to authenticate token with Vercel: ${msg}`
      });
    }
  });

  /**
   * DELETE /api/vercel/token
   * Clears the runtime token.
   */
  router.delete('/token', (_req: Request, res: Response): void => {
    runtimeVercelToken = null;
    runtimeVercelTeamId = null;
    res.json({ success: true, message: 'Vercel connection cleared.' });
  });

  /**
   * GET /api/vercel/projects
   * Returns all projects for the authenticated Vercel user/team.
   */
  router.get('/projects', async (req: Request, res: Response): Promise<void> => {
    const token = getVercelToken(req);
    const teamId = getVercelTeamId(req);

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Vercel API token not configured. Please connect your Vercel account.'
      });
      return;
    }

    try {
      const data = await vercelFetch<{ projects: any[] }>('/v9/projects?limit=100', { token, teamId });
      const projects: VercelProjectSummary[] = (data.projects || []).map((p) => {
        const prodDeployment = p.targets?.production || (p.latestDeployments && p.latestDeployments[0]);
        return {
          id: p.id,
          name: p.name,
          framework: p.framework || null,
          updatedAt: p.updatedAt,
          createdAt: p.createdAt,
          productionUrl: prodDeployment?.url ? `https://${prodDeployment.url}` : undefined,
          latestDeployments: (p.latestDeployments || []).slice(0, 3).map((d: any) => ({
            id: d.id,
            url: d.url ? `https://${d.url}` : '',
            readyState: d.readyState || 'READY',
            createdAt: d.createdAt,
            meta: d.meta
          }))
        };
      });

      console.log(`[${new Date().toLocaleTimeString()}] [Vercel API] Retrieved ${projects.length} projects for user`);

      res.json({
        success: true,
        count: projects.length,
        projects
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * GET /api/vercel/projects/:projectId/deployments
   * Fetches recent deployments for a specific project.
   */
  router.get('/projects/:projectId/deployments', async (req: Request, res: Response): Promise<void> => {
    const token = getVercelToken(req);
    const teamId = getVercelTeamId(req);
    const rawProjectId = req.params.projectId;
    const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;

    if (!token) {
      res.status(401).json({ success: false, error: 'Vercel token not configured.' });
      return;
    }

    try {
      const data = await vercelFetch<{ deployments: any[] }>(
        `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=10`,
        { token, teamId }
      );

      const deployments = (data.deployments || []).map((d) => ({
        id: d.uid || d.id,
        name: d.name,
        url: d.url ? `https://${d.url}` : '',
        readyState: d.readyState || d.state || 'READY',
        createdAt: d.created || d.createdAt,
        type: d.type,
        target: d.target || (d.meta?.githubCommitRef === 'main' ? 'production' : 'preview'),
        meta: {
          commitMessage: d.meta?.githubCommitMessage || d.meta?.commitMessage || '',
          commitRef: d.meta?.githubCommitRef || d.meta?.branch || '',
          commitAuthor: d.meta?.githubCommitAuthorName || ''
        }
      }));

      res.json({ success: true, count: deployments.length, deployments });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * GET /api/vercel/projects/:projectId/logs
   * Fetches real logs from Vercel for the latest or specified deployment.
   */
  router.get('/projects/:projectId/logs', async (req: Request, res: Response): Promise<void> => {
    const token = getVercelToken(req);
    const teamId = getVercelTeamId(req);
    const rawProjectId = req.params.projectId;
    const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
    let deploymentId = req.query.deploymentId as string | undefined;
    const limit = Math.min(parseInt((req.query.limit as string) || '100', 10), 250);

    if (!token) {
      res.status(401).json({ success: false, error: 'Vercel token not configured.' });
      return;
    }

    try {
      // 1. Fetch project info to get project name and default deployment
      const project = await vercelFetch<any>(`/v9/projects/${encodeURIComponent(projectId)}`, { token, teamId });
      const projectName = project.name || projectId;

      // 2. Resolve deploymentId if not explicitly provided
      if (!deploymentId) {
        const prod = project.targets?.production;
        if (prod && prod.id) {
          deploymentId = prod.id;
        } else if (project.latestDeployments && project.latestDeployments.length > 0) {
          deploymentId = project.latestDeployments[0].id;
        } else {
          // Query deployments list
          const deps = await vercelFetch<{ deployments: any[] }>(
            `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`,
            { token, teamId }
          );
          if (deps.deployments && deps.deployments.length > 0) {
            deploymentId = deps.deployments[0].uid || deps.deployments[0].id;
          }
        }
      }

      if (!deploymentId) {
        res.json({
          success: true,
          projectName,
          projectId,
          deploymentId: null,
          rawLogs: '',
          linesCount: 0,
          errorCount: 0,
          warnCount: 0,
          message: 'No deployments found for this project yet.'
        });
        return;
      }

      // 3. Fetch deployment metadata
      let deploymentMeta: any = null;
      try {
        deploymentMeta = await vercelFetch<any>(`/v13/deployments/${deploymentId}`, { token, teamId });
      } catch {
        // Fallback to basic info if v13 deployment endpoint fails
      }

      // 4. Fetch deployment events / runtime logs
      let rawEvents: VercelDeploymentEvent[] = [];
      try {
        // First try v3 events endpoint
        rawEvents = await vercelFetch<VercelDeploymentEvent[]>(
          `/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
          { token, teamId }
        );
      } catch {
        // Fallback to v2 events endpoint
        try {
          const v2Data = await vercelFetch<{ events?: VercelDeploymentEvent[] } | VercelDeploymentEvent[]>(
            `/v2/deployments/${encodeURIComponent(deploymentId)}/events?direction=backward&limit=${limit}`,
            { token, teamId }
          );
          rawEvents = Array.isArray(v2Data) ? v2Data : (v2Data.events || []);
        } catch (eventErr: unknown) {
          console.warn('[Vercel Logs] Could not fetch deployment events:', eventErr);
        }
      }

      if (!Array.isArray(rawEvents)) {
        rawEvents = [];
      }

      // Sort events chronologically ascending
      rawEvents.sort((a, b) => {
        const tA = a.created || a.date || 0;
        const tB = b.created || b.date || 0;
        return tA - tB;
      });

      // Format events into log lines
      const formattedLines: string[] = [];
      let errorCount = 0;
      let warnCount = 0;

      for (const ev of rawEvents) {
        const line = formatVercelEventToLogLine(ev, projectName);
        formattedLines.push(line);
        if (/\[ERROR\]/i.test(line)) errorCount++;
        else if (/\[WARN\]/i.test(line)) warnCount++;
      }

      const rawLogs = formattedLines.join('\n');

      console.log(`[${new Date().toLocaleTimeString()}] [Vercel API] Fetched ${formattedLines.length} logs for '${projectName}' (errors: ${errorCount}, warns: ${warnCount})`);

      res.json({
        success: true,
        projectName,
        projectId,
        deploymentId,
        deployment: {
          url: deploymentMeta?.url ? `https://${deploymentMeta.url}` : undefined,
          readyState: deploymentMeta?.readyState || 'READY',
          createdAt: deploymentMeta?.createdAt,
          commitMessage: deploymentMeta?.meta?.githubCommitMessage || deploymentMeta?.meta?.commitMessage || ''
        },
        rawLogs,
        linesCount: formattedLines.length,
        errorCount,
        warnCount,
        message: formattedLines.length === 0 ? 'No runtime event logs recorded for this deployment yet.' : undefined
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * POST /api/vercel/projects/:projectId/diagnosis
   * Fetches the recent project logs, extracts errors, and produces a structured diagnosis.
   */
  router.post('/projects/:projectId/diagnosis', async (req: Request, res: Response): Promise<void> => {
    const token = getVercelToken(req);
    const teamId = getVercelTeamId(req);
    const rawProjectId = req.params.projectId;
    const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
    const limit = Math.min(parseInt((req.body?.limit as string) || '150', 10), 250);

    if (!token) {
      res.status(401).json({ success: false, error: 'Vercel token not configured.' });
      return;
    }

    try {
      const project = await vercelFetch<any>(`/v9/projects/${encodeURIComponent(projectId)}`, { token, teamId });
      const projectName = project.name || projectId;
      let deploymentId = project.targets?.production?.id || project.latestDeployments?.[0]?.id;
      if (!deploymentId) {
        const deployments = await vercelFetch<{ deployments: any[] }>(
          `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1`,
          { token, teamId },
        );
        deploymentId = deployments.deployments?.[0]?.uid || deployments.deployments?.[0]?.id;
      }

      let rawEvents: VercelDeploymentEvent[] = [];
      if (deploymentId) {
        try {
          rawEvents = await vercelFetch<VercelDeploymentEvent[]>(
            `/v3/deployments/${encodeURIComponent(deploymentId)}/events`,
            { token, teamId },
          );
        } catch {
          const fallback = await vercelFetch<{ events?: VercelDeploymentEvent[] } | VercelDeploymentEvent[]>(
            `/v2/deployments/${encodeURIComponent(deploymentId)}/events?direction=backward&limit=${limit}`,
            { token, teamId },
          );
          rawEvents = Array.isArray(fallback) ? fallback : (fallback.events || []);
        }
      }

      rawEvents.sort((a, b) => (b.created || b.date || 0) - (a.created || a.date || 0));
      const rawLogs = rawEvents
        .slice(0, limit)
        .reverse()
        .map((event) => formatVercelEventToLogLine(event, projectName))
        .join('\n');
      const recentErrors = rawLogs
        .split('\n')
        .filter((line) => /\[ERROR\]|\[FATAL\]/i.test(line))
        .slice(-30)
        .map((line) => {
          const timestamp = line.match(/^\d{4}-\d{2}-\d{2}T[^ ]+/)?.[0] || new Date().toISOString();
          const level = line.match(/\[(ERROR|FATAL)\]/i)?.[1]?.toLowerCase() || 'error';
          return { timestamp, level, message: line.replace(/^\S+\s+\[(?:ERROR|FATAL)\]\s+\[[^\]]+\]\s*/, '') };
        });

      const diagnosis = await diagnoseProjectLogs(projectId, projectName, rawLogs, recentErrors);
      res.json({ success: true, data: diagnosis });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * GET /api/vercel/projects/:projectId/sample-logs
   * Generates a realistic simulated production outage log for the chosen project,
   * enabling full verification of APEX Agent analysis without breaking real production.
   */
  router.get('/projects/:projectId/sample-logs', (req: Request, res: Response): void => {
    const rawProjectId = req.params.projectId;
    const projectId = Array.isArray(rawProjectId) ? rawProjectId[0] : rawProjectId;
    const projectName = (req.query.projectName as string) || projectId;
    const now = new Date();

    const t = (offsetSec: number) => new Date(now.getTime() - (60 - offsetSec) * 1000).toISOString();

    const simulatedLogs = [
      `${t(0)} [INFO] [${projectName}] Serverless function runtime cold-start initiated in iad1 region`,
      `${t(5)} [INFO] [${projectName}] GET /api/v1/checkout - incoming request from edge proxy`,
      `${t(12)} [WARN] [${projectName}] PrismaClient: connection attempt took 2450ms (warning threshold 1000ms)`,
      `${t(18)} [ERROR] [${projectName}] PrismaClientInitializationError: Can't reach database server at 'postgres-primary.internal:5432'`,
      `${t(24)} [ERROR] [${projectName}] connection pool exhausted — 100/100 pooled connections active`,
      `${t(31)} [ERROR] [${projectName}] Task timed out after 10.01 seconds (FUNCTION_INVOCATION_TIMEOUT)`,
      `${t(33)} [ERROR] [${projectName}] 504 Gateway Timeout: Edge router aborted upstream serverless invocation`,
      `${t(40)} [ERROR] [${projectName}] UnhandledPromiseRejection: Database connection lost during transaction commit`,
      `${t(45)} [ERROR] [${projectName}] 500 Internal Server Error returned to client for /api/v1/checkout`,
    ].join('\n');

    res.json({
      success: true,
      projectName,
      isSimulated: true,
      rawLogs: simulatedLogs
    });
  });

  return router;
}
