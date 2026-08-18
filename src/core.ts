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

/**
 * Runs inside the loaded RestoHub print document. The browser page contains
 * controls for manual printing; those must never become part of a thermal
 * receipt. Return the exact printable content bounds so capturePage can crop
 * away the desktop-sized canvas as well as the controls.
 */
export const PREPARE_RECEIPT_SCRIPT = `(() => {
  document.querySelectorAll('button,input,select,textarea,[role="button"],[data-no-print],.no-print,.print-actions,.actions').forEach((node) => node.remove());
  const root = document.querySelector('[data-print-root],.receipt,.print-receipt,.chit,.bill,.ticket,main,article') || document.body;
  document.documentElement.style.cssText += ';margin:0!important;padding:0!important;background:#fff!important;overflow:hidden!important';
  document.body.style.cssText += ';margin:0!important;padding:0!important;background:#fff!important;overflow:hidden!important';
  root.style.cssText += ';margin:0!important;max-width:none!important;box-sizing:border-box!important';
  const rect = root.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(Math.max(rect.width, root.scrollWidth)));
  const height = Math.max(1, Math.ceil(Math.max(rect.height, root.scrollHeight)));
  return { x: Math.max(0, Math.floor(rect.left)), y: Math.max(0, Math.floor(rect.top)), width: Math.min(width, 1200), height: Math.min(height, 10000) };
})()`;
