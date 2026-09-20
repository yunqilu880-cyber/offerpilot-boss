import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BossAdapter } from '../../src/boss.js';
import { defaults } from '../../src/domain.js';

// These fixtures exercise our state machine, not the current BOSS production DOM.
const job = { id: 'fixture', title: '前端工程师', company: '示例科技', city: '上海', salary: '20-30K', description: 'React TypeScript', url: 'https://www.zhipin.com/job_detail/fixture.html' };
const pageHtml = (scenario) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
<div class="job-banner"><div class="name"><h1>前端工程师</h1></div><span class="salary">20-30K</span><span class="text-city">上海</span></div>
<div class="sider-company"><span class="company-name">示例科技</span></div><div class="job-sec-text">React TypeScript</div>
${scenario === 'captcha' ? '<p>安全验证</p>' : ''}
<button id="contact">${scenario === 'existing' ? '继续沟通' : '立即沟通'}</button>
<div class="chat-conversation" hidden><div class="job-title">${scenario === 'mismatch' ? '销售经理' : '前端工程师'}</div><div class="company-name">示例科技</div><button id="resume">发送简历</button><div id="messages"></div></div>
<div role="dialog" hidden><div class="resume-item">测试简历.pdf</div><button id="send">确认发送</button></div>
<script>window.actions=[];
document.querySelector('#contact').onclick=()=>{actions.push('contact');document.querySelector('#contact').textContent='继续沟通';document.querySelector('.chat-conversation').hidden=false;};
document.querySelector('#resume').onclick=()=>{actions.push('resume');document.querySelector('[role=dialog]').hidden=false;};
document.querySelector('#send').onclick=()=>{actions.push('send');document.querySelector('[role=dialog]').hidden=true;document.querySelector('#messages').innerHTML='<div class="message-item is-self">测试简历.pdf 已发送附件简历</div>';};
</script></body></html>`;

test('浏览器适配器：仅沟通、附件回执、会话错配、验证拦截和已有沟通', async t => {
  const browser = await chromium.launch({ headless: true, ...(process.env.TEST_BROWSER_CHANNEL ? { channel: process.env.TEST_BROWSER_CHANNEL } : {}) });
  t.after(() => browser.close());
  for (const scenario of ['contact', 'resume', 'mismatch', 'captcha', 'existing']) {
    await t.test(scenario, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'offerpilot-browser-'));
      const context = await browser.newContext();
      t.after(async () => { await context.close(); rmSync(dir, { recursive: true, force: true }); });
      await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: pageHtml(scenario) }));
      const adapter = new BossAdapter(dir); adapter.context = context;
      const settings = { ...defaults, mode: scenario === 'contact' ? 'communicate' : 'resume', resumeName: '测试简历.pdf' };
      if (['mismatch', 'captcha'].includes(scenario)) {
        await assert.rejects(adapter.apply(job, settings), scenario === 'mismatch' ? /聊天职位/ : /验证或平台限制/);
        assert.ok(!(await adapter.page.evaluate(() => window.actions)).includes('send'));
      } else {
        const result = await adapter.apply(job, settings);
        assert.equal(result.status, { contact: 'contacted', resume: 'resume_sent', existing: 'needs_review' }[scenario]);
        assert.deepEqual(await adapter.page.evaluate(() => window.actions), { contact: ['contact'], resume: ['contact', 'resume', 'send'], existing: [] }[scenario]);
      }
    });
  }
});
