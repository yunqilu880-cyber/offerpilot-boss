export class Runner {
  constructor(store, adapter) { this.store = store; this.adapter = adapter; this.running = false; this.stopRequested = false; this.message = '等待开始'; }
  state() { return { running: this.running, message: this.message, attemptsToday: this.store.attemptsToday(), browserOpen: this.adapter.isOpen() }; }
  stop() { this.stopRequested = true; this.wake?.(); this.message = '正在停止；当前操作完成后退出'; }
  start() {
    if (this.running) throw new Error('队列已在运行');
    if (!this.adapter.isOpen()) throw new Error('请先打开 BOSS 浏览器并完成登录');
    if (!this.store.jobs().some(j => j.status === 'queued')) throw new Error('队列为空');
    this.running = true; this.stopRequested = false;
    this.done = this.run().catch(error => { this.message = error.message; this.store.event(null, 'error', error.message); }).finally(() => { this.running = false; });
  }
  async run() {
    // Freeze the execution policy for this run so UI edits cannot change a pending send.
    const settings = this.store.settings();
    while (!this.stopRequested) {
      if (this.store.attemptsToday() >= settings.dailyLimit) { this.message = '已达到今日尝试上限'; return; }
      const job = this.store.jobs().filter(j => j.status === 'queued').sort((a, b) => a.queueOrder - b.queueOrder)[0];
      if (!job) { this.message = '队列处理完成'; return; }
      if (!job.match.eligible) { this.store.status(job.id, 'skipped', job.match.reasons.join('；')); continue; }
      this.store.status(job.id, 'running');
      this.store.event(job.id, 'attempt', `开始处理 ${job.company} · ${job.title}`);
      this.message = `正在处理：${job.title}`;
      try {
        const result = await this.adapter.apply(job, settings, () => this.stopRequested);
        if (!['contacted', 'resume_sent', 'needs_review'].includes(result.status)) throw new Error('投递器返回未知状态');
        this.store.status(job.id, result.status, result.message);
        this.store.event(job.id, result.status, result.message);
        if (result.status === 'needs_review') { this.message = result.message; return; }
      } catch (error) {
        // A failed acknowledgement is not proof that a click/send did not happen.
        this.store.status(job.id, 'needs_review', error.message);
        this.store.event(job.id, 'needs_review', error.message);
        this.message = `已暂停：${error.message}`; return;
      }
      if (!this.stopRequested && this.store.jobs().some(j => j.status === 'queued')) {
        this.message = `间隔等待 ${settings.intervalSeconds} 秒`;
        await new Promise(resolve => { const timer = setTimeout(resolve, settings.intervalSeconds * 1000); this.wake = () => { clearTimeout(timer); resolve(); }; });
        this.wake = null;
      }
    }
    this.message = '已停止';
  }
}
