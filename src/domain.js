export const defaults = {
  keywords: ['前端', 'React', 'TypeScript'], excludedCompanies: [], cities: [],
  minSalary: 0, threshold: 40, dailyLimit: 10, intervalSeconds: 60,
  browser: 'chromium', mode: 'communicate', resumeName: '',
};

export function settingsFrom(input) {
  const s = { ...defaults, ...input };
  for (const key of ['keywords', 'excludedCompanies', 'cities']) {
    if (!Array.isArray(s[key]) || s[key].some(x => typeof x !== 'string' || x.length > 100)) throw new Error(`${key} 必须为文字数组`);
    s[key] = [...new Set(s[key].map(x => x.trim()).filter(Boolean))].slice(0, 50);
  }
  for (const [key, min, max] of [['minSalary', 0, 1000], ['threshold', 0, 100], ['dailyLimit', 1, 100], ['intervalSeconds', 30, 3600]]) {
    if (!Number.isFinite(s[key]) || !Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`${key} 应为 ${min}–${max} 的整数`);
  }
  if (!['chromium', 'chrome', 'msedge'].includes(s.browser)) throw new Error('不支持的浏览器');
  if (!['communicate', 'resume'].includes(s.mode)) throw new Error('不支持的投递模式');
  if (typeof s.resumeName !== 'string' || s.resumeName.length > 200) throw new Error('简历名称不合法');
  if (s.mode === 'resume' && !s.resumeName.trim()) throw new Error('发送简历模式需要指定 BOSS 附件简历的完整名称');
  return Object.fromEntries(Object.keys(defaults).map(k => [k, s[k]]));
}

export function canonicalJobUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.hostname !== 'www.zhipin.com' || u.username || u.password || u.port || !/^\/job_detail\/[a-zA-Z0-9_-]+\.html$/.test(u.pathname)) throw new Error('请输入 BOSS 直聘职位详情链接');
  return `${u.origin}${u.pathname}`;
}

export function normalizeJob(input) {
  const job = {};
  for (const key of ['title', 'company', 'city', 'salary', 'description']) {
    if (typeof input[key] !== 'string') throw new Error(`${key} 应为文字`);
    job[key] = input[key].trim().slice(0, key === 'description' ? 20000 : 300);
  }
  if (!job.title || !job.company) throw new Error('职位名称、公司不能为空');
  job.url = canonicalJobUrl(input.url);
  return job;
}

export function evaluate(job, settings) {
  const text = `${job.title} ${job.description}`.toLowerCase();
  const matched = settings.keywords.filter(k => text.includes(k.toLowerCase()));
  const blocked = settings.excludedCompanies.find(k => job.company.toLowerCase().includes(k.toLowerCase()));
  const reasons = [];
  if (blocked) reasons.push(`公司命中排除词：${blocked}`);
  if (settings.cities.length && !settings.cities.some(c => job.city.includes(c))) reasons.push('工作城市不符合偏好');
  // Only monthly K ranges can be compared. Daily/hourly salary is deliberately not guessed.
  const salary = /^(\d+(?:\.\d+)?)(?:\s*[-–]\s*\d+(?:\.\d+)?)\s*[kK](?:[·•]\d+薪)?$/.exec(job.salary.trim());
  if (settings.minSalary && (!salary || Number(salary[1]) < settings.minSalary)) reasons.push(salary ? '薪资下限低于期望' : '薪资格式无法自动核实');
  const score = settings.keywords.length ? Math.round(matched.length / settings.keywords.length * 100) : 100;
  if (score < settings.threshold) reasons.push(`匹配分低于 ${settings.threshold}`);
  return { score, matched, eligible: reasons.length === 0, reasons };
}

export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
