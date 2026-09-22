import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

const example = { url: 'https://www.zhipin.com/job_detail/tracking.html', title: '前端', company: '测试公司', city: '上海', salary: '20-30K', description: 'React TypeScript' };
test('收藏与跟进保存到数据库，旧职位默认值不改变投递状态和去重', t => {
  const directory = mkdtempSync(join(tmpdir(), 'offerpilot-tracking-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = new Store(join(directory, 'db.sqlite'));
  const job = store.add(example).job;
  store.queue([job.id]);
  store.db.exec('DROP TABLE tracking'); // Simulate a database created before the tracking feature.
  store.close(); store = new Store(join(directory, 'db.sqlite'));
  assert.deepEqual(store.tracking(job.id), { favorite: false, stage: 'interested', notes: '', followUp: '' });
  store.saveTracking(job.id, { stage: 'offer', notes: '面试准备', followUp: '2026-09-22' });
  store.saveTracking(job.id, { favorite: true });
  assert.equal(store.get(job.id).status, 'queued');
  assert.equal(store.add(example).duplicate, true);
  store.close(); store = new Store(join(directory, 'db.sqlite'));
  assert.deepEqual(store.tracking(job.id), { favorite: true, stage: 'offer', notes: '面试准备', followUp: '2026-09-22' });
  store.close();
});
test('跟进接口校验日期、字段和跨站访问，CSV 包含安全处理后的备注', async t => {
  const store = new Store(':memory:');
  const { app } = createApp(store, { isOpen: () => false });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const job = store.add(example).job;
  const base = `http://127.0.0.1:${server.address().port}`;
  const patch = (body, headers = {}) => fetch(`${base}/api/jobs/${job.id}/tracking`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-OfferPilot': 'local', ...headers }, body: JSON.stringify(body) });
  for (const body of [{ followUp: '2026-02-30' }, { favorite: 'true' }, { stage: 'hacked' }, { notes: 'a'.repeat(10001) }, { status: 'resume_sent' }]) assert.equal((await patch(body)).status, 400);
  assert.equal((await patch({ favorite: true }, { Origin: 'https://external.example' })).status, 403);
  assert.equal((await patch({ favorite: true, notes: '=SUM(1,1)', stage: 'interview' })).status, 200);
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.jobs[0].tracking.stage, 'interview'); assert.equal(state.jobs[0].status, 'saved');
  const csv = await (await fetch(base + '/api/export')).text(); assert.ok(csv.includes("'=SUM(1,1)")); assert.ok(csv.includes('interview'));
});
