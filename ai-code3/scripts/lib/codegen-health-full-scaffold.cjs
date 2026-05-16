'use strict';

const fs = require('fs');
const path = require('path');

function writeIfMissing(absPath, content) {
  if (fs.existsSync(absPath)) {
    try {
      if (fs.readFileSync(absPath, 'utf8') === content) return false;
    } catch {
      /* overwrite */
    }
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return true;
}

function backendServerSource() {
  return `'use strict';
const http = require('http');
const PORT = Number(process.env.BACKEND_PORT || 3001);
let requestCount = 0;
let counter = 0;
const items = [];
const logs = [];

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(body));
}

function route(req, res) {
  requestCount += 1;
  const now = new Date().toISOString();
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && p === '/api/health') return json(res, 200, { status: 'healthy', service: 'backend', timestamp: now });
  if (req.method === 'GET' && p === '/api/version') return json(res, 200, { version: '1.0.0', build: 'health-full-scaffold', timestamp: now });
  if (req.method === 'GET' && p === '/api/time') return json(res, 200, { now, timezone: 'UTC' });
  if (req.method === 'GET' && p === '/api/ping') return json(res, 200, { pong: true, timestamp: now });
  if (req.method === 'GET' && p === '/api/echo') return json(res, 200, { text: u.searchParams.get('text') || 'hello', timestamp: now });
  if (req.method === 'GET' && p === '/api/random') return json(res, 200, { value: Math.floor(Math.random() * 1000), timestamp: now });
  if (req.method === 'GET' && p === '/api/status/cpu') return json(res, 200, { usage: 0.42, timestamp: now });
  if (req.method === 'GET' && p === '/api/status/memory') return json(res, 200, { free: 4096, total: 8192, timestamp: now });
  if (req.method === 'GET' && p === '/api/items') return json(res, 200, { items, timestamp: now });
  if (req.method === 'GET' && p === '/api/logs/recent') return json(res, 200, { logs: logs.slice(-20), timestamp: now });
  if (req.method === 'GET' && p === '/api/config/public') return json(res, 200, { env: 'dev', feature_flags: { demo: true }, timestamp: now });
  if (req.method === 'GET' && p === '/api/uptime') return json(res, 200, { uptime_seconds: Math.floor(process.uptime()), timestamp: now });
  if (req.method === 'GET' && p === '/api/stats') return json(res, 200, { request_count: requestCount, timestamp: now });
  if (req.method === 'GET' && p === '/api/quote') return json(res, 200, { text: 'Ship small, verify often.', author: 'ai-code3', timestamp: now });
  if (req.method === 'GET' && p === '/api/weather') return json(res, 200, { condition: 'sunny', temp_c: 22, timestamp: now });
  if (req.method === 'GET' && p === '/api/counter') {
    counter += 1;
    return json(res, 200, { value: counter, timestamp: now });
  }
  if (req.method === 'GET' && p === '/api/hash') {
    const text = u.searchParams.get('text') || 'demo';
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return json(res, 200, { hash: 'h' + h.toString(16), text, timestamp: now });
  }
  if (req.method === 'GET' && p === '/api/uuid') {
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
    return json(res, 200, { uuid, timestamp: now });
  }
  if (req.method === 'GET' && p === '/api/about') return json(res, 200, { name: 'Health Multi-Page Demo', description: 'Skill V3 full scaffold', timestamp: now });
  if (req.method === 'GET' && p === '/api/features') {
    return json(res, 200, {
      features: [
        { id: 'HEALTH-HOME-001', name: '首页导航页' },
        { id: 'HEALTH-PAGE-001', name: '健康状态页' },
        { id: 'HEALTH-PAGE-002', name: '版本信息页' },
        { id: 'HEALTH-PAGE-003', name: '当前时间页' }
      ],
      timestamp: now
    });
  }
  if (req.method === 'POST' && p === '/api/items') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let name = 'item';
      try {
        const j = JSON.parse(body || '{}');
        if (j.name) name = String(j.name);
      } catch {
        /* ignore */
      }
      const row = { id: 'i' + items.length, name, created_at: now };
      items.push(row);
      logs.push({ method: 'POST', path: p, at: now });
      json(res, 201, { ok: true, data: row, timestamp: now });
    });
    return;
  }
  logs.push({ method: req.method, path: p, at: now });
  json(res, 404, { ok: false, error: 'not_found', path: p });
}

const server = http.createServer((req, res) => route(req, res));
server.listen(PORT, () => console.log('backend listening on', PORT));
`;
}

function websiteAppJs() {
  return `(async function(){
  const out = document.getElementById('out');
  if (!out) return;
  const base = window.BACKEND_BASE_URL || 'http://localhost:3001';
  const endpoint = document.body.getAttribute('data-endpoint') || '/api/health';
  try {
    const r = await fetch(base + endpoint);
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    out.textContent = 'error: ' + (e && e.message ? e.message : String(e));
  }
})();`;
}

function websiteIndexHtml() {
  const links = [
    ['page-health.html', 'Health'],
    ['page-version.html', 'Version'],
    ['page-time.html', 'Time'],
    ['page-ping.html', 'Ping'],
    ['page-echo.html', 'Echo'],
    ['page-random.html', 'Random'],
    ['page-cpu.html', 'CPU'],
    ['page-memory.html', 'Memory'],
    ['page-items.html', 'Items'],
    ['page-logs.html', 'Logs'],
    ['page-config.html', 'Config'],
    ['page-uptime.html', 'Uptime'],
    ['page-stats.html', 'Stats'],
    ['page-quote.html', 'Quote'],
    ['page-weather.html', 'Weather'],
    ['page-counter.html', 'Counter'],
    ['page-hash.html', 'Hash'],
    ['page-uuid.html', 'UUID'],
    ['page-about.html', 'About']
  ];
  const lis = links.map(([href, label]) => `<li><a href="/${href}" data-testid="nav-${label.toLowerCase()}">${label}</a></li>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Health Home</title></head>
<body id="home-root">
<h1>Health Multi-Page Demo</h1>
<nav id="main-nav"><p>请选择页面：</p><ul>${lis}</ul></nav>
</body></html>`;
}

function pageHtml(title, endpoint) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body data-endpoint="${endpoint}"><h1>${title}</h1><a href="/" id="back-home">Back Home</a><pre id="out">loading...</pre><script src="/app.js"></script></body></html>`;
}

function websiteServerSource() {
  return `'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = Number(process.env.WEBSITE_PORT || 3000);
const root = __dirname;
http.createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const abs = path.join(root, p.replace(/^\\//, ''));
  if (!abs.startsWith(root) || !fs.existsSync(abs)) { res.statusCode = 404; res.end('not found'); return; }
  if (abs.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');
  if (abs.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(fs.readFileSync(abs));
}).listen(PORT, () => console.log('website listening on', PORT));
`;
}

function flutterMainDart() {
  return `import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

const String kBackendBase = String.fromEnvironment(
  'BACKEND_BASE_URL',
  defaultValue: 'http://10.0.2.2:3001',
);

Future<Map<String, dynamic>> fetchApi(String path) async {
  final r = await http.get(Uri.parse('\$kBackendBase\$path'));
  return jsonDecode(r.body) as Map<String, dynamic>;
}

class HealthApp extends StatefulWidget {
  const HealthApp({super.key});
  @override
  State<HealthApp> createState() => _HealthAppState();
}

class _HealthAppState extends State<HealthApp> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final pages = <Widget>[
      const HomeScreen(key: Key('screen_home')),
      ApiScreen(key: const Key('screen_health'), title: 'Health', path: '/api/health'),
      ApiScreen(key: const Key('screen_version'), title: 'Version', path: '/api/version'),
      ApiScreen(key: const Key('screen_time'), title: 'Time', path: '/api/time'),
      ApiScreen(key: const Key('screen_ping'), title: 'Ping', path: '/api/ping'),
    ];
    return MaterialApp(
      home: Scaffold(
        body: pages[_index],
        bottomNavigationBar: NavigationBar(
          key: const Key('bottom_nav'),
          selectedIndex: _index,
          onDestinationSelected: (i) => setState(() => _index = i),
          destinations: const [
            NavigationDestination(key: Key('nav_home'), icon: Icon(Icons.home), label: 'Home'),
            NavigationDestination(key: Key('nav_health'), icon: Icon(Icons.favorite), label: 'Health'),
            NavigationDestination(key: Key('nav_version'), icon: Icon(Icons.info), label: 'Version'),
            NavigationDestination(key: Key('nav_time'), icon: Icon(Icons.schedule), label: 'Time'),
            NavigationDestination(key: Key('nav_ping'), icon: Icon(Icons.network_ping), label: 'Ping'),
          ],
        ),
      ),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});
  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        key: const Key('home_list'),
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Health Multi-Page Demo', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
          const SizedBox(height: 12),
          ListTile(
            key: const Key('tile_health'),
            title: const Text('Health'),
            subtitle: const Text('HEALTH-PAGE-001'),
            onTap: () => Navigator.push(context, MaterialPageRoute(
              builder: (_) => ApiScreen(key: const Key('push_health'), title: 'Health', path: '/api/health'),
            )),
          ),
          ListTile(
            key: const Key('tile_version'),
            title: const Text('Version'),
            onTap: () => Navigator.push(context, MaterialPageRoute(
              builder: (_) => ApiScreen(key: const Key('push_version'), title: 'Version', path: '/api/version'),
            )),
          ),
          ListTile(
            key: const Key('tile_time'),
            title: const Text('Time'),
            onTap: () => Navigator.push(context, MaterialPageRoute(
              builder: (_) => ApiScreen(key: const Key('push_time'), title: 'Time', path: '/api/time'),
            )),
          ),
        ],
      ),
    );
  }
}

