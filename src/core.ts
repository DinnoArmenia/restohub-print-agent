export type PrinterRoute = { name: string; key: string; deviceName: string; enabled: boolean };
export type AgentConfig = { baseUrl: string; pollMs: number; printers: PrinterRoute[] };

export const DEFAULT_CONFIG: AgentConfig = { baseUrl: 'https://restohub.am', pollMs: 3000, printers: [] };

export function normalizeConfig(raw: Partial<AgentConfig>): AgentConfig {
  const url = new URL(String(raw.baseUrl || DEFAULT_CONFIG.baseUrl));
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('RestoHub URL must use HTTPS');
  const seen = new Set<string>();
  const printers = (Array.isArray(raw.printers) ? raw.printers : []).map((p) => ({
    name: String(p?.name || '').trim(), key: String(p?.key || '').trim().toLowerCase(),
    deviceName: String(p?.deviceName || '').trim(), enabled: p?.enabled !== false,
  })).filter((p) => p.name && p.key && p.deviceName && !seen.has(p.key) && !!seen.add(p.key));
  return { baseUrl: url.origin, pollMs: Math.min(Math.max(Number(raw.pollMs) || 3000, 1000), 30000), printers };
}

export function documentUrl(baseUrl: string, job: { doc?: string; query?: string }): string {
  const path = job.doc === 'bill' ? '/print/bill' : '/print/chit';
  const q = new URLSearchParams(String(job.query || ''));
  if (!q.has('lang')) q.set('lang', 'hy');
  return new URL(path + '?' + q.toString(), baseUrl).toString();
}

export function rasterPrintHtml(imageDataUrl: string): string {
  const safe = imageDataUrl.startsWith('data:image/png;base64,') ? imageDataUrl : '';
  if (!safe) throw new Error('Invalid raster receipt image');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:80mm auto;margin:0}
    html,body{width:80mm;margin:0;padding:0;background:#fff}
    img{display:block;width:80mm;height:auto;margin:0;padding:0}
  </style></head><body><img src="${safe}"></body></html>`;
}
