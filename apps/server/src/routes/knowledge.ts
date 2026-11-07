/**
 * Knowledge Base Routes — README → Qdrant Vector Upload
 *
 * POST /api/knowledge/upload
 *   Accepts a README (markdown) document, chunks it by headings/paragraphs,
 *   generates embeddings via Gemini, and upserts them into Qdrant.
 *   Each point is stored with a payload that includes userId and projectId
 *   so results are scoped per user and per project.
 *
 * GET /api/knowledge/documents
 *   Lists uploaded document metadata for a given userId (query param).
 *
 * DELETE /api/knowledge/documents/:documentId
 *   Removes all Qdrant points and metadata for a document.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import { GoogleGenAI } from '@google/genai';
import { UploadReadmePayloadSchema, KnowledgeDocument, KnowledgeChunk } from '@apex/shared';

// ---------------------------------------------------------------------------
// Qdrant & Gemini setup
// ---------------------------------------------------------------------------

const VECTOR_SIZE = 3072; // gemini-embedding-001 output dimension

/**
 * Derive a valid Qdrant collection name from the Vercel project name.
 * Qdrant collection names must match: [a-zA-Z0-9_-]
 * Strategy: lowercase, replace spaces/dots/slashes with _, strip everything else.
 */
function projectToCollectionName(projectName: string): string {
  return projectName
    .toLowerCase()
    .trim()
    .replace(/[\s./\\]+/g, '_')   // spaces, dots, slashes → underscore
    .replace(/[^a-z0-9_-]/g, '')  // strip anything else
    .replace(/^_+|_+$/g, '')      // trim leading/trailing underscores
    .substring(0, 63)             // Qdrant max collection name length
    || 'apex_project';            // fallback if name is empty after sanitisation
}

function getQdrantClient(): QdrantClient | null {
  // Read lazily so dotenv has already populated process.env by the time
  // the first request arrives (module-level constants capture values too early)
  const url = process.env.QDRANT_CLUSTER_ENDPOINT || '';
  const key = process.env.QDRANT_API_KEY || '';
  if (!url || !key) {
    console.warn('[Knowledge] QDRANT_CLUSTER_ENDPOINT or QDRANT_API_KEY not set.');
    return null;
  }
  return new QdrantClient({ url, apiKey: key, checkCompatibility: false });
}

let _geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') return null;
  if (!_geminiClient) _geminiClient = new GoogleGenAI({ apiKey: key });
  return _geminiClient;
}

// ---------------------------------------------------------------------------
// In-memory document metadata store (keyed by documentId)
// ---------------------------------------------------------------------------

const docStore = new Map<string, KnowledgeDocument>();

// ---------------------------------------------------------------------------
// Markdown chunking
// ---------------------------------------------------------------------------

const MAX_CHUNK_CHARS = 1500; // ~375 tokens at 4 chars/token
const MIN_CHUNK_CHARS = 80;

interface RawChunk {
  heading: string;
  text: string;
}

/**
 * Split a markdown document into chunks.
 *
 * Strategy:
 * 1. Split on heading lines (# ## ###). Each heading starts a new section.
 * 2. If a section is longer than MAX_CHUNK_CHARS, further split by blank lines
 *    (paragraphs).
 * 3. Discard chunks shorter than MIN_CHUNK_CHARS (usually empty sections).
 */
function chunkMarkdown(content: string): RawChunk[] {
  const lines = content.split('\n');
  const sections: { heading: string; lines: string[] }[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      if (currentLines.join('\n').trim().length >= MIN_CHUNK_CHARS) {
        sections.push({ heading: currentHeading, lines: currentLines });
      }
      currentHeading = line.replace(/^#+\s+/, '').trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  // flush last section
  if (currentLines.join('\n').trim().length >= MIN_CHUNK_CHARS) {
    sections.push({ heading: currentHeading, lines: currentLines });
  }

  // If the document has no headings at all, treat whole thing as one section
  if (sections.length === 0) {
    sections.push({ heading: '', lines: lines });
  }

  const chunks: RawChunk[] = [];

  for (const section of sections) {
    const sectionText = section.lines.join('\n').trim();
    if (!sectionText) continue;

    if (sectionText.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        heading: section.heading,
        text: section.heading ? `## ${section.heading}\n\n${sectionText}` : sectionText,
      });
      continue;
    }

    // Split large sections by blank lines (paragraphs)
    const paragraphs = sectionText.split(/\n{2,}/);
    let buffer = section.heading ? `## ${section.heading}\n\n` : '';

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      if (buffer.length + trimmed.length > MAX_CHUNK_CHARS && buffer.trim().length >= MIN_CHUNK_CHARS) {
        chunks.push({ heading: section.heading, text: buffer.trim() });
        buffer = section.heading ? `## ${section.heading} (cont.)\n\n` : '';
      }
      buffer += trimmed + '\n\n';
    }
    if (buffer.trim().length >= MIN_CHUNK_CHARS) {
      chunks.push({ heading: section.heading, text: buffer.trim() });
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Embedding via Gemini
// ---------------------------------------------------------------------------

async function embedTexts(texts: string[]): Promise<number[][]> {
  const ai = getGemini();
  if (!ai) throw new Error('Gemini API key not configured — cannot generate embeddings.');

  const vectors: number[][] = [];

  // Gemini supports batched embedding but the SDK's embedContent is per-text;
  // run sequentially to stay within rate limits for most token counts.
  for (const text of texts) {
    const result = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text,
      config: { taskType: 'RETRIEVAL_DOCUMENT' },
    });

    const values = result.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      throw new Error('Gemini returned an empty embedding vector.');
    }

    vectors.push(values);
  }

  return vectors;
}

// ---------------------------------------------------------------------------
// Qdrant collection bootstrap
// ---------------------------------------------------------------------------

async function ensureCollection(client: QdrantClient, collectionName: string): Promise<void> {
  try {
    await client.getCollection(collectionName);
  } catch (_err: unknown) {
    // Collection doesn't exist — create it
    await client.createCollection(collectionName, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    });
    console.log(`[Knowledge] Created Qdrant collection '${collectionName}'`);
  }

  // Qdrant requires payload indexes for filtered reads. Run this for existing
  // collections too so collections created before project-scoped chat continue
  // to work without manual migration.
  for (const fieldName of ['userId', 'projectId']) {
    await client.createPayloadIndex(collectionName, {
      field_name: fieldName,
      field_schema: 'keyword',
      wait: true,
    });
  }
}

// ---------------------------------------------------------------------------
// UUID helper (simple crypto-based v4)
// ---------------------------------------------------------------------------

function uuid4(): string {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex').replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/,
    '$1-$2-$3-$4-$5'
  );
}

