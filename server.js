const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CHAT_IMGS_DIR = path.join(__dirname, 'uploads', 'chat_images');
const CONFIG_FILE = path.join(__dirname, 'config.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(CHAT_IMGS_DIR)) fs.mkdirSync(CHAT_IMGS_DIR);

let config = {
  siteName: 'BTU Examjet',
  hostName: os.hostname(),
  welcomeMessage: '',
  info: '',
};
if (fs.existsSync(CONFIG_FILE)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
}
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));


const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safe);
  }
});
const upload = multer({ storage });

const chatHistory = [];
const MAX_HISTORY = 100;
const clients = new Map();
const COLORS = ['#ff6b6b','#feca57','#48dbfb','#ff9ff3','#54a0ff','#5f27cd','#00d2d3','#ff9f43','#1dd1a1','#c8d6e5'];

wss.on('connection', (ws) => {
  const color = COLORS[clients.size % COLORS.length];
  clients.set(ws, { name: 'Anonymous', color });

  ws.send(JSON.stringify({ type: 'init', history: chatHistory, config }));
  broadcastOnlineUsers();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setName') {
      const name = String(msg.name || '').trim().slice(0, 24) || 'Anonymous';
      clients.get(ws).name = name;
      ws.send(JSON.stringify({ type: 'nameSet', name, color }));
      broadcastOnlineUsers();

    } else if (msg.type === 'chat') {
      const client = clients.get(ws);
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) return;
      const entry = {
        type: 'chat',
        name: client.name,
        color: client.color,
        text,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      chatHistory.push(entry);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      broadcast(entry);

    } else if (msg.type === 'chatImage') {
      const client = clients.get(ws);
      const imageUrl = String(msg.imageUrl || '');
      if (!imageUrl.startsWith('/api/download/')) return;
      const entry = {
        type: 'chat',
        name: client.name,
        color: client.color,
        imageUrl,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      chatHistory.push(entry);
      if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
      broadcast(entry);
    }
  });

  ws.on('close', () => { clients.delete(ws); broadcastOnlineUsers(); });
  ws.on('error', () => { clients.delete(ws); broadcastOnlineUsers(); });
});

function broadcast(data) {
  const str = JSON.stringify(data);
  for (const [client] of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(str);
  }
}

function broadcastOnlineUsers() {
  const users = [];
  for (const [, info] of clients) {
    users.push({ name: info.name, color: info.color });
  }
  broadcast({ type: 'onlineUsers', users });
}

app.set('trust proxy', false);
app.use(express.json());

function isLocalhost(req) {
  const ip = req.ip || req.socket.remoteAddress || '';
  const clean = ip.replace(/^::ffff:/, '');
  console.log('[whoami] remote IP:', ip, '-> cleaned:', clean);
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

// Tells the client whether they are the host (localhost) or not
app.get('/api/whoami', (req, res) => {
  const host = isLocalhost(req);
  res.json({ isHost: host });
});

app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).map(f => {
    const stat = fs.statSync(path.join(UPLOADS_DIR, f));
    return { name: f, display: f.replace(/^\d+-/, ''), size: stat.size, mtime: stat.mtime };
  }).sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  res.json(files);
});

app.post('/api/upload', upload.array('files'), (req, res) => {
  const uploaded = req.files.map(f => ({ name: f.filename, display: f.originalname, size: f.size }));
  broadcast({ type: 'fileUploaded', files: uploaded });
  res.json({ ok: true, files: uploaded });
});

app.get('/api/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  // Check uploads first, then chat_images
  let filepath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filepath)) filepath = path.join(CHAT_IMGS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filepath);
});

// Separate storage for chat images (hidden from file list)
const chatImgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CHAT_IMGS_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safe);
  }
});
const uploadChatImg = multer({ storage: chatImgStorage });

// Upload image for chat — saves to chat_images subdir, not shown in file list
app.post('/api/chat-image', uploadChatImg.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const client = req.body.clientId ? null : null; // identity handled by WS
  const fileUrl = `/api/download/${encodeURIComponent(req.file.filename)}`;
  res.json({ ok: true, url: fileUrl, filename: req.file.filename });
});

// Delete — only allowed from localhost
app.delete('/api/files/:filename', (req, res) => {
  if (!isLocalhost(req)) return res.status(403).json({ error: 'Forbidden' });
  const filename = path.basename(req.params.filename);
  const filepath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filepath);
  broadcast({ type: 'fileDeleted', name: filename });
  res.json({ ok: true });
});

// Host auth is now IP-based — localhost = host, LAN = student

app.get('/api/config', (req, res) => res.json(config));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('\n🌐 Examjet is running!\n');
  console.log(`  Local:    http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Network:  http://${ip}:${PORT}`));
  console.log('\nShare the Network URL with others on your LAN.\n');
});