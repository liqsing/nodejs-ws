'use strict';

// ================= PaaS 64MB 优化 VLESS/WS Server =================
const http = require('http');
const https = require('https');
const net = require('net');
const { Buffer } = require('buffer');
const { WebSocketServer, createWebSocketStream } = require('ws');

// ================= 配置 =================
const UUID_STR = process.env.UUID || '5efabea4-f6d4-91fd-b8f0-17e004c89c60';
const DOMAIN = process.env.DOMAIN || 'example.com'; // 仅用于 TLS 链接
const WSPATH_DEFAULT = UUID_STR.slice(0, 8);
const WSPATH = process.env.WSPATH || WSPATH_DEFAULT; // WebSocket 路径（不含斜杠）
const SUB_PATH = process.env.SUB_PATH || 'sub';      // 订阅 HTTP 路径
const NAME = process.env.NAME || 'Web';              // 节点名基础前缀
const PORT = parseInt(process.env.PORT || 3000, 10); // Node 监听端口
const SUB_MODE = (process.env.SUB_MODE || 'plain').toLowerCase(); // 'plain' | 'tls' | 'both'

// 校验 UUID
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!UUID_REGEX.test(UUID_STR)) {
  console.warn(`[WARN] UUID 无效：${UUID_STR}，请设置正确 UUID。`);
}
let VLESS_UUID;
try {
  VLESS_UUID = Buffer.from(UUID_STR.replace(/-/g, ''), 'hex');
  if (VLESS_UUID.length !== 16) throw new Error('UUID hex length != 16 bytes');
} catch (e) {
  console.error('[ERROR] UUID 解析失败：', e.message);
  process.exit(1);
}

// ================= ISP 信息缓存（简化）=================
// ISP_INFO 只有成功时才保存，失败则设为 null
let ISP_INFO = null;
let ISP_PROMISE = null;

function getISPInfoOnce() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://speed.cloudflare.com/meta', res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve(`${info.country}-${info.asOrganization}`.replace(/ /g, '_'));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('ISP Info Timeout'));
    });
  });
}

// 启动时预热 ISP：异步发起，不阻塞启动
ISP_PROMISE = getISPInfoOnce()
  .then(info => {
    ISP_INFO = info;
    console.log(`[INIT] ISP 信息获取成功: ${info}`);
  })
  .catch(e => {
    ISP_INFO = null;
    console.log(`[INIT] ISP 信息获取失败：${e.message || 'Timeout'}`);
  })
  .finally(() => {
    ISP_PROMISE = null;
  });

// ================= 工具函数 =================
function parseHostHeader(hostHeader) {
  // 输入可能是 'example.com' 或 'example.com:12345' 或 '[::1]:3000'
  try {
    const u = new URL(`http://${hostHeader}`);
    return { hostname: u.hostname, port: u.port ? parseInt(u.port, 10) : null };
  } catch {
    // fallback 粗暴处理
    if (hostHeader.startsWith('[')) {
      // IPv6 形如 [::1]:3000
      const idx = hostHeader.lastIndexOf(']:');
      if (idx !== -1) {
        const hostname = hostHeader.slice(1, idx);
        const port = parseInt(hostHeader.slice(idx + 2), 10);
        return { hostname, port: Number.isFinite(port) ? port : null };
      }
      return { hostname: hostHeader, port: null };
    }
    const parts = hostHeader.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      return { hostname: parts[0], port: parseInt(parts[1], 10) };
    }
    return { hostname: hostHeader, port: null };
  }
}

function ensureSubMode(mode) {
  if (mode === 'plain' || mode === 'tls' || mode === 'both') return mode;
  return 'plain';
}

// 生成订阅文本（可能包含多行），再由调用者进行 base64
function buildVlessLinks({ hostHeader, nameSuffix }) {
  const lines = [];
  const finalName = `${NAME}-${nameSuffix || 'Unknown'}`;
  const wsPath = encodeURIComponent(`/${WSPATH}`);

  const { hostname: reqHost, port: reqPort } = parseHostHeader(hostHeader || `${DOMAIN}:${PORT}`);

  // plain: 适用于翼龙面板直连（ws + 非 443 端口）
  if (SUB_MODE === 'plain' || SUB_MODE === 'both') {
    const h = reqHost;
    const p = reqPort || PORT; // 没有端口就用进程监听端口
    // host 参数建议填域名部分，不带端口
    const plain = `vless://${UUID_STR}@${h}:${p}?encryption=none&type=ws&host=${h}&path=${wsPath}#${finalName}`;
    lines.push(plain);
  }

  // tls: 适用于有前端反代/隧道的 wss://:443
  if (SUB_MODE === 'tls' || SUB_MODE === 'both') {
    const d = DOMAIN;
    const tls = `vless://${UUID_STR}@${d}:443?encryption=none&security=tls&sni=${d}&fp=chrome&type=ws&host=${d}&path=${wsPath}#${finalName}`;
    lines.push(tls);
  }

  return lines.join('\n');
}

