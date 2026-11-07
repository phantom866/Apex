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

