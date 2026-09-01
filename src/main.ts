import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, powerSaveBlocker, Rectangle, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log/main';
import { AgentConfig, classifyPrintFailure, DEFAULT_CONFIG, documentUrl, managedWorkerState, normalizeConfig, parseRuntimeOptions, PREPARE_RECEIPT_SCRIPT, PrinterRoute, rasterPageHeightMicrons, rasterPrintHtml } from './core';
import { dashboardHtml } from './dashboard';
import { ActivityStore, ActivityOutcome } from './history';

type Job = { jobId: string; doc: string; title: string; query: string };
const busy = new Set<string>();
type RouteState = { online: boolean; busy?: boolean; last?: string; lastAt?: string; error?: string; serverState?: string };
const runtime = parseRuntimeOptions(process.argv.slice(1));
const state = new Map<string, RouteState>();
let config: AgentConfig = DEFAULT_CONFIG, setup: BrowserWindow | null = null, tray: Tray | null = null, timer: NodeJS.Timeout | null = null, quitting = false;
let history: ActivityStore | null = null;
let printerProbe: BrowserWindow | null = null, stateTimer: NodeJS.Timeout | null = null, printerTimer: NodeJS.Timeout | null = null, parentTimer: NodeJS.Timeout | null = null;
let availablePrinters: { name: string; displayName: string }[] = [], configSignature = '';
const agentVersion = () => app.getVersion();
const agentHost = () => os.hostname().slice(0, 80);
const dataDir = () => runtime.dataDir ? path.resolve(runtime.dataDir) : app.getPath('userData');
const configPath = () => path.join(dataDir(), 'config.json');
const statePath = () => path.join(dataDir(), 'status.json');
function ensureDataDir() { fs.mkdirSync(dataDir(), { recursive: true }); fs.mkdirSync(path.join(dataDir(), 'logs'), { recursive: true }); }
function writeJson(file: string, value: unknown) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.rmSync(file, { force: true });
  fs.renameSync(temporary, file);
}
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
function loadConfig() {
  try { config = normalizeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8'))); }
  catch { config = DEFAULT_CONFIG; }
  configSignature = JSON.stringify(config);
}
function saveConfig(v: unknown) {
  config = normalizeConfig(v as AgentConfig); ensureDataDir(); writeJson(configPath(), config);
  configSignature = JSON.stringify(config); schedule(); return config;
}
function reloadManagedConfig() {
  if (!runtime.managed || quitting) return;
  try {
    const next = normalizeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8')));
    const signature = JSON.stringify(next);
    if (signature !== configSignature) { config = next; configSignature = signature; schedule(); }
  } catch (error) { log.warn('Managed print configuration could not be reloaded', error); }
}
function publishManagedState() {
  if (!runtime.managed || quitting) return;
  try { writeJson(statePath(), managedWorkerState(config, state, availablePrinters, agentVersion(), agentHost())); }
  catch (error) { log.warn('Managed print status could not be published', error); }
}
async function refreshPrinters() {
  if (!printerProbe || printerProbe.isDestroyed()) return;
  try {
    availablePrinters = (await printerProbe.webContents.getPrintersAsync()).map((p) => ({ name: p.name, displayName: p.displayName || p.name }));
    publishManagedState();
  } catch (error) { log.warn('Windows printers could not be enumerated', error); }
}
async function call(route: PrinterRoute, url: string, init?: RequestInit) {
  const ctl = new AbortController(); const timeout = setTimeout(() => ctl.abort(), 15000);
  const headers = new Headers(init?.headers);
  headers.set('x-print-agent', agentVersion()); headers.set('x-print-agent-host', agentHost());
  try { return await fetch(config.baseUrl + url, { ...init, headers, signal: ctl.signal }); } finally { clearTimeout(timeout); }
}
async function ack(route: PrinterRoute, jobId: string, ok: boolean, error = '', reason = 'unknown', spooledAt = ''): Promise<string> {
  const res = await call(route, '/v1/print/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    key: route.key, jobId, ok, error: error.slice(0, 300), reason, deviceName: route.deviceName,
    spooledAt, agentVersion: agentVersion(), agentHost: agentHost(), dry: false,
  }) });
  if (!res.ok) throw new Error('RestoHub acknowledgement returned HTTP ' + res.status);
  return String(((await res.json()) as any).state || 'unknown');
}
async function print(route: PrinterRoute, job: Job): Promise<string> {
  // Render first, then print a PNG. Some POS80 Windows drivers corrupt
  // Chromium's vector/EMF spool output but handle raster output correctly.
  const render = new BrowserWindow({ show: false, width: 640, height: 1200, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  let spool: BrowserWindow | null = null;
  try {
    await Promise.race([render.loadURL(documentUrl(config.baseUrl, job)), new Promise((_, reject) => setTimeout(() => reject(new Error('document load timeout')), 20000))]);
    // requestAnimationFrame is suspended for hidden windows on some Electron/
    // Windows combinations. Waiting on it deadlocked v0.1.1 after claiming a job.
    await within(render.webContents.executeJavaScript(`document.fonts.ready`, true), 5000, 'receipt fonts timeout');
    const bounds = await render.webContents.executeJavaScript(PREPARE_RECEIPT_SCRIPT, true) as Rectangle;
    render.setContentSize(Math.max(1, bounds.x + bounds.width), Math.max(1, bounds.y + bounds.height));
    const image = await within(render.webContents.capturePage(bounds), 10000, 'receipt raster timeout');
    spool = new BrowserWindow({ show: false, width: 640, height: Math.max(300, image.getSize().height), useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    await within(spool.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(rasterPrintHtml(image.toPNG().toString('base64').replace(/^/, 'data:image/png;base64,')))), 15000, 'raster document load timeout');
    const bitmap = image.getSize();
    await within(new Promise<void>((resolve, reject) => spool!.webContents.print({ silent: true, printBackground: true, deviceName: route.deviceName, margins: { marginType: 'none' }, pageSize: { width: 80000, height: rasterPageHeightMicrons(bitmap.width, bitmap.height) } }, (ok, reason) => ok ? resolve() : reject(new Error(reason || 'Windows rejected print job')))), 30000, 'Windows print timeout');
    return new Date().toISOString();
  } finally {
    if (spool && !spool.isDestroyed()) spool.destroy();
    if (!render.isDestroyed()) render.destroy();
  }
}
async function poll(route: PrinterRoute) {
  if (!route.enabled || busy.has(route.key)) return; busy.add(route.key);
  state.set(route.key, { ...(state.get(route.key) || { online: false }), busy: true }); updateTray();
  try {
    const res = await call(route, '/v1/print/next?key=' + encodeURIComponent(route.key));
    if (res.status === 204) { state.set(route.key, { ...(state.get(route.key) || {}), online: true, busy: false }); return; }
    if (!res.ok) throw new Error('RestoHub returned HTTP ' + res.status);
    const job = await res.json() as Job;
    const startedAt = new Date().toISOString();
    const localId = history?.start({ jobId: job.jobId, routeName: route.name, deviceName: route.deviceName, doc: job.doc, title: job.title, startedAt });
    let spooledAt = '';
    try { spooledAt = await print(route, job); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e); const reason = classifyPrintFailure(msg);
      let serverState = 'unknown';
      try { serverState = await ack(route, job.jobId, false, msg, reason); } catch (ackError) { log.error(route.name, 'ack failed', ackError); }
      const outcome: ActivityOutcome = serverState === 'queued' ? 'retrying' : serverState === 'failed' ? 'failed' : 'unknown';
      if (localId) history?.finish(localId, { outcome, serverState, reason, error: msg, finishedAt: new Date().toISOString() });
      state.set(route.key, { online: true, busy: false, error: (outcome === 'retrying' ? 'Retrying: ' : '') + msg, serverState }); log.error(route.name, msg);
      return;
    }
    // Windows accepted the paper. From this point an acknowledgement outage is UNKNOWN, never
    // a print failure: sending ok:false would deliberately queue a duplicate chit.
    try {
      const serverState = await ack(route, job.jobId, true, '', 'unknown', spooledAt);
      const outcome: ActivityOutcome = serverState === 'done' ? 'printed' : 'unknown';
      if (localId) history?.finish(localId, { outcome, serverState, spooledAt, finishedAt: new Date().toISOString() });
      state.set(route.key, { online: true, busy: false, last: job.title, lastAt: spooledAt, serverState, error: outcome === 'unknown' ? 'Server could not confirm the printed job' : undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (localId) history?.finish(localId, { outcome: 'unknown', serverState: 'unknown', error: msg, spooledAt, finishedAt: new Date().toISOString() });
      state.set(route.key, { online: false, busy: false, last: job.title, lastAt: spooledAt, serverState: 'unknown', error: 'Printed, but RestoHub could not confirm it' });
      log.error(route.name, 'printed but acknowledgement failed', msg);
    }
  } catch (e) { state.set(route.key, { ...(state.get(route.key) || {}), online: false, busy: false, error: e instanceof Error ? e.message : String(e) }); }
  finally { busy.delete(route.key); updateTray(); }
}
function schedule() { if (timer) clearInterval(timer); timer = setInterval(() => config.printers.forEach((p) => void poll(p)), config.pollMs); config.printers.forEach((p) => void poll(p)); updateTray(); }
function trayIcon(tone: 'green'|'amber'|'red') { const color = tone === 'green' ? '#22a06b' : tone === 'amber' ? '#f5a524' : '#e5484d'; return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#1768e5"/><path d="M8 10h16v10H8z" fill="white"/><path d="M11 6h10v7H11zM11 20h10v6H11z" fill="white"/><circle cx="25" cy="7" r="5" fill="${color}"/></svg>`).toString('base64')); }
function updateTray() {
  const enabled=config.printers.filter(p=>p.enabled), failed=enabled.filter(p=>state.get(p.key)?.error), online=enabled.filter(p=>state.get(p.key)?.online).length;
  if (tray) { const tone=failed.length?'red':online<enabled.length?'amber':'green'; tray.setImage(trayIcon(tone)); tray.setToolTip(`RestoHub Print Agent — ${online}/${enabled.length} connected${failed.length ? ' · '+failed.length+' issue(s)' : ''}`); }
  publishManagedState();
}
function showSetup() { if (setup && !setup.isDestroyed()) return setup.show(); setup = new BrowserWindow({ width: 1060, height: 720, minWidth: 680, minHeight: 520, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } }); setup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(dashboardHtml())); setup.on('close', (e) => { if (!quitting) { e.preventDefault(); setup?.hide(); } }); }
// Keep the agent alive when every window is hidden/closed. Printing must never
// depend on a waiter opening the configuration window.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  if (timer) clearInterval(timer); if (stateTimer) clearInterval(stateTimer); if (printerTimer) clearInterval(printerTimer); if (parentTimer) clearInterval(parentTimer);
  if (runtime.managed) fs.unwatchFile(configPath());
  history?.close();
});
if (!app.requestSingleInstanceLock()) app.quit(); else app.whenReady().then(async () => {
  ensureDataDir();
  log.transports.file.resolvePathFn = () => path.join(dataDir(), 'logs', runtime.managed ? 'print-worker.log' : 'print-agent.log');
  log.initialize(); loadConfig(); history = new ActivityStore(path.join(dataDir(), 'activity.db')); history.prune();
  powerSaveBlocker.start('prevent-app-suspension');
  printerProbe = new BrowserWindow({ show: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await printerProbe.loadURL('about:blank'); await refreshPrinters(); printerTimer = setInterval(() => void refreshPrinters(), 30000);
  if (!runtime.managed) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--background'] });
    tray = new Tray(trayIcon('amber')); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open dashboard', click: showSetup }, { label: 'View failures', click: showSetup }, { label: 'Settings', click: showSetup }, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }])); tray.on('double-click', showSetup);
  } else {
    fs.watchFile(configPath(), { interval: 1500 }, reloadManagedConfig);
    stateTimer = setInterval(publishManagedState, 5000);
    if (runtime.parentPid) parentTimer = setInterval(() => {
      try { process.kill(runtime.parentPid!, 0); }
      catch (error: any) { if (error?.code !== 'EPERM') app.quit(); }
    }, 5000);
  }
  ipcMain.handle('config:load', () => config); ipcMain.handle('config:save', (_e, v) => saveConfig(v));
  ipcMain.handle('printers:list', async () => { await refreshPrinters(); return availablePrinters; });
  ipcMain.handle('status:get', () => ({ ...Object.fromEntries(state), _meta: { version: agentVersion(), host: agentHost() } }));
  ipcMain.handle('activity:list', () => history?.list(500) || []); ipcMain.handle('activity:clear', () => history?.clear());
  ipcMain.handle('logs:open', () => shell.openPath(path.dirname(log.transports.file.getFile().path)));
  ipcMain.on('window:hide', () => setup?.hide()); schedule(); if (!runtime.managed && !config.printers.length) showSetup();
});
