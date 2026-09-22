const $ = selector => document.querySelector(selector);
const statuses = { saved: '待筛选', queued: '等待投递', running: '处理中', contacted: '已发起沟通', resume_sent: '已发送简历', needs_review: '待人工核对', skipped: '已跳过' };
let state, filter = 'all', selected = new Set(), settingsLoaded = false, pollBusy = false, jobRenderKey = '';
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
async function api(path, body, method = 'POST') {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-OfferPilot': 'local' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
async function action(fn) { if (busy) return; busy = true; document.body.classList.add('is-busy'); try { await fn(); await refresh(); } catch (error) { toast(error.message); } finally { busy = false; document.body.classList.remove('is-busy'); if (state) updateSelection(); } }
async function refresh() {
  if (pollBusy) return;
  pollBusy = true;
  try { state = await api('state', undefined, 'GET'); render(); } catch (error) { toast('连接失败：' + error.message); } finally { pollBusy = false; }
}
function render() {
  const jobs = state.jobs;
  for (const id of selected) { const j = jobs.find(j => j.id === id); if (!j || j.attempted || !j.match.eligible || !['saved', 'skipped'].includes(j.status)) selected.delete(id); }
  $('#stat-total').textContent = jobs.length;
  $('#stat-match').textContent = jobs.filter(j => j.match.eligible).length;
  $('#stat-queue').textContent = jobs.filter(j => j.status === 'queued').length;
  $('#stat-sent').textContent = jobs.filter(j => j.status === 'resume_sent').length;
  $('#job-count').textContent = jobs.length;
  $('#runner-message').textContent = state.runner.message;
  $('#runner-policy').textContent = `今日已尝试 ${state.runner.attemptsToday} / ${state.settings.dailyLimit} · 间隔 ${state.settings.intervalSeconds} 秒 · ${state.settings.mode === 'resume' ? '发送附件：' + state.settings.resumeName : '仅发起沟通'}`;
  $('#start').hidden = state.runner.running; $('#stop').hidden = !state.runner.running;
  $('#start').disabled = !jobs.some(j => j.status === 'queued') || !state.runner.browserOpen;
  $('#browser-label').textContent = state.runner.browserOpen ? 'BOSS 浏览器已打开' : '连接 BOSS 浏览器';
  $('#capture').disabled = state.runner.running || !state.runner.browserOpen;
  $('#open-browser').disabled = state.runner.running;
  renderJobs();
  renderTracking();
  $('#activity-list').innerHTML = state.events.length ? state.events.map(e => `<div class="activity-row"><div><span class="tag">${escape(statuses[e.kind] || ({ attempt: '开始尝试', error: '异常', manual_review: '人工核对' }[e.kind]) || e.kind)}</span> ${escape(e.message)}</div><small>${escape(new Date(e.created).toLocaleString('zh-CN'))}</small></div>`).join('') : '<div class="empty"><span class="empty-icon">↗</span><h3>每一次进展，都会留在这里</h3><p>开始执行后，会显示投递时间、结果与需要核对的异常。</p></div>';
  if (!settingsLoaded) {
    for (const [key, value] of Object.entries(state.settings)) { const field = $('#settings-form').elements[key]; if (field) field.value = Array.isArray(value) ? value.join(', ') : value; }
    settingsLoaded = true;
  }
  $('#settings-form').querySelector('button[type=submit]').disabled = state.runner.running;
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `${button.dataset.view}-view`; });
  document.querySelectorAll('.nav').forEach(nav => nav.classList.toggle('active', nav === button));
  $('#breadcrumb').textContent = button.textContent.slice(1).trim();
  window.scrollTo({ top: 0, behavior: 'instant' });
}));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b === button)); if (state) renderJobs(); }));
$('#search').addEventListener('input', () => { if (state) renderJobs(); });
$('#job-list').addEventListener('change', event => { const id = event.target.dataset.select; if (id) { event.target.checked ? selected.add(id) : selected.delete(id); if (selected.size > 100) { selected.delete(id); event.target.checked = false; toast('单次最多选择 100 个职位'); } updateSelection(); $('#results-summary').textContent = `显示 ${visibleJobs().length} / ${state.jobs.length} 个机会 · 已选 ${selected.size} 个`; jobRenderKey = JSON.stringify([visibleJobs(), filter, [...selected]]); event.target.closest('.job-card').classList.toggle('is-selected', selected.has(id)); } });
$('#job-list').addEventListener('click', event => { const button = event.target.closest('[data-status]'); if (button) action(() => api(`jobs/${button.dataset.id}/status`, { status: button.dataset.status })); });
$('#add-job').onclick = () => $('#job-dialog').showModal();
$('#close-dialog').onclick = () => $('#job-dialog').close();
$('#job-form').onsubmit = event => { event.preventDefault(); action(async () => { const result = await api('jobs', Object.fromEntries(new FormData(event.target))); $('#job-dialog').close(); event.target.reset(); toast(result.duplicate ? '该职位已经在清单中' : '职位已保存'); }); };
$('#settings-form').onsubmit = event => { event.preventDefault(); action(async () => {
  const values = Object.fromEntries(new FormData(event.target));
  for (const key of ['keywords', 'cities', 'excludedCompanies']) values[key] = values[key].split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  for (const key of ['minSalary', 'threshold', 'dailyLimit', 'intervalSeconds']) values[key] = Number(values[key]);
  await api('settings', values, 'PUT'); settingsLoaded = false; toast('偏好已保存');
}); };
$('#open-browser').onclick = () => action(async () => { toast('正在打开浏览器，请稍候…'); await api('browser/open'); toast('请在新浏览器窗口中手动扫码登录 BOSS'); });
$('#capture').onclick = () => action(async () => { const result = await api('browser/capture'); toast(result.duplicate ? '职位已存在，已自动去重' : '职位采集成功'); });
$('#queue-selected').onclick = () => action(async () => { const result = await api('queue', { ids: [...selected] }); selected.clear(); toast(`已加入 ${result.added} 个职位`); });
$('#start').onclick = () => { $('#start-summary').textContent = `本轮队列共 ${state.jobs.filter(j => j.status === 'queued').length} 个职位。模式：${state.settings.mode === 'resume' ? '发起沟通并发送附件简历「' + state.settings.resumeName + '」' : '仅发起沟通，不发送附件'}。今日剩余尝试额度 ${Math.max(0, state.settings.dailyLimit - state.runner.attemptsToday)} 次。`; $('#start-dialog').showModal(); };
$('#close-start').onclick = () => $('#start-dialog').close();
$('#confirm-start').onclick = () => action(async () => { await api('runner/start'); $('#start-dialog').close(); toast('已开始执行'); });
$('#stop').onclick = () => action(() => api('runner/stop'));
const stages = { interested: '有意向', applied: '已申请', interview: '面试中', offer: '收到 Offer', closed: '已结束' };
let detailId = null, trackingDirty = false, busy = false;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const due = job => Boolean(job.tracking.followUp && job.tracking.followUp <= today() && job.tracking.stage !== 'closed');
const selectable = job => !job.attempted && job.match.eligible && ['saved', 'skipped'].includes(job.status);
function visibleJobs() {
  const query = $('#search').value.trim().toLowerCase();
  const jobs = state.jobs.filter(j => (filter === 'all' || filter === 'eligible' && j.match.eligible || filter === 'favorite' && j.tracking.favorite || filter === 'due' && due(j) || j.status === filter) && `${j.title} ${j.company} ${j.city} ${j.tracking.notes}`.toLowerCase().includes(query));
  const order = $('#sort-jobs').value;
  if (order === 'score') jobs.sort((a, b) => b.match.score - a.match.score);
  if (order === 'followUp') jobs.sort((a, b) => (a.tracking.followUp || '9999-12-31').localeCompare(b.tracking.followUp || '9999-12-31'));
  return jobs;
}
function updateSelection() {
  $('#selection-count').textContent = selected.size;
  $('#queue-selected').disabled = !selected.size || busy;
  $('#clear-selected').disabled = !selected.size;
}
function renderJobs() {
  const jobs = visibleJobs();
  updateSelection();
  $('#results-summary').textContent = `显示 ${jobs.length} / ${state.jobs.length} 个机会 · 已选 ${selected.size} 个`;
  $('#select-visible').disabled = !jobs.some(selectable);
  const nextKey = JSON.stringify([jobs, filter, [...selected]]);
  if (nextKey === jobRenderKey) return;
  jobRenderKey = nextKey;
  $('#job-list').innerHTML = jobs.length ? jobs.map(j => `
    <article class="job-card ${selected.has(j.id) ? 'is-selected' : ''}">
      <input type="checkbox" data-select="${j.id}" aria-label="选择 ${escape(j.title)}" ${selected.has(j.id) ? 'checked' : ''} ${selectable(j) ? '' : 'disabled'}>
      <div class="job-main"><div class="job-title-row"><span class="company-avatar" aria-hidden="true">${escape(j.company.slice(0, 1))}</span><div><button class="job-title" data-detail="${j.id}">${escape(j.title)}</button><div class="company">${escape(j.company)} · ${escape(j.city || '城市待核实')}</div></div></div>
        <div class="job-facts"><span class="salary">${escape(j.salary || '薪资未提供')}</span><span class="tag">${escape(stages[j.tracking.stage])} · 手动记录</span>${j.tracking.followUp ? `<span class="tag ${due(j) ? 'due' : ''}">${due(j) ? '待跟进' : '跟进'} ${escape(j.tracking.followUp)}</span>` : ''}</div>
        <div class="tags">${j.match.matched.map(k => `<span class="tag match">✓ ${escape(k)}</span>`).join('') || '<span class="tag">暂无命中关键词</span>'}</div>
        ${j.match.reasons.length ? `<p class="job-note">${escape(j.match.reasons.join(' · '))}</p>` : ''}${j.note ? `<p class="job-note">${escape(j.note)}</p>` : ''}
        ${j.tracking.notes ? `<p class="notes-preview">${escape(j.tracking.notes.slice(0, 120))}</p>` : ''}
        <div class="review-actions"><button class="text-button" data-detail="${j.id}">详情与备注 ↗</button>${j.status === 'needs_review' ? `<button class="button" data-status="contacted" data-id="${j.id}">核实：已沟通</button><button class="button" data-status="resume_sent" data-id="${j.id}">核实：已发简历</button><button class="button" data-status="skipped" data-id="${j.id}">核实：未发送 / 跳过</button>` : j.status === 'queued' ? `<button class="button" data-status="saved" data-id="${j.id}">移出队列</button>` : ''}</div>
      </div><div class="job-side"><button class="favorite-button ${j.tracking.favorite ? 'is-favorite' : ''}" data-favorite="${j.id}" aria-label="${j.tracking.favorite ? '取消收藏' : '收藏'} ${escape(j.title)}" aria-pressed="${j.tracking.favorite}">${j.tracking.favorite ? '★' : '☆'}</button><div class="score">${j.match.score}<small>匹配分</small></div><span class="badge ${j.status}">${escape(statuses[j.status])}</span></div>
    </article>`).join('') : `<div class="empty"><div class="empty-icon">⌁</div><h3>${state.jobs.length ? '暂时没有符合条件的机会' : '你的下一站，从一个机会开始'}</h3><p>${state.jobs.length ? '换一个筛选条件，或清空搜索关键词再看看。' : '添加心动的职位，查看匹配原因，再为下一步留一点计划。'}</p><button class="button" data-empty-action>${state.jobs.length ? '重置筛选' : '＋ 添加第一个职位'}</button></div>`;
}
function renderTracking() {
  $('#today-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  const pending = state.jobs.filter(due).length;
  $('#attention').hidden = !pending;
  $('#attention-title').textContent = `${pending} 个机会到了跟进时间`;
  $('#attention-text').textContent = '看一眼之前的备注，为下一次沟通做好准备。';
  $('#board-overview').textContent = `${state.jobs.filter(j => j.tracking.stage === 'interview').length} 个面试中 · ${state.jobs.filter(j => j.tracking.stage === 'offer').length} 个 Offer · ${pending} 个待跟进`;
  const content = Object.entries(stages).map(([stage, title]) => {
    const jobs = state.jobs.filter(j => j.tracking.stage === stage);
    return `<section class="kanban-column"><h2><span class="stage-dot ${stage}"></span>${title}<span class="count">${jobs.length}</span></h2><div class="kanban-items">${jobs.map(j => `<button class="kanban-card" data-detail="${j.id}"><span class="kanban-company">${escape(j.company)}${j.tracking.favorite ? ' ★' : ''}</span><strong>${escape(j.title)}</strong><span class="kanban-salary">${escape(j.salary)}</span><span class="badge ${j.status}">${escape(statuses[j.status])}</span>${j.tracking.followUp ? `<span class="kanban-date ${due(j) ? 'overdue' : ''}">${due(j) ? '待跟进' : '下次跟进'} · ${escape(j.tracking.followUp)}</span>` : ''}</button>`).join('') || '<p class="column-empty">暂无机会<br>在职位详情中更新阶段</p>'}</div></section>`;
  }).join('');
  if (content !== renderTracking.last) { $('#kanban').innerHTML = content; renderTracking.last = content; }
}
function openDetail(id) {
  const job = state.jobs.find(j => j.id === id);
  if (!job) return;
  detailId = id; trackingDirty = false;
  $('#detail-title').textContent = job.title;
  $('#detail-company').textContent = `${job.company} · ${job.city || '城市待核实'} · ${job.salary || '薪资未提供'}`;
  $('#detail-meta').textContent = `匹配分 ${job.match.score} · 投递状态：${statuses[job.status]}${job.match.reasons.length ? ' · ' + job.match.reasons.join('；') : ''}`;
  $('#detail-description').textContent = job.description || '暂无职位描述';
  $('#detail-link').href = job.url;
  for (const key of ['stage', 'notes', 'followUp']) $('#tracking-form').elements[key].value = job.tracking[key];
  $('#detail-feedback').textContent = '';
  $('#detail-dialog').showModal();
}
function closeDetail() {
  if (trackingDirty && !confirm('备注或跟进信息尚未保存，确定放弃修改吗？')) return;
  $('#detail-dialog').close(); trackingDirty = false;
}
$('#detail-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
$('#close-detail').onclick = closeDetail;
$('#tracking-form').addEventListener('input', () => { trackingDirty = true; $('#detail-feedback').textContent = '有尚未保存的修改'; });
$('#tracking-form').onsubmit = event => { event.preventDefault(); action(async () => {
  const value = Object.fromEntries(new FormData(event.target));
  await api(`jobs/${detailId}/tracking`, value, 'PATCH'); trackingDirty = false;
  $('#detail-feedback').textContent = '已保存到本地'; toast('跟进记录已保存');
}); };
$('#sort-jobs').onchange = () => state && renderJobs();
$('#select-visible').onclick = () => { for (const job of visibleJobs().filter(selectable)) { if (selected.size >= 100) break; selected.add(job.id); } renderJobs(); if (selected.size === 100) toast('单次最多选择 100 个职位'); };
$('#clear-selected').onclick = () => { selected.clear(); renderJobs(); };
$('#view-due').onclick = () => { filter = 'due'; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b.dataset.filter === filter)); renderJobs(); $('#job-list').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
for (const container of [$('#job-list'), $('#kanban')]) container.addEventListener('click', event => {
  const detail = event.target.closest('[data-detail]');
  if (detail) openDetail(detail.dataset.detail);
  const favorite = event.target.closest('[data-favorite]');
  if (favorite) action(async () => { const job = state.jobs.find(j => j.id === favorite.dataset.favorite); await api(`jobs/${job.id}/tracking`, { favorite: !job.tracking.favorite }, 'PATCH'); });
  if (event.target.closest('[data-empty-action]')) {
    if (!state.jobs.length) $('#job-dialog').showModal();
    else { filter = 'all'; $('#search').value = ''; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b.dataset.filter === 'all')); renderJobs(); }
  }
});

refresh(); setInterval(refresh, 4000);
