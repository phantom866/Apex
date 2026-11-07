import http from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { healthRouter } from './routes/health';
import { createIncidentsRouter } from './routes/incidents';
import { createLogsRouter } from './routes/logs';
import { createVercelRouter } from './routes/vercel';
import { createKnowledgeRouter } from './routes/knowledge';
import { ApexWebSocketManager } from './websocket';

// Load apps/server/.env (copy of root .env — kept in sync manually or via CI)
dotenv.config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Real-time HTTP request logger middleware
app.use((req, res, next) => {
  const start = Date.now();
  const time = new Date().toLocaleTimeString();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    console.log(`[${time}] [HTTP] ${req.method.padEnd(6)} ${req.originalUrl} -> ${status} (${duration}ms)`);
  });
  next();
});

// WebSocket Manager
export const wsManager = new ApexWebSocketManager(server);

// REST Routes
app.use('/', healthRouter);
app.use('/api', healthRouter);
app.use('/api', createIncidentsRouter(wsManager));
app.use('/api', createLogsRouter(wsManager));
app.use('/api/vercel', createVercelRouter(wsManager));
app.use('/api/knowledge', createKnowledgeRouter());

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`[APEX Server] Running on http://${HOST}:${PORT}`);
  console.log(`[APEX Server] WebSocket available at ws://${HOST}:${PORT}/ws`);
  console.log(`[APEX Server] Health endpoint: http://localhost:${PORT}/health`);
  console.log(`[APEX Server] Qdrant endpoint: ${process.env.QDRANT_CLUSTER_ENDPOINT ? '✓ configured' : '✗ NOT SET — check .env'}`);
  console.log(`[APEX Server] Gemini key:      ${process.env.GEMINI_API_KEY ? '✓ configured' : '✗ NOT SET — check .env'}`);
});

export { app, server };

