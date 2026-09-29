import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Template processing helper: resolves @import(...) recursively
function prepareTemplate(content: string, visited: Set<string> = new Set()): string {
  const importRegex = /@import\(([^)]+)\)/g;
  return content.replace(importRegex, (match, moduleName) => {
    const trimmed = moduleName.trim();
    if (visited.has(trimmed)) {
      return '';
    }
    visited.add(trimmed);

    const candidates = [
      path.join(__dirname, 'plugins/Request/modules', `${trimmed}.html`),
      path.join(__dirname, 'plugins/Request/modules', trimmed),
      path.join(__dirname, 'plugins/Request/pages', `${trimmed}.html`),
    ];

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        const fileContent = fs.readFileSync(cand, 'utf8');
        return prepareTemplate(fileContent, new Set(visited));
      }
    }
    return '';
  });
}

// In-memory data store for device configs and calls
interface DeviceConfig {
  fp: string;
  sipServer: string;
  sipUser: string;
  sipDomain: string;
  sipPass: string;
  codec: string;
  trunkCodec: string;
  selectedCodec?: string;
  selectedCodecFormat?: string;
  callVol?: number;
  micVolCall?: number;
  currentPage?: string;
  lastPacket?: Record<string, any>;
  [key: string]: any;
}

const devices = new Map<string, DeviceConfig>();
const activeCalls = new Map<string, { callId: string; digits: string; startTime: number; interval?: NodeJS.Timeout }>();
const speakerAudioSockets = new Map<string, Set<WebSocket>>();

// Static files
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));
app.use('/fonts', express.static(path.join(__dirname, 'css/fonts')));
app.use(express.static(path.join(__dirname, 'plugins/Request/modules')));
app.use(express.static(__dirname));

// Main route
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'plugins/Request/pages/index.html');
  if (fs.existsSync(indexPath)) {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const rendered = prepareTemplate(raw);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(rendered);
  }
  return res.status(200).send('<h1>SpechPhone Softswitch</h1>');
});

// Audio info or fallback route
app.get('/audio', (req, res) => {
  res.redirect('/');
});

app.get('/joker', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send('');
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), activeCalls: activeCalls.size });
});

// Fallback for SPA
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'plugins/Request/pages/index.html');
  if (fs.existsSync(indexPath)) {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const rendered = prepareTemplate(raw);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(rendered);
  }
  res.status(404).send('Not Found');
});

// Setup WebSockets
const wssSignaling = new WebSocketServer({ noServer: true });
const wssAudio = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  const isAudio = url.pathname.includes('/audio-ws') || 
                  url.searchParams.has('ssrc') || 
                  (url.searchParams.has('fp') && url.pathname !== '/');

  if (isAudio) {
    wssAudio.handleUpgrade(request, socket, head, (ws) => {
      wssAudio.emit('connection', ws, request);
    });
  } else {
    wssSignaling.handleUpgrade(request, socket, head, (ws) => {
      wssSignaling.emit('connection', ws, request);
    });
  }
});

