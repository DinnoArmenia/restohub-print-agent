import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, powerSaveBlocker, Rectangle } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import { AgentConfig, DEFAULT_CONFIG, documentUrl, normalizeConfig, PREPARE_RECEIPT_SCRIPT, PrinterRoute, rasterPageHeightMicrons, rasterPrintHtml } from './core';

type Job = { jobId: string; doc: string; title: string; query: string };
const busy = new Set<string>();
const state = new Map<string, { online: boolean; last?: string; error?: string }>();
let config: AgentConfig = DEFAULT_CONFIG, setup: BrowserWindow | null = null, tray: Tray | null = null, timer: NodeJS.Timeout | null = null, quitting = false;
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}
function loadConfig() { try { config = normalizeConfig(JSON.parse(fs.readFileSync(configPath(), 'utf8'))); } catch { config = DEFAULT_CONFIG; } }
function saveConfig(v: unknown) { config = normalizeConfig(v as AgentConfig); fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 }); schedule(); return config; }
async function call(route: PrinterRoute, url: string, init?: RequestInit) {
  const ctl = new AbortController(); const timeout = setTimeout(() => ctl.abort(), 15000);
  try { return await fetch(config.baseUrl + url, { ...init, signal: ctl.signal }); } finally { clearTimeout(timeout); }
}
async function ack(route: PrinterRoute, jobId: string, ok: boolean, error = '') {
  await call(route, '/v1/print/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: route.key, jobId, ok, error: error.slice(0, 300) }) });
}
async function print(route: PrinterRoute, job: Job) {
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
  } finally {
    if (spool && !spool.isDestroyed()) spool.destroy();
    if (!render.isDestroyed()) render.destroy();
  }
}
async function poll(route: PrinterRoute) {
  if (!route.enabled || busy.has(route.key)) return; busy.add(route.key);
  try {
    const res = await call(route, '/v1/print/next?key=' + encodeURIComponent(route.key));
    if (res.status === 204) { state.set(route.key, { online: true }); return; }
    if (!res.ok) throw new Error('RestoHub returned HTTP ' + res.status);
    const job = await res.json() as Job;
    try { await print(route, job); await ack(route, job.jobId, true); state.set(route.key, { online: true, last: job.title }); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); await ack(route, job.jobId, false, msg).catch(() => {}); state.set(route.key, { online: true, error: msg }); log.error(route.name, msg); }
  } catch (e) { state.set(route.key, { online: false, error: e instanceof Error ? e.message : String(e) }); }
  finally { busy.delete(route.key); updateTray(); }
}
function schedule() { if (timer) clearInterval(timer); timer = setInterval(() => config.printers.forEach((p) => void poll(p)), config.pollMs); config.printers.forEach((p) => void poll(p)); updateTray(); }
function updateTray() { if (!tray) return; const online = config.printers.filter((p) => state.get(p.key)?.online).length; tray.setToolTip(`RestoHub Print Agent — ${online}/${config.printers.length} connected`); }
function setupHtml() { return `<!doctype html><meta charset="utf-8"><style>body{font:14px Segoe UI;margin:26px;color:#172033}h1{font-size:22px}label{display:block;margin:14px 0 4px;font-weight:600}input,select{width:100%;padding:9px;box-sizing:border-box}.row{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:8px;margin:8px 0}.row input,.row select{width:auto}button{padding:9px 14px;margin:14px 6px 0 0}.ok{color:#087a3e}</style><h1>RestoHub Print Agent</h1><label>RestoHub URL</label><input id="url"><label>Printer routes</label><div id="rows"></div><button id="add">Add printer</button><button id="save">Save and start</button><button id="close">Hide</button><p id="msg"></p><script>let devices=[];const A=window.agent;function row(p={}){let d=document.createElement('div');d.className='row';d.innerHTML='<input placeholder="Kitchen" class="name"><input placeholder="Printer key" class="key"><select class="device"></select><button class="remove">×</button>';d.querySelector('.name').value=p.name||'';d.querySelector('.key').value=p.key||'';let s=d.querySelector('.device');devices.forEach(x=>{let o=new Option(x.name,x.name);s.add(o)});s.value=p.deviceName||'';d.querySelector('.remove').onclick=()=>d.remove();rows.appendChild(d)};(async()=>{devices=await A.printers();let c=await A.load();url.value=c.baseUrl;c.printers.forEach(row)})();add.onclick=()=>row();close.onclick=()=>A.close();save.onclick=async()=>{try{let printers=[...document.querySelectorAll('.row')].map(r=>({name:r.querySelector('.name').value,key:r.querySelector('.key').value,deviceName:r.querySelector('.device').value,enabled:true}));await A.save({baseUrl:url.value,pollMs:3000,printers});msg.className='ok';msg.textContent='Saved. Printing is running in the background.'}catch(e){msg.textContent=e.message}}</script>`; }
function showSetup() { if (setup && !setup.isDestroyed()) return setup.show(); setup = new BrowserWindow({ width: 760, height: 560, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } }); setup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(setupHtml())); setup.on('close', (e) => { if (!quitting) { e.preventDefault(); setup?.hide(); } }); }
// Keep the agent alive when every window is hidden/closed. Printing must never
// depend on a waiter opening the configuration window.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { quitting = true; });
if (!app.requestSingleInstanceLock()) app.quit(); else app.whenReady().then(() => {
  log.initialize(); loadConfig();
  powerSaveBlocker.start('prevent-app-suspension');
  app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--background'] });
  tray = new Tray(nativeImage.createEmpty()); tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Configure', click: showSetup }, { label: 'Print status', click: showSetup }, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }])); tray.on('double-click', showSetup);
  ipcMain.handle('config:load', () => config); ipcMain.handle('config:save', (_e, v) => saveConfig(v));
  ipcMain.handle('printers:list', async () => (await BrowserWindow.getAllWindows()[0]?.webContents.getPrintersAsync() || []).map((p) => ({ name: p.name, displayName: p.displayName })));
  ipcMain.handle('status:get', () => Object.fromEntries(state)); ipcMain.on('window:hide', () => setup?.hide()); schedule(); if (!config.printers.length) showSetup();
});
