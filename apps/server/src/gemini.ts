import { GoogleGenAI } from '@google/genai';
import { Incident } from '@apex/shared';

let aiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return null;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

export interface AiIncidentDiagnosis {
  incidentId: string;
  analysis: string;
  suggestedRootCause: string;
  recommendedMitigations: string[];
  poweredByGemini: boolean;
}

export type ProjectDangerLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ProjectDiagnosis {
  projectId: string;
  projectName: string;
  generatedAt: string;
  dangerLevel: ProjectDangerLevel;
  summary: string;
  recentErrors: Array<{ timestamp: string; level: string; message: string }>;
  probableRootCause: string;
  recommendedActions: string[];
  analyzedLogCount: number;
  poweredByGemini: boolean;
}

export async function diagnoseProjectLogs(
  projectId: string,
  projectName: string,
  logs: string,
  recentErrors: Array<{ timestamp: string; level: string; message: string }>,
): Promise<ProjectDiagnosis> {
  const generatedAt = new Date().toISOString();
  const base = {
    projectId,
    projectName,
    generatedAt,
    recentErrors,
    analyzedLogCount: logs.split('\n').filter(Boolean).length,
  };

  if (recentErrors.length === 0) {
    return {
      ...base,
      dangerLevel: 'low',
      summary: 'No recent error-level log entries were found for this project.',
      probableRootCause: 'No evidence of a recent application failure in the fetched logs.',
      recommendedActions: ['Continue monitoring the project logs', 'Review deployment health if traffic or errors increase'],
      poweredByGemini: false,
    };
  }

  const ai = getGeminiClient();
  if (!ai) {
    const dangerLevel: ProjectDangerLevel = recentErrors.some((e) => /fatal|critical|5\d\d|outage/i.test(e.message))
      ? 'critical'
      : recentErrors.length >= 5 ? 'high' : 'medium';
    return {
      ...base,
      dangerLevel,
      summary: `${recentErrors.length} recent error log entr${recentErrors.length === 1 ? 'y' : 'ies'} require attention.`,
      probableRootCause: 'The available error logs indicate an application or deployment failure; Gemini analysis is unavailable.',
      recommendedActions: ['Inspect the latest deployment and its environment variables', 'Trace the first error in the recent log window', 'Configure GEMINI_API_KEY for AI-assisted diagnosis'],
      poweredByGemini: false,
    };
  }

  try {
    const prompt = `You are NOVA, diagnosing the Vercel project "${projectName}" (${projectId}).
Analyze only the recent error logs below. Return ONLY valid JSON matching this exact schema:
{
  "dangerLevel": "low" | "medium" | "high" | "critical",
  "summary": "concise incident summary",
  "probableRootCause": "most likely root cause",
  "recommendedActions": ["specific action 1", "specific action 2", "specific action 3"]
}
Recent errors:
${JSON.stringify(recentErrors)}
Full recent log window for context:
${logs.slice(-30000)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            dangerLevel: { type: 'STRING', enum: ['low', 'medium', 'high', 'critical'] },
            summary: { type: 'STRING' },
            probableRootCause: { type: 'STRING' },
            recommendedActions: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['dangerLevel', 'summary', 'probableRootCause', 'recommendedActions'],
        },
      },
    });
    const parsed = JSON.parse((response.text || '').trim()) as {
      dangerLevel?: ProjectDangerLevel;
      summary?: string;
      probableRootCause?: string;
      recommendedActions?: string[];
    };
    if (!parsed.dangerLevel || !parsed.summary || !parsed.probableRootCause || !Array.isArray(parsed.recommendedActions)) {
      throw new Error('Gemini returned an incomplete project diagnosis');
    }
    return {
      ...base,
      dangerLevel: parsed.dangerLevel,
      summary: parsed.summary,
      probableRootCause: parsed.probableRootCause,
      recommendedActions: parsed.recommendedActions,
      poweredByGemini: true,
    };
  } catch (err: unknown) {
    console.error('[Gemini] Project diagnosis failed:', err instanceof Error ? err.message : String(err));
    return {
      ...base,
      dangerLevel: 'high',
      summary: 'Recent errors were found, but the AI diagnosis could not be completed.',
      probableRootCause: 'Review the recent errors directly; Gemini returned an invalid or unavailable diagnosis.',
      recommendedActions: ['Inspect the latest deployment logs', 'Review the first error and its surrounding requests', 'Retry diagnosis after Gemini is available'],
      poweredByGemini: false,
    };
  }
}

export async function analyzeIncident(incident: Incident): Promise<AiIncidentDiagnosis> {
  const ai = getGeminiClient();

  if (!ai) {
    return {
      incidentId: incident.id,
      analysis: `Rule-based analysis: Incident '${incident.title}' breached thresholds on service '${incident.affectedService}'.`,
      suggestedRootCause: `High load or resource pressure detected on service '${incident.affectedService}'. Note: Set GEMINI_API_KEY in server environment to enable advanced Gemini AI root-cause reasoning.`,
      recommendedMitigations: [
        `Check current CPU, memory, and error telemetry for ${incident.affectedService}`,
        'Scale worker replicas if queue depth or request rate is elevated',
        'Verify database connection pool saturation'
      ],
      poweredByGemini: false
    };
  }

  try {
    const prompt = `You are NOVA, the Autonomous Platform for Engineering eXcellence (APEX) incident investigator.
Analyze the following IT incident and return a concise, actionable diagnosis:
- Incident ID: ${incident.id}
- Title: ${incident.title}
- Service: ${incident.affectedService}
- Category: ${incident.category}
- Severity: ${incident.severity}
- Description: ${incident.description}
- Metadata: ${JSON.stringify(incident.metadata || {})}

Provide your response in JSON format with exactly these fields:
{
  "analysis": "summary of the situation",
  "suggestedRootCause": "most probable root cause based on symptoms",
  "recommendedMitigations": ["action step 1", "action step 2", "action step 3"]
}
Return only valid JSON.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: prompt
    });

    const text = response.text || '';
    // Try to parse json from model output
    const cleanText = text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleanText);

    return {
      incidentId: incident.id,
      analysis: parsed.analysis || `Gemini analyzed incident on ${incident.affectedService}.`,
      suggestedRootCause: parsed.suggestedRootCause || 'Unspecified anomaly',
      recommendedMitigations: Array.isArray(parsed.recommendedMitigations)
        ? parsed.recommendedMitigations
        : ['Verify service logs', 'Restart affected pods if unhealthy'],
      poweredByGemini: true
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error('[Gemini] Analysis failed, falling back to heuristic diagnosis:', errorMsg);
    return {
      incidentId: incident.id,
      analysis: `Fallback heuristic diagnosis: Incident '${incident.title}' on '${incident.affectedService}' requires attention.`,
      suggestedRootCause: `Potential resource exhaustion or upstream network degradation. (Gemini error: ${errorMsg})`,
      recommendedMitigations: [
        'Review recent deployment commits and logs',
        'Check service health endpoints',
        'Ensure environment variables and credentials are valid'
      ],
      poweredByGemini: false
    };
  }
}
