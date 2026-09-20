import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

test('API：跨站请求拒绝、持久职位队列、CSV 防公式注入', async t => {
  const store = new Store(':memory:');
  const { app } = createApp(store, { isOpen: () => false });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = { title: '=CMD()', company: '测试', city: '上海', salary: '20-30K', description: 'React TypeScript 前端', url: 'https://www.zhipin.com/job_detail/test123.html' };
  const request = (path, data, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OfferPilot': 'local', ...headers }, body: JSON.stringify(data) });
  assert.equal((await request('/api/jobs', body, { Origin: 'https://attacker.example' })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => { get(base + '/api/state', { headers: { Host: 'evil.example:3210' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
  assert.equal(badHostStatus, 403);
  const result = await (await request('/api/jobs', body)).json(); assert.equal(result.job.title, '=CMD()');
  assert.equal((await request('/api/queue', { ids: [result.job.id] })).status, 200);
  assert.equal((await request('/api/runner/start', {})).status, 400);
  assert.ok((await (await fetch(base + '/api/export')).text()).includes("'=CMD()"));
  assert.equal((await (await fetch(base + '/api/state')).json()).jobs[0].status, 'queued');
});
