import { DatabaseSync } from 'node:sqlite';

export type ActivityOutcome = 'printing' | 'printed' | 'retrying' | 'failed' | 'unknown';
export type ActivityInput = {
  jobId: string; routeName: string; deviceName: string; doc: string; title: string;
  startedAt: string;
};
export type ActivityRow = ActivityInput & {
  id: number; attempt: number; outcome: ActivityOutcome; serverState: string;
  reason: string; error: string; spooledAt: string; finishedAt: string;
};

export class ActivityStore {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL, route_name TEXT NOT NULL, device_name TEXT NOT NULL,
        doc TEXT NOT NULL, title TEXT NOT NULL, attempt INTEGER NOT NULL,
        outcome TEXT NOT NULL, server_state TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, spooled_at TEXT NOT NULL DEFAULT '',
        finished_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS activity_started_idx ON activity(started_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS activity_job_idx ON activity(job_id, attempt);
    `);
  }
  start(input: ActivityInput): number {
    const attempt = Number((this.db.prepare('SELECT COALESCE(MAX(attempt),0)+1 n FROM activity WHERE job_id=?').get(input.jobId) as any).n);
    const result = this.db.prepare(`INSERT INTO activity
      (job_id,route_name,device_name,doc,title,attempt,outcome,started_at)
      VALUES (?,?,?,?,?,?,'printing',?)`).run(
      input.jobId, input.routeName, input.deviceName, input.doc, input.title, attempt, input.startedAt,
    );
    return Number(result.lastInsertRowid);
  }
  finish(id: number, patch: { outcome: ActivityOutcome; serverState?: string; reason?: string; error?: string; spooledAt?: string; finishedAt: string }): void {
    this.db.prepare(`UPDATE activity SET outcome=?,server_state=?,reason=?,error=?,spooled_at=?,finished_at=? WHERE id=?`).run(
      patch.outcome, String(patch.serverState || ''), String(patch.reason || '').slice(0, 80),
      String(patch.error || '').slice(0, 300), String(patch.spooledAt || ''), patch.finishedAt, id,
    );
  }
  list(limit = 500): ActivityRow[] {
    const rows = this.db.prepare('SELECT * FROM activity ORDER BY started_at DESC,id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 5000)) as any[];
    return rows.map((r) => ({
      id: Number(r.id), jobId: r.job_id, routeName: r.route_name, deviceName: r.device_name,
      doc: r.doc, title: r.title, attempt: Number(r.attempt), outcome: r.outcome,
      serverState: r.server_state, reason: r.reason, error: r.error, startedAt: r.started_at,
      spooledAt: r.spooled_at, finishedAt: r.finished_at,
    }));
  }
  prune(now = Date.now(), maxRows = 5000, days = 14): void {
    const cutoff = new Date(now - days * 86400000).toISOString();
    this.db.prepare('DELETE FROM activity WHERE started_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY started_at DESC,id DESC LIMIT ?)').run(maxRows);
  }
  clear(): void { this.db.exec('DELETE FROM activity'); }
  close(): void { this.db.close(); }
}
