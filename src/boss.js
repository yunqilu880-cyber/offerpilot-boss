import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJobUrl, normalizeJob, evaluate } from './domain.js';

const selectorDefaults = JSON.parse(readFileSync(new URL('../config/boss-selectors.json', import.meta.url), 'utf8'));

export class BossAdapter {
  constructor(dataDir, selectors = selectorDefaults) { this.dataDir = dataDir; this.selectors = selectors; this.context = null; }
  isOpen() { return Boolean(this.context); }
  async open(channel) {
    if (this.context) { await this.page.bringToFront(); return; }
    mkdirSync(join(this.dataDir, 'browser'), { recursive: true });
    this.context = await chromium.launchPersistentContext(join(this.dataDir, 'browser'), {
      headless: false, ...(channel !== 'chromium' ? { channel } : {}), viewport: null,
      acceptDownloads: false,
    });
    this.context.on('close', () => { this.context = null; this.page = null; });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.context.on('page', page => { this.page = page; });
    await this.page.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded' });
  }
  async close() { await this.context?.close(); }
  async guard(page) {
    if (new URL(page.url()).hostname !== 'www.zhipin.com') throw new Error('浏览器已离开 BOSS 直聘，请手动检查');
    if (/\/web\/user\//.test(new URL(page.url()).pathname)) throw new Error('请在浏览器中完成登录');
    const body = await page.locator('body').innerText();
    if (/请完成.{0,8}验证|滑动.{0,8}验证|访问异常|安全验证|操作太频繁|今日沟通.*上限|账号异常/.test(body)) throw new Error('检测到验证或平台限制，请在浏览器中手动处理');
    if (await page.getByText('扫码登录', { exact: true }).isVisible().catch(() => false)) throw new Error('请先扫码登录');
  }
  async uniqueVisible(locator, label) {
    const visible = locator.filter({ visible: true });
    if (await visible.count() !== 1) throw new Error(`无法唯一识别${label}，请检查页面或更新选择器`);
    return visible;
  }
  async readJob(page) {
    await this.guard(page);
    const url = canonicalJobUrl(page.url());
    const read = async (selector, name) => (await (await this.uniqueVisible(page.locator(selector), name)).innerText()).trim();
    const title = await read(this.selectors.jobTitle, '职位名称');
    const company = await read(this.selectors.company, '公司名称');
    const salary = await read(this.selectors.salary, '薪资');
    const cityLocator = page.locator(this.selectors.city).filter({ visible: true });
    const city = await cityLocator.count() === 1 ? (await cityLocator.innerText()).trim() : '';
    const description = (await page.locator(this.selectors.description).allInnerTexts()).join('\n');
    if (!description) throw new Error('没有读取到职位描述，请确认已打开完整职位详情');
    return normalizeJob({ url, title, company, salary, city, description });
  }
  async capture() {
    if (!this.context) throw new Error('请先打开 BOSS 浏览器');
    // Use the latest job detail tab; the user explicitly chooses the role by opening it.
    const pages = this.context.pages().filter(p => { try { canonicalJobUrl(p.url()); return true; } catch { return false; } });
    if (!pages.length) throw new Error('请在 BOSS 浏览器中打开一个职位详情独立标签页');
    this.page = pages.at(-1);
    return this.readJob(this.page);
  }
  async apply(job, settings, stopped = () => false) {
    if (!this.context) throw new Error('浏览器已关闭');
    const page = await this.context.newPage();
    this.page = page;
    const checkStop = () => { if (stopped()) throw new Error('用户已停止，请核对当前职位的实际状态'); };
    try {
      await page.goto(canonicalJobUrl(job.url), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.locator(this.selectors.jobTitle).first().waitFor({ state: 'visible', timeout: 15000 });
      const actual = await this.readJob(page);
      if (actual.title !== job.title || actual.company !== job.company) throw new Error('职位信息已变化，与队列中的公司或职位不一致');
      const match = evaluate(actual, settings);
      if (!match.eligible) throw new Error(`职位最新信息不满足偏好：${match.reasons.join('；')}`);
      const continueChat = page.getByText('继续沟通', { exact: true }).filter({ visible: true });
      const existing = await continueChat.count();
      if (existing) return { status: 'needs_review', message: '该职位已有沟通记录，请手动核对是否发送过简历；未重复操作' };
      checkStop();
      const contact = await this.uniqueVisible(page.getByText('立即沟通', { exact: true }), '立即沟通按钮');
      await contact.click();
      // Wait for the UI to acknowledge, without retrying a potentially successful click.
      await Promise.any([
        page.getByText('继续沟通', { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 }),
        page.locator(this.selectors.chatPanel).first().waitFor({ state: 'visible', timeout: 15000 }),
      ]).catch(() => { throw new Error('已点击沟通但无法确认结果，请人工核对，避免重复发送'); });
      await this.guard(page);
      if (settings.mode === 'communicate') return { status: 'contacted', message: '页面已确认发起沟通；未发送附件简历' };
      checkStop();
      const next = page.getByText('继续沟通', { exact: true }).filter({ visible: true });
      if (await next.count() === 1 && !await page.locator(this.selectors.chatPanel).first().isVisible()) await next.click();
      await page.locator(this.selectors.chatPanel).first().waitFor({ state: 'visible', timeout: 15000 });
      const panel = await this.uniqueVisible(page.locator(this.selectors.chatPanel), '当前聊天区域');
      // Never send a resume into a chat merely because the recipient name looks similar.
      await this.uniqueVisible(panel.locator(this.selectors.chatJobTitle).filter({ hasText: new RegExp(`^${escapeRegex(job.title)}$`) }), '聊天职位');
      await this.uniqueVisible(panel.locator(this.selectors.chatCompany).filter({ hasText: new RegExp(`^${escapeRegex(job.company)}$`) }), '聊天公司');
      const sendResume = await this.uniqueVisible(panel.getByText('发送简历', { exact: true }), '发送简历按钮');
      checkStop();
      await sendResume.click();
      const dialog = await this.uniqueVisible(page.locator(this.selectors.resumeDialog), '简历选择窗口');
      const row = await this.uniqueVisible(dialog.locator(this.selectors.resumeRow).filter({ has: page.getByText(settings.resumeName, { exact: true }) }), '指定的附件简历');
      await row.click();
      const confirm = await this.uniqueVisible(dialog.getByRole('button', { name: /^(发送|确认发送|确定)$/ }), '确认发送按钮');
      const receipts = panel.locator(this.selectors.sentMessages).filter({ hasText: settings.resumeName }).filter({ hasText: this.selectors.resumeSuccessText });
      const before = await receipts.count();
      await this.guard(page); checkStop();
      await confirm.click();
      await receipts.nth(before).waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new Error('已确认发送，但未找到新的简历发送回执；请手动核对'); });
      return { status: 'resume_sent', message: `已核实新的附件简历发送回执：${settings.resumeName}` };
    } catch (error) {
      mkdirSync(join(this.dataDir, 'screenshots'), { recursive: true });
      await page.screenshot({ path: join(this.dataDir, 'screenshots', `${job.id}.png`) }).catch(() => {});
      if (error.message.includes('Timeout')) throw new Error('页面等待超时，结果未确认；请核对 BOSS 页面，截图保存在本地 data/screenshots');
      throw error;
    } finally {
      // Keep the last page available for manual review, close only the previous worker tab.
      if (this.previousWorker && this.previousWorker !== page && !this.previousWorker.isClosed()) await this.previousWorker.close().catch(() => {});
      this.previousWorker = page;
    }
  }
}

function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