class ApiScreen extends StatefulWidget {
  const ApiScreen({super.key, required this.title, required this.path});
  final String title;
  final String path;
  @override
  State<ApiScreen> createState() => _ApiScreenState();
}

class _ApiScreenState extends State<ApiScreen> {
  String _body = 'loading...';
  @override
  void initState() {
    super.initState();
    _load();
  }
  Future<void> _load() async {
    try {
      final j = await fetchApi(widget.path);
      setState(() => _body = const JsonEncoder.withIndent('  ').convert(j));
    } catch (e) {
      setState(() => _body = 'error: \$e');
    }
  }
  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(
              children: [
                if (Navigator.canPop(context))
                  IconButton(key: const Key('btn_back'), icon: const Icon(Icons.arrow_back), onPressed: () => Navigator.pop(context)),
                Text(widget.title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              ],
            ),
          ),
          Expanded(child: SingleChildScrollView(key: Key('content_\${widget.title}'), padding: const EdgeInsets.all(12), child: Text(_body))),
        ],
      ),
    );
  }
}

void main() => runApp(const HealthApp());
`;
}

/**
 * Full Health demo scaffold: backend + website + Flutter mobile (apps/mobile).
 * @param {string} root - worktree or project root
 * @returns {number} files touched
 */
function applyHealthFullScaffold(root) {
  let touched = 0;
  const touch = (p, c) => {
    if (writeIfMissing(p, c)) touched += 1;
  };

  touch(path.join(root, 'backend', 'server.cjs'), backendServerSource());
  touch(path.join(root, 'website', 'index.html'), websiteIndexHtml());
  touch(path.join(root, 'website', 'app.js'), websiteAppJs());
  touch(path.join(root, 'website', 'server.cjs'), websiteServerSource());

  const pages = [
    ['page-health.html', 'Health Page', '/api/health'],
    ['page-version.html', 'Version Page', '/api/version'],
    ['page-time.html', 'Time Page', '/api/time'],
    ['page-ping.html', 'Ping Page', '/api/ping'],
    ['page-echo.html', 'Echo Page', '/api/echo?text=demo'],
    ['page-random.html', 'Random Page', '/api/random'],
    ['page-cpu.html', 'CPU Page', '/api/status/cpu'],
    ['page-memory.html', 'Memory Page', '/api/status/memory'],
    ['page-items.html', 'Items Page', '/api/items'],
    ['page-logs.html', 'Logs Page', '/api/logs/recent'],
    ['page-config.html', 'Config Page', '/api/config/public'],
    ['page-uptime.html', 'Uptime Page', '/api/uptime'],
    ['page-stats.html', 'Stats Page', '/api/stats'],
    ['page-quote.html', 'Quote Page', '/api/quote'],
    ['page-weather.html', 'Weather Page', '/api/weather'],
    ['page-counter.html', 'Counter Page', '/api/counter'],
    ['page-hash.html', 'Hash Page', '/api/hash?text=demo'],
    ['page-uuid.html', 'UUID Page', '/api/uuid'],
    ['page-about.html', 'About Page', '/api/about']
  ];
  for (const [file, title, ep] of pages) {
    touch(path.join(root, 'website', file), pageHtml(title, ep));
  }

  const mobileRoot = path.join(root, 'apps', 'mobile');
  touch(
    path.join(mobileRoot, 'pubspec.yaml'),
    `name: health_mobile