// ================= HTTP 请求处理 =================
const handleHttpRequest = async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`✅ VLESS/WS Server Running\nMode: ${ensureSubMode(SUB_MODE)}\nWS Path: /${WSPATH}\n`);
  } else if (req.url === `/${SUB_PATH}`) {
    // 等待启动预热完成（若仍在进行）
    if (ISP_PROMISE) {
      try {
        await ISP_PROMISE;
      } catch {}
    }
    // 若失败过，尝试一次懒加载获取
    if (ISP_INFO === null) {
      try {
        ISP_INFO = await getISPInfoOnce();
        console.log(`[SUB] 订阅触发 ISP 获取成功：${ISP_INFO}`);
      } catch {
        console.log(`[SUB] 订阅触发 ISP 获取失败，使用 Unknown。`);
      }
    }

    const finalISPInfo = ISP_INFO || 'Unknown';

    // 基于请求 Host 构建直连（plain）链接，避免端口错配
    const hostHeader = req.headers.host || `${DOMAIN}:${PORT}`;
    const links = buildVlessLinks({ hostHeader, nameSuffix: finalISPInfo });
    const base64Content = Buffer.from(links, 'utf-8').toString('base64');

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'inline',
      'Cache-Control': 'no-store',
    });
    res.end(base64Content + '\n');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found\n');
  }
};

const httpServer = http.createServer(handleHttpRequest);

// ================= WebSocket 服务器与升级处理 =================
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false, // 降低内存/CPU占用，适合 64MB 环境
});

httpServer.on('upgrade', (req, socket, head) => {
  try {
    if (req.method !== 'GET') return socket.destroy();
    // 校验路径，仅允许 /WSPATH
    const url = new URL(req.url, `http://${req.headers.host || DOMAIN}`);
    if (url.pathname !== `/${WSPATH}`) {
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      try {
        ws.setNoDelay(true);
      } catch {}
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.destroy();
  }
});

// 心跳保活
const HEARTBEAT = 30000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  });
}, HEARTBEAT);

wss.on('close', () => clearInterval(heartbeatTimer));

// ================= VLESS/WS 连接处理 =================
wss.on('connection', (ws /*, req */) => {
  ws.once('message', (msg) => {
    try {
      if (!Buffer.isBuffer(msg)) return ws.close();

      // 最小长度检查：version(1)+uuid(16)+optLen(1)+cmd(1)
      if (msg.length < 19) return ws.close();

      const version = msg[0];
      if (version !== 0) return ws.close();

      const id = msg.subarray(1, 17);
      if (id.compare(VLESS_UUID) !== 0) return ws.close();

      const optLen = msg[17];
      // 跳过：version(1)+uuid(16)+optLen(1)+options(optLen)+cmd(1)
      let offset = 19 + optLen;
      if (msg.length < offset + 3) return ws.close(); // 至少还需要 port(2)+ATYP(1)

      const port = msg.readUInt16BE(offset);
      offset += 2;

      const ATYP = msg[offset++];
      let host;

      if (ATYP === 1) {
        // IPv4
        if (msg.length < offset + 4) return ws.close();
        host = Array.from(msg.subarray(offset, offset + 4)).join('.');
        offset += 4;
      } else if (ATYP === 2) {
        // 域名
        if (msg.length < offset + 1) return ws.close();
        const len = msg[offset++];
        if (msg.length < offset + len) return ws.close();
        host = msg.subarray(offset, offset + len).toString();
        offset += len;
      } else if (ATYP === 3) {
        // IPv6（16字节）
        if (msg.length < offset + 16) return ws.close();
        const buf = msg.subarray(offset, offset + 16);
        offset += 16;
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
        host = parts.join(':');
      } else {
        return ws.close();
      }

      // 握手应答：version 和 0
      try {
        ws.send(new Uint8Array([version, 0]));
      } catch {
        return ws.close();
      }

      const duplex = createWebSocketStream(ws, { allowHalfOpen: false });

      const dest = net.connect({ host, port }, function () {
        try {
          this.setNoDelay && this.setNoDelay(true);
        } catch {}

        // 如果首帧后还有剩余数据，转发给目标（可能包含上层协议首包）
        if (offset < msg.length) this.write(msg.subarray(offset));

        duplex.on('error', () => this.destroy());
        this.on('error', () => duplex.destroy());

        duplex.pipe(this);
        this.pipe(duplex);
      });

      dest.on('error', () => {
        try {
          duplex.destroy();
        } catch {}
      });

      ws.on('close', () => {
        try {
          dest.destroy();
        } catch {}
      });
      ws.on('error', () => {});
    } catch {
      try {
        ws.close();
      } catch {}
    }
  });

  ws.on('error', () => {});
});

// ================= 启动 =================
httpServer.listen(PORT, () => {
  console.log(`\n==============================================`);
  console.log(`🚀 VLESS/WS Server 已启动`);
  console.log(`监听端口: ${PORT}`);
  console.log(`节点名称: ${NAME}-${ISP_INFO || 'Unknown'}`);
  console.log(`WSPATH 路径: /${WSPATH}`);
  console.log(`订阅链接: http://<你的域名或IP>:${PORT}/${SUB_PATH}`);
  console.log(`订阅模式: ${ensureSubMode(SUB_MODE)}（plain=翼龙直连，tls=反代/TLS，both=同时输出两条）`);
  console.log(`==============================================\n`);
});
