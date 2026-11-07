import { z } from 'zod';

export const KnowledgeChunkSchema = z.object({
  id: z.string(),          // UUID string used as Qdrant point ID
  documentId: z.string(),  // parent document UUID
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  heading: z.string().optional(),   // nearest markdown heading above this chunk
  tokenEstimate: z.number().int(),
});
export type KnowledgeChunk = z.infer<typeof KnowledgeChunkSchema>;

export const KnowledgeDocumentSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),          // Supabase user UUID
  userEmail: z.string().email().optional(),
  projectId: z.string(),       // Vercel project ID or any project identifier
  projectName: z.string(),
  filename: z.string(),
  contentHash: z.string(),     // SHA-256 of raw content for dedup
  chunkCount: z.number().int(),
  uploadedAt: z.string().datetime(),
  status: z.enum(['pending', 'embedded', 'failed']),
  errorMessage: z.string().optional(),
});
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;

export const UploadReadmePayloadSchema = z.object({
  content: z.string().min(10, 'README content must be at least 10 characters'),
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  filename: z.string().default('README.md'),
  userId: z.string().min(1),
  userEmail: z.string().optional(),
});
export type UploadReadmePayload = z.infer<typeof UploadReadmePayloadSchema>;

export const UploadReadmeResponseSchema = z.object({
  success: z.boolean(),
  documentId: z.string().optional(),
  chunkCount: z.number().optional(),
  collectionName: z.string().optional(),
  error: z.string().optional(),
});
export type UploadReadmeResponse = z.infer<typeof UploadReadmeResponseSchema>;

export interface KnowledgeSearchResult {
  chunkId: string;
  documentId: string;
  projectId: string;
  projectName: string;
  filename: string;
  heading?: string;
  text: string;
  score: number;
}
