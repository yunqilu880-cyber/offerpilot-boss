import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Runner } from '../src/runner.js';
import { defaults, evaluate, canonicalJobUrl, settingsFrom, localDay } from '../src/domain.js';

const job = { url: 'https://www.zhipin.com/job_detail/abc.html', title: '前端工程师', company: '测试公司', city: '上海', salary: '20-35K·14薪', description: 'React TypeScript' };
test('评分解释、公司排除、城市和月薪严格匹配', () => {
  assert.equal(evaluate(job, defaults).score, 100);
  assert.equal(evaluate(job, { ...defaults, excludedCompanies: ['测试'] }).eligible, false);
  assert.equal(evaluate(job, { ...defaults, cities: ['北京'] }).eligible, false);
  assert.equal(evaluate(job, { ...defaults, minSalary: 21 }).eligible, false);
  assert.equal(evaluate({ ...job, salary: '300元/天' }, { ...defaults, minSalary: 1 }).eligible, false);
  assert.equal(evaluate(job, { ...defaults, minSalary: 20 }).eligible, true);
});
test('拒绝外站、伪装域名、账号信息和非职位 URL', () => {
  for (const url of ['http://www.zhipin.com/job_detail/a.html', 'https://www.zhipin.com.evil.com/job_detail/a.html', 'https://evil@www.zhipin.com/job_detail/a.html', 'https://www.zhipin.com/web/geek/chat']) assert.throws(() => canonicalJobUrl(url));
  assert.equal(canonicalJobUrl(job.url + '?source=abc#x'), job.url);
});
test('配置范围校验与附件模式要求', () => {
  assert.throws(() => settingsFrom({ ...defaults, dailyLimit: 0 }));
  assert.throws(() => settingsFrom({ ...defaults, intervalSeconds: 1 }));
  assert.throws(() => settingsFrom({ ...defaults, mode: 'resume' }));
  assert.equal(settingsFrom({ ...defaults, mode: 'resume', resumeName: '简历.pdf' }).resumeName, '简历.pdf');
  assert.equal(localDay(new Date('2026-09-20T16:00:00Z')), '2026-09-21');
});
test('URL 去重，队列按加入顺序，整批校验避免部分入队', t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  const a = s.add(job).job; const b = s.add({ ...job, url: job.url.replace('abc', 'def') }).job;
  assert.equal(s.add({ ...job, url: job.url + '?x=1' }).duplicate, true);
  assert.throws(() => s.queue([a.id, 'missing'])); assert.equal(s.get(a.id).status, 'saved');
  s.queue([b.id, a.id]); assert.ok(s.get(b.id).queueOrder < s.get(a.id).queueOrder);
});
test('未知发送结果暂停全队列，已尝试条目不可重新排队', async t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  const a = s.add(job).job; const b = s.add({ ...job, url: job.url.replace('abc', 'def') }).job; s.queue([a.id, b.id]);
  let calls = 0;
  const runner = new Runner(s, { isOpen: () => true, apply: async () => { calls++; throw new Error('未知结果'); } });
  runner.start(); await runner.done;
  assert.equal(calls, 1); assert.equal(s.get(a.id).status, 'needs_review'); assert.equal(s.get(b.id).status, 'queued');
  s.status(a.id, 'skipped'); assert.throws(() => s.queue([a.id])); assert.equal(s.attemptsToday(), 1);
});
test('每日额度在执行前生效，不能重复启动 worker', async t => {
  const s = new Store(':memory:'); t.after(() => s.close()); s.saveSettings({ ...defaults, dailyLimit: 1 });
  const a = s.add(job).job; s.queue([a.id]); s.event(null, 'attempt', '已使用额度');
  let calls = 0; const runner = new Runner(s, { isOpen: () => true, apply: async () => { calls++; } });
  runner.start(); assert.throws(() => runner.start()); await runner.done; assert.equal(calls, 0); assert.equal(s.get(a.id).status, 'queued');
});
test('正常沟通只标记 contacted，停止会中断等待', async t => {
  const s = new Store(':memory:'); t.after(() => s.close());
  const a = s.add(job).job; const b = s.add({ ...job, url: job.url.replace('abc', 'def') }).job; s.queue([a.id, b.id]);
  const runner = new Runner(s, { isOpen: () => true, apply: async () => ({ status: 'contacted', message: '已沟通' }) });
  runner.start(); await new Promise(resolve => setTimeout(resolve, 10)); runner.stop(); await runner.done;
  assert.equal(s.get(a.id).status, 'contacted'); assert.equal(s.get(b.id).status, 'queued'); assert.equal(runner.running, false);
});
test('重启恢复未确认任务，不自动重复提交', t => {
  const dir = mkdtempSync(join(tmpdir(), 'offerpilot-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db.sqlite'); const first = new Store(path); const id = first.add(job).job.id;
  first.status(id, 'running'); first.close(); const second = new Store(path); assert.equal(second.get(id).status, 'needs_review'); second.close();
});
