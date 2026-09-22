import express from 'express';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { BossAdapter } from './boss.js';
import { Runner } from './runner.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export function createApp(store, adapter) {
  const app = express();
  const runner = new Runner(store, adapter);
  let browserBusy = false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return res.status(403).json({ error: '仅支持本机访问' });
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers['x-offerpilot'] !== 'local') return res.status(403).json({ error: '拒绝外部站点操作' });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(join(root, 'public')));
  app.get('/api/state', (req, res) => res.json({ settings: store.settings(), jobs: store.jobs().map(job => ({ ...job, tracking: store.tracking(job.id) })), events: store.events(), runner: runner.state() }));
  app.patch('/api/jobs/:id/tracking', (req, res) => res.json(store.saveTracking(req.params.id, req.body)));
  app.put('/api/settings', (req, res) => {
    if (runner.running || browserBusy) throw new Error('请停止队列并等待浏览器操作结束后再修改偏好');
    res.json(store.saveSettings(req.body));
  });
  app.post('/api/jobs', (req, res) => res.json(store.add(req.body)));
  app.post('/api/queue', (req, res) => res.json({ added: store.queue(req.body.ids) }));
  app.post('/api/jobs/:id/status', (req, res) => {
    if (runner.running) throw new Error('请先停止队列');
    const job = store.get(req.params.id);
    if (!job) throw new Error('职位不存在');
    const status = req.body.status;
    if (['queued', 'saved', 'skipped'].includes(job.status) && ['saved', 'skipped'].includes(status)) store.status(job.id, status);
    else if (job.status === 'needs_review' && ['contacted', 'resume_sent', 'skipped'].includes(status)) {
      store.status(job.id, status, '用户已人工核对'); store.event(job.id, 'manual_review', `用户标记为 ${status}`);
    } else throw new Error('不允许此状态变更，已尝试职位不能自动重投');
    res.json({ ok: true });
  });
  const withBrowser = fn => async (req, res) => {
    if (browserBusy || runner.running) throw new Error('浏览器正在执行操作，请稍后再试');
    browserBusy = true;
    try { res.json(await fn()); } finally { browserBusy = false; }
  };
  app.post('/api/browser/open', withBrowser(async () => { await adapter.open(store.settings().browser); return { ok: true }; }));
  app.post('/api/browser/capture', withBrowser(async () => store.add(await adapter.capture())));
  app.post('/api/runner/start', (req, res) => { if (browserBusy) throw new Error('请等待浏览器操作结束'); runner.start(); res.json(runner.state()); });
  app.post('/api/runner/stop', (req, res) => { runner.stop(); res.json(runner.state()); });
  app.get('/api/export', (req, res) => {
    const quote = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"';
    const rows = [['职位', '公司', '城市', '薪资', '匹配分', '投递状态', '执行备注', '链接', '收藏', '手动求职阶段', '跟进日期', '个人备注'], ...store.jobs().map(j => { const t = store.tracking(j.id); return [j.title, j.company, j.city, j.salary, j.match.score, j.status, j.note, j.url, t.favorite ? '是' : '否', t.stage, t.followUp, t.notes]; })];
    res.type('text/csv').attachment('offerpilot-jobs.csv').send('\ufeff' + rows.map(row => row.map(quote).join(',')).join('\r\n'));
  });
  app.use((err, req, res, next) => { res.status(400).json({ error: err.message || '操作失败' }); });
  return { app, runner };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = resolve(process.env.OFFERPILOT_DATA_DIR || join(root, 'data'));
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(join(dataDir, 'offerpilot.sqlite'));
  const selectors = process.env.BOSS_SELECTORS ? JSON.parse(readFileSync(resolve(process.env.BOSS_SELECTORS), 'utf8')) : undefined;
  const adapter = new BossAdapter(dataDir, selectors);
  const { app, runner } = createApp(store, adapter);
  const port = Number(process.env.PORT || 3210);
  const server = app.listen(port, '127.0.0.1', () => console.log(`OfferPilot 已启动：http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; runner.stop(); await adapter.close(); await runner.done; server.close(() => { store.close(); }); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