description: Health Multi-Page Demo mobile
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.3.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  integration_test:
    sdk: flutter
  flutter_lints: ^3.0.0

flutter:
  uses-material-design: true
`
  );
  touch(path.join(mobileRoot, 'lib', 'main.dart'), flutterMainDart());
  touch(
    path.join(mobileRoot, 'analysis_options.yaml'),
    `include: package:flutter_lints/flutter.yaml\nlinter:\n  rules:\n`
  );
  // Platform folders (android/ios) required for APK build; skip if already present.
  const androidGradle = path.join(mobileRoot, 'android', 'app', 'build.gradle.kts');
  if (!fs.existsSync(androidGradle)) {
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync(
        'flutter',
        ['create', '.', '--project-name', 'health_mobile', '--org', 'com.skillv3', '--platforms', 'android,ios'],
        { cwd: mobileRoot, encoding: 'utf8', timeout: 120000 }
      );
      if (r.status !== 0) {
        console.error(`codegen-health-full-scaffold: flutter create failed: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
      } else {
        touch(path.join(mobileRoot, 'lib', 'main.dart'), flutterMainDart());
      }
    } catch (e) {
      console.error(`codegen-health-full-scaffold: flutter create error: ${e.message}`);
    }
  }

  const pkg = {
    name: 'health-minimal-app',
    version: '1.0.0',
    private: true,
    scripts: {
      'start:backend': 'node backend/server.cjs',
      'start:website': 'node website/server.cjs',
      test: 'node tests/health.test.cjs',
      build: 'node scripts/build.cjs',
    },
  };
  touch(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  touch(
    path.join(root, 'tests', 'health.test.cjs'),
    `'use strict';
const { spawn } = require('child_process');
const http = require('http');
const child = spawn(process.execPath, ['backend/server.cjs'], { stdio: 'ignore', env: { ...process.env, BACKEND_PORT: '3099' } });
function req(port, pathname) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}
(async () => {
  try {
    await new Promise((r) => setTimeout(r, 500));
    const res = await req(3099, '/api/health');
    if (res.status !== 200) throw new Error('status=' + res.status);
    const j = JSON.parse(res.body);
    if (j.status !== 'healthy') throw new Error('unexpected');
    process.exit(0);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  } finally {
    child.kill('SIGTERM');
  }
})();
`
  );

  return touched;
}

module.exports = { applyHealthFullScaffold, writeIfMissing };
