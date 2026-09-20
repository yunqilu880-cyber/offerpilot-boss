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
async function action(fn) { try { await fn(); await refresh(); } catch (error) { toast(error.message); } }
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
  $('#activity-list').innerHTML = state.events.length ? state.events.map(e => `<div class="activity-row"><div><span class="tag">${escape(statuses[e.kind] || ({ attempt: '开始尝试', error: '异常', manual_review: '人工核对' }[e.kind]) || e.kind)}</span> ${escape(e.message)}</div><small>${escape(new Date(e.created).toLocaleString('zh-CN'))}</small></div>`).join('') : '<div class="empty"><span class="empty-icon">↗</span><h3>每一次进展，都会留在这里</h3><p>开始执行后，会显示投递时间、结果与需要核对的异常。</p></div>';
  if (!settingsLoaded) {
    for (const [key, value] of Object.entries(state.settings)) { const field = $('#settings-form').elements[key]; if (field) field.value = Array.isArray(value) ? value.join(', ') : value; }
    settingsLoaded = true;
  }
  $('#settings-form').querySelector('button[type=submit]').disabled = state.runner.running;
}
function renderJobs() {
  const query = $('#search').value.trim().toLowerCase();
  const jobs = state.jobs.filter(j => (filter === 'all' || filter === 'eligible' && j.match.eligible || j.status === filter) && `${j.title} ${j.company}`.toLowerCase().includes(query));
  $('#selection-count').textContent = selected.size; $('#queue-selected').disabled = selected.size === 0;
  const nextKey = JSON.stringify([jobs, filter, query]);
  // Polling unchanged data must preserve keyboard focus and checkbox DOM nodes.
  if (nextKey === jobRenderKey) return;
  jobRenderKey = nextKey;
  $('#job-list').innerHTML = jobs.length ? jobs.map(j => `<article class="job-card"><input type="checkbox" data-select="${escape(j.id)}" aria-label="选择 ${escape(j.title)}" ${selected.has(j.id) ? 'checked' : ''} ${j.attempted || !j.match.eligible || !['saved', 'skipped'].includes(j.status) ? 'disabled' : ''}><div class="job-main"><a href="${escape(j.url)}" target="_blank" rel="noopener noreferrer"><h3>${escape(j.title)} ↗</h3></a><span class="salary">${escape(j.salary || '薪资未提供')}</span><div class="company">${escape(j.company)} <span class="slash">/</span> ${escape(j.city || '城市待核实')}</div><div class="tags">${j.match.matched.map(k => `<span class="tag match">✓ ${escape(k)}</span>`).join('')}${!j.match.matched.length ? '<span class="tag">暂无命中关键词</span>' : ''}</div>${j.match.reasons.length ? `<p class="job-note">${escape(j.match.reasons.join(' · '))}</p>` : ''}${j.note ? `<p class="job-note">${escape(j.note)}</p>` : ''}${j.status === 'needs_review' ? `<div class="review-actions"><button class="button" data-status="contacted" data-id="${j.id}">核实：已沟通</button><button class="button" data-status="resume_sent" data-id="${j.id}">核实：已发简历</button><button class="button" data-status="skipped" data-id="${j.id}">核实：未发送 / 跳过</button></div>` : j.status === 'queued' ? `<div class="review-actions"><button class="button" data-status="saved" data-id="${j.id}">移出队列</button></div>` : ''}</div><div class="job-side"><div class="score">${j.match.score}<small>匹配分</small></div><span class="badge ${j.status}">${escape(statuses[j.status])}</span></div></article>`).join('') : `<div class="empty"><div class="empty-icon">⌁</div><h3>${state.jobs.length ? '这里暂时没有符合条件的职位' : '把第一个心动的职位，加进来'}</h3><p>${state.jobs.length ? '试试其他筛选条件，或添加新的职位机会。' : '点击「添加职位」粘贴职位信息，或连接 BOSS 浏览器，采集你正在查看的职位。'}</p></div>`;
  $('#selection-count').textContent = selected.size; $('#queue-selected').disabled = selected.size === 0;
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.view').forEach(view => { view.hidden = view.id !== `${button.dataset.view}-view`; });
  document.querySelectorAll('.nav').forEach(nav => nav.classList.toggle('active', nav === button));
  $('#breadcrumb').textContent = button.textContent.slice(1).trim();
}));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('selected', b === button)); if (state) renderJobs(); }));
$('#search').addEventListener('input', () => { if (state) renderJobs(); });
$('#job-list').addEventListener('change', event => { const id = event.target.dataset.select; if (id) { event.target.checked ? selected.add(id) : selected.delete(id); $('#selection-count').textContent = selected.size; $('#queue-selected').disabled = !selected.size; } });
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
refresh(); setInterval(refresh, 4000);
