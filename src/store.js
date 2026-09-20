import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defaults, evaluate, normalizeJob, settingsFrom, localDay } from './domain.js';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, url TEXT UNIQUE NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'saved', note TEXT NOT NULL DEFAULT '', queue_order INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, job_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, created TEXT NOT NULL, day TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES(1, ?)').run(JSON.stringify(defaults));
    this.db.prepare("UPDATE jobs SET status='needs_review', note='程序中断，结果未知；请在 BOSS 核对后再操作' WHERE status='running'").run();
  }
  settings() { return JSON.parse(this.db.prepare('SELECT value FROM settings WHERE id=1').get().value); }
  saveSettings(value) {
    const s = settingsFrom(value);
    this.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(s));
    return s;
  }
  jobs() {
    const s = this.settings();
    return this.db.prepare('SELECT * FROM jobs ORDER BY created DESC').all().map(row => ({ ...JSON.parse(row.data), id: row.id, status: row.status, note: row.note, queueOrder: row.queue_order, created: row.created, attempted: Boolean(this.db.prepare("SELECT 1 FROM events WHERE job_id=? AND kind='attempt' LIMIT 1").get(row.id)), match: evaluate(JSON.parse(row.data), s) }));
  }
  get(id) { return this.jobs().find(j => j.id === id); }
  add(input) {
    const job = normalizeJob(input);
    const old = this.db.prepare('SELECT id FROM jobs WHERE url=?').get(job.url);
    if (old) return { job: this.get(old.id), duplicate: true };
    const id = randomUUID();
    this.db.prepare('INSERT INTO jobs(id,url,data,created) VALUES(?,?,?,?)').run(id, job.url, JSON.stringify(job), new Date().toISOString());
    return { job: this.get(id), duplicate: false };
  }
  status(id, status, note = '') {
    if (!this.get(id)) throw new Error('职位不存在');
    this.db.prepare('UPDATE jobs SET status=?,note=? WHERE id=?').run(status, note, id);
  }
  queue(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new Error('请选择 1–100 个职位');
    const jobs = [...new Set(ids)].map(id => this.get(id));
    if (jobs.some(j => !j || j.attempted || !['saved', 'skipped'].includes(j.status) || !j.match.eligible)) throw new Error('只能加入满足偏好且尚未尝试的职位');
    let order = this.db.prepare('SELECT COALESCE(MAX(queue_order),0) AS n FROM jobs').get().n;
    for (const job of jobs) this.db.prepare("UPDATE jobs SET status='queued',note='',queue_order=? WHERE id=?").run(++order, job.id);
    return jobs.length;
  }
  event(id, kind, message) {
    this.db.prepare('INSERT INTO events(job_id,kind,message,created,day) VALUES(?,?,?,?,?)').run(id ?? null, kind, message, new Date().toISOString(), localDay());
  }
  events() { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all(); }
  attemptsToday() { return this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='attempt' AND day=?").get(localDay()).n; }
  close() { this.db.close(); }
}