// ---------------------------------------------------------------------------
// SHA-256 hash helper
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createKnowledgeRouter(): Router {
  const router = Router();

  /**
   * POST /api/knowledge/upload
   * Body: { content, projectId, projectName, filename?, userId, userEmail? }
   */
  router.post('/upload', async (req: Request, res: Response): Promise<void> => {
    // 1. Validate payload
    const parse = UploadReadmePayloadSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        success: false,
        error: parse.error.errors.map((e) => e.message).join('; '),
      });

      return;
    }

    const { content, projectId, projectName, filename, userId, userEmail } = parse.data;
    const contentHash = sha256(content);
    const documentId = uuid4();

    // Check for duplicate (same user + project + file hash)
    for (const doc of docStore.values()) {
      if (
        doc.userId === userId &&
        doc.projectId === projectId &&
        doc.contentHash === contentHash &&
        doc.status === 'embedded'
      ) {
        res.json({
          success: true,
          documentId: doc.id,
          chunkCount: doc.chunkCount,
          collectionName: projectToCollectionName(doc.projectName),
          message: 'Document already indexed (content unchanged).',
          duplicate: true,
        });
        return;
      }
    }

    // 2. Chunk the markdown
    const rawChunks = chunkMarkdown(content);
    if (rawChunks.length === 0) {
      res.status(422).json({ success: false, error: 'No text content could be extracted from the document.' });
      return;
    }

    // 3. Build KnowledgeChunk objects
    const chunks: KnowledgeChunk[] = rawChunks.map((rc, idx) => ({
      id: uuid4(),
      documentId,
      chunkIndex: idx,
      text: rc.text,
      heading: rc.heading || undefined,
      tokenEstimate: Math.ceil(rc.text.length / 4),
    }));

    // 4. Register document as pending
    const nowIso = new Date().toISOString();
    const doc: KnowledgeDocument = {
      id: documentId,
      userId,
      userEmail: userEmail || undefined,
      projectId,
      projectName,
      filename: filename || 'README.md',
      contentHash,
      chunkCount: chunks.length,
      uploadedAt: nowIso,
      status: 'pending',
    };
    docStore.set(documentId, doc);

    const tag = `[Knowledge] doc=${documentId.slice(0, 8)} user=${userId.slice(0, 8)} project='${projectName}'`;

    // Derive Qdrant collection name from the Vercel project name
    const collectionName = projectToCollectionName(projectName);
    console.log(`${tag} Collection name: '${collectionName}'`);

    try {
      // 5. Connect to Qdrant and ensure collection
      const qdrant = getQdrantClient();
      if (!qdrant) throw new Error('Qdrant is not configured (missing QDRANT_CLUSTER_ENDPOINT or QDRANT_API_KEY).');

      await ensureCollection(qdrant, collectionName);

      // 6. Generate embeddings (batched 10 at a time to respect rate limits)
      console.log(`${tag} Embedding ${chunks.length} chunks via Gemini gemini-embedding-001...`);
      const allTexts = chunks.map((c) => c.text);
      const allVectors: number[][] = [];
      const BATCH = 10;

      for (let i = 0; i < allTexts.length; i += BATCH) {
        const batch = allTexts.slice(i, i + BATCH);
        const vecs = await embedTexts(batch);
        allVectors.push(...vecs);
      }

      // 7. Build Qdrant points
      const points = chunks.map((chunk, idx) => ({
        id: chunk.id,
        vector: allVectors[idx],
        payload: {
          documentId: chunk.documentId,
          chunkIndex: chunk.chunkIndex,
          heading: chunk.heading ?? '',
          text: chunk.text,
          userId,
          userEmail: userEmail ?? '',
          projectId,
          projectName,
          filename: filename || 'README.md',
          uploadedAt: nowIso,
        },
      }));

      // 8. Upsert into Qdrant
      await qdrant.upsert(collectionName, { wait: true, points });
      console.log(`${tag} Upserted ${points.length} points to Qdrant collection '${collectionName}'.`);

      // 9. Update document status — store collectionName for later deletion
      doc.status = 'embedded';
      (doc as any).collectionName = collectionName;
      docStore.set(documentId, doc);

      res.json({
        success: true,
        documentId,
        chunkCount: chunks.length,
        collectionName,
        message: `Successfully indexed ${chunks.length} chunks from '${filename}' into the knowledge base (collection: '${collectionName}').`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag} Upload failed:`, msg);

      // Mark document as failed
      doc.status = 'failed';
      doc.errorMessage = msg;
      docStore.set(documentId, doc);

      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * POST /api/knowledge/chat
   * Answers a project question using only the authenticated user's project README.
   */
  router.post('/chat', async (req: Request, res: Response): Promise<void> => {
    const { userId, projectId, projectName, message } = req.body as {
      userId?: string;
      projectId?: string;
      projectName?: string;
      message?: string;
    };
    if (!userId || !projectId || !projectName || !message?.trim()) {
      res.status(400).json({ success: false, error: 'userId, projectId, projectName, and message are required.' });
      return;
    }

    try {
      const qdrant = getQdrantClient();
      const ai = getGemini();
      if (!qdrant || !ai) {
        res.status(503).json({ success: false, error: 'README chat requires both Qdrant and Gemini configuration.' });
        return;
      }

      const collectionName = projectToCollectionName(projectName);
      await ensureCollection(qdrant, collectionName);
      const projectFilter = {
        must: [
          { key: 'userId', match: { value: userId } },
          { key: 'projectId', match: { value: projectId } },
        ],
      };
      const scrolled = await qdrant.scroll(collectionName, {
        filter: projectFilter,
        limit: 12,
        with_payload: true,
      });
      const points = scrolled.points || [];
      const context = points
        .map((match: any) => String(match.payload?.text || ''))
        .filter(Boolean)
        .join('\n\n--- README SECTION ---\n\n');
      if (!context) {
        res.status(404).json({ success: false, error: 'No README has been indexed for this project.' });
        return;
      }

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: `You are a senior software architect helping improve the project "${projectName}".
Answer the user's question using only the README context below. Be practical and explain improvements to project structure, maintainability, testing, security, and deployment when relevant. If the README does not contain enough information, say what is missing instead of inventing details.

User question:
${message.trim()}

README context:
${context.slice(0, 24000)}`,
      });
      res.json({
        success: true,
        data: {
          answer: response.text || 'Gemini returned an empty answer.',
          sources: points.map((match: any) => match.payload?.heading || 'README section').filter(Boolean),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Knowledge] Project chat failed:', msg);
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * GET /api/knowledge/documents?userId=<uuid>
   * Returns all document metadata for a user (in-memory).
   */
  router.get('/documents', (req: Request, res: Response): void => {
    const userId = req.query.userId as string | undefined;
    if (!userId) {
      res.status(400).json({ success: false, error: 'userId query parameter is required.' });
      return;
    }

    const docs = Array.from(docStore.values())
      .filter((d) => d.userId === userId)
      .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());

    res.json({ success: true, count: docs.length, documents: docs });
  });

  /**
   * DELETE /api/knowledge/documents/:documentId
   * Removes all Qdrant points for this document and deletes metadata.
   */
  router.delete('/documents/:documentId', async (req: Request, res: Response): Promise<void> => {
    const rawDocId = req.params.documentId;
    const documentId = Array.isArray(rawDocId) ? rawDocId[0] : rawDocId;
    const doc = docStore.get(documentId);

    if (!doc) {
      res.status(404).json({ success: false, error: 'Document not found.' });
      return;
    }

    try {
      const qdrant = getQdrantClient();
      if (qdrant) {
        const collectionName = (doc as any).collectionName || projectToCollectionName(doc.projectName);
        await qdrant.delete(collectionName, {
          wait: true,
          filter: {
            must: [{ key: 'documentId', match: { value: documentId } }],
          },
        });
      }

      docStore.delete(documentId);
      res.json({ success: true, message: `Document '${doc.filename}' removed from knowledge base.` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, error: msg });
    }
  });

  /**
   * GET /api/knowledge/status
   * Returns configuration status of Qdrant and Gemini.
   */
  router.get('/status', async (_req: Request, res: Response): Promise<void> => {
    const qdrantConfigured = Boolean(
      process.env.QDRANT_CLUSTER_ENDPOINT && process.env.QDRANT_API_KEY
    );
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here'
    );

    let qdrantReachable = false;
    let collections: string[] = [];

    if (qdrantConfigured) {
      try {
        const qdrant = getQdrantClient()!;
        const result = await qdrant.getCollections();
        qdrantReachable = true;
        collections = result.collections.map((c) => c.name);
      } catch {
        qdrantReachable = false;
      }
    }

    // List unique collection names from all indexed documents
    const docCollections = Array.from(new Set(
      Array.from(docStore.values()).map((d) => (d as any).collectionName || projectToCollectionName(d.projectName))
    ));

    res.json({
      qdrantConfigured,
      qdrantReachable,
      collections,          // all collections in Qdrant
      docCollections,       // collections used by indexed documents
      geminiConfigured,
      totalDocuments: docStore.size,
    });
  });

  return router;
}