// Signaling WebSocket Handler
wssSignaling.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  let clientFp = 'default-device';

  ws.on('message', (message: string | Buffer) => {
    try {
      const parsed = JSON.parse(message.toString());
      const type = parsed.type;
      const data = parsed.data || {};
      const id = parsed.id;

      if (data.fp) {
        clientFp = data.fp;
      }

      switch (type) {
        case 'connect': {
          let userConfig = devices.get(clientFp);
          if (!userConfig) {
            userConfig = {
              fp: clientFp,
              sipServer: data.sipServer || 'spechshop.com',
              sipUser: data.sipUser || 'user100',
              sipDomain: data.sipDomain || 'spechshop.com',
              sipPass: data.sipPass || '',
              codec: data.codec || 'PCMA/8000',
              trunkCodec: data.trunkCodec || 'PCMA/8000',
              currentPage: data.currentPage || 'default',
              callVol: 100,
              micVolCall: 100,
              lastPacket: {
                headers: {
                  From: [`sip:${data.sipUser || 'user100'}@${data.sipDomain || 'spechshop.com'}`],
                  'Call-ID': ['']
                }
              }
            };
            devices.set(clientFp, userConfig);
          }

          // Send all saved keys to the client
          for (const [key, value] of Object.entries(userConfig)) {
            ws.send(JSON.stringify({
              type: 'setKey',
              key,
              value
            }));
          }

          // Send setPage
          ws.send(JSON.stringify({
            type: 'setPage',
            page: userConfig.currentPage || 'default'
          }));

          // Set token
          ws.send(JSON.stringify({
            type: 'setKey',
            key: 'token',
            value: '.'
          }));

          // Brand
          const brandUri = `sip:${userConfig.sipUser}@${userConfig.sipDomain || userConfig.sipServer}`;
          ws.send(JSON.stringify({
            type: 'brand',
            data: brandUri
          }));

          // Check if existing call
          const activeCall = activeCalls.get(clientFp);
          if (activeCall) {
            ws.send(JSON.stringify({
              type: 'changeCallId',
              data: activeCall.callId
            }));
            ws.send(JSON.stringify({
              type: 'event',
              data: 'callAccept'
            }));
          }
          break;
        }

        case 'getPage': {
          const pageReq = (data.page || 'default').replace(/^\//, '');
          const pagePath = path.join(__dirname, 'plugins/Request/pages', `${pageReq}.html`);
          let html = '';
          if (fs.existsSync(pagePath)) {
            html = prepareTemplate(fs.readFileSync(pagePath, 'utf8'));
          } else {
            html = `<div class="p-4 text-center text-white"><h3>Página não encontrada: ${pageReq}</h3></div>`;
          }

          ws.send(JSON.stringify({
            byToken: id,
            data: html
          }));
          break;
        }

        case 'saveConfig': {
          const existing = devices.get(clientFp) || { fp: clientFp } as DeviceConfig;
          const updated: DeviceConfig = {
            ...existing,
            ...data,
            lastPacket: {
              headers: {
                From: [`sip:${data.sipUser || existing.sipUser || 'user100'}@${data.sipDomain || existing.sipDomain || 'spechshop.com'}`],
                'Call-ID': ['']
              }
            }
          };
          devices.set(clientFp, updated);

          ws.send(JSON.stringify({
            type: 'notify',
            data: {
              type: 'bg-success text-white',
              message: 'Configuração salva com sucesso!'
            }
          }));

          for (const [k, v] of Object.entries(updated)) {
            ws.send(JSON.stringify({
              type: 'setKey',
              key: k,
              value: v
            }));
          }

          const brand = `sip:${updated.sipUser || 'user'}@${updated.sipDomain || updated.sipServer}`;
          ws.send(JSON.stringify({
            type: 'brand',
            data: brand
          }));

          if (id) {
            ws.send(JSON.stringify({
              byToken: id,
              data: { success: true }
            }));
          }
          break;
        }

        case 'register': {
          ws.send(JSON.stringify({
            type: 'notify',
            data: {
              type: 'bg-success text-white',
              message: 'Dispositivo registrado com sucesso'
            }
          }));

          if (id) {
            ws.send(JSON.stringify({
              byToken: id,
              data: { success: true }
            }));
          }
          break;
        }

        case 'StartCall':
        case 'startCall': {
          const callId = `call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          
          activeCalls.set(clientFp, {
            callId,
            digits: data.digits || '',
            startTime: Date.now()
          });

          if (id) {
            ws.send(JSON.stringify({
              byToken: id,
              data: { success: true }
            }));
          }

          ws.send(JSON.stringify({
            type: 'changeCallId',
            data: callId
          }));

          // Notify call accepted
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({
                type: 'event',
                data: 'callAccept'
              }));
            }
            startAudioStreamForCall(callId);
          }, 350);
          break;
        }

        case 'HangUpCall':
        case 'hangUpCall': {
          const call = activeCalls.get(clientFp);
          if (call) {
            stopAudioStreamForCall(call.callId);
            activeCalls.delete(clientFp);
          }

          ws.send(JSON.stringify({
            type: 'event',
            data: 'bye'
          }));

          if (id) {
            ws.send(JSON.stringify({
              byToken: id,
              data: { success: true }
            }));
          }
          break;
        }

        case 'dtmf': {
          if (id) {
            ws.send(JSON.stringify({
              byToken: id,
              data: { success: true }
            }));
          }
          break;
        }

        case 'checkCall': {
          const call = activeCalls.get(clientFp);
          if (call) {
            ws.send(JSON.stringify({
              type: 'changeCallId',
              data: call.callId
            }));
            if (id) {
              ws.send(JSON.stringify({
                byToken: id,
                data: { success: true }
              }));
            }
          } else {
            if (id) {
              ws.send(JSON.stringify({
                byToken: id,
                data: { success: false }
              }));
            }
          }
          break;
        }

        default: {
          if (id) {
            ws.send(JSON.stringify({
              byToken: id,
              data: { success: true }
            }));
          }
        }
      }
    } catch (err) {
      console.error('Error handling signaling message:', err);
    }
  });

  ws.on('close', () => {
    // client disconnected
  });
});

// Audio stream generator: creates realistic 20ms VoIP PCM16 audio frames (8kHz, 160 samples = 320 bytes)
const callAudioStreams = new Map<string, NodeJS.Timeout>();

function startAudioStreamForCall(callId: string) {
  if (callAudioStreams.has(callId)) return;

  const sampleRate = 8000;
  const frameSamples = 160; // 20ms frame
  let sampleIndex = 0;

  const interval = setInterval(() => {
    const sockets = speakerAudioSockets.get(callId);
    if (!sockets || sockets.size === 0) return;

    // Generate 160 samples of pleasant simulated call audio (soft dual frequency tone 440Hz / 480Hz)
    const pcm = new Int16Array(frameSamples);
    const f1 = 440;
    const f2 = 480;

    for (let i = 0; i < frameSamples; i++) {
      const t = (sampleIndex + i) / sampleRate;
      // Cadence: 1.5s on, 2.5s off (ringback simulation)
      const cadence = (t % 4.0) < 1.5 ? 0.25 : 0.03;
      const s1 = Math.sin(2 * Math.PI * f1 * t);
      const s2 = Math.sin(2 * Math.PI * f2 * t);
      const val = (s1 + s2) * 0.5 * cadence;
      pcm[i] = Math.floor(val * 16000);
    }
    sampleIndex += frameSamples;

    const buffer = Buffer.from(pcm.buffer);
    for (const client of sockets) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(buffer);
      }
    }
  }, 20);

  callAudioStreams.set(callId, interval);
}

function stopAudioStreamForCall(callId: string) {
  const timer = callAudioStreams.get(callId);
  if (timer) {
    clearInterval(timer);
    callAudioStreams.delete(callId);
  }
}

// Audio WebSocket Handler
wssAudio.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const fp = url.searchParams.get('fp') || 'unknown';
  const ssrc = url.searchParams.get('ssrc');
  const isMic = ssrc === 'mic-user';

  if (!isMic) {
    // Speaker connection
    if (!speakerAudioSockets.has(fp)) {
      speakerAudioSockets.set(fp, new Set());
    }
    speakerAudioSockets.get(fp)!.add(ws);

    // If call is already active, stream is started
    if (callAudioStreams.has(fp)) {
      // streaming
    }
  }

  ws.on('message', (data: Buffer | ArrayBuffer) => {
    if (isMic) {
      // Received microphone audio from client
      // Can broadcast to speaker sockets or process audio
    }
  });

  ws.on('close', () => {
    if (!isMic && speakerAudioSockets.has(fp)) {
      const set = speakerAudioSockets.get(fp);
      set?.delete(ws);
      if (set?.size === 0) {
        speakerAudioSockets.delete(fp);
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SpechPhone Softswitch running at http://${HOST}:${PORT}`);
});
