import { describe, expect, it } from 'vitest';
import { classifyPrintFailure, documentUrl, normalizeConfig, PREPARE_RECEIPT_SCRIPT, rasterPageHeightMicrons, rasterPrintHtml } from '../src/core';
import { ActivityStore } from '../src/history';
import { dashboardHtml } from '../src/dashboard';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
describe('configuration', () => {
  it('requires HTTPS except local development', () => { expect(() => normalizeConfig({ baseUrl: 'http://evil.test' })).toThrow('HTTPS'); expect(normalizeConfig({ baseUrl: 'http://localhost:3000' }).baseUrl).toBe('http://localhost:3000'); });
  it('normalizes and deduplicates printer keys', () => { const c=normalizeConfig({baseUrl:'https://restohub.am/x',printers:[{name:' Kitchen ',key:' CHAYN ',deviceName:'POS',enabled:true},{name:'Copy',key:'chayn',deviceName:'X',enabled:true}],pollMs:50}); expect(c.printers).toHaveLength(1); expect(c.printers[0].key).toBe('chayn'); expect(c.pollMs).toBe(1000); });
  it('builds only supported document URLs', () => { expect(documentUrl('https://restohub.am',{doc:'bill',query:'venue=1'})).toContain('/print/bill?'); expect(documentUrl('https://restohub.am',{doc:'unknown',query:'order=1'})).toContain('/print/chit?'); });
});

describe('print diagnostics', () => {
  it('classifies actionable Windows failures for the server log', () => {
    expect(classifyPrintFailure('Paper tray empty')).toBe('out_of_paper');
    expect(classifyPrintFailure('Unknown printer device')).toBe('device_not_found');
    expect(classifyPrintFailure('Printer is offline')).toBe('printer_offline');
    expect(classifyPrintFailure('Windows rejected print job')).toBe('spool_rejected');
    expect(classifyPrintFailure('receipt raster timeout')).toBe('doc_render_timeout');
  });

  it('ships an operations-first dashboard with activity and settings separated', () => {
    const html = dashboardHtml();
    expect(html).toContain('Printer overview');
    expect(html).toContain('Print activity');
    expect(html).toContain('Settings');
    expect(html).toContain('Retrying');
    expect(html).not.toContain('Reprint');
  });

  it('persists one local row per attempt and keeps secrets out of the record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-agent-'));
    const file = path.join(dir, 'activity.db');
    const store = new ActivityStore(file);
    const base = { jobId: 'job-1', routeName: 'Kitchen', deviceName: 'POS80', doc: 'chit', title: 'Table 12', startedAt: new Date().toISOString() };
    const first = store.start(base); store.finish(first, { outcome: 'retrying', serverState: 'queued', reason: 'out_of_paper', error: 'tray empty', finishedAt: new Date().toISOString() });
    const second = store.start({ ...base, startedAt: new Date(Date.now() + 1).toISOString() }); store.finish(second, { outcome: 'printed', serverState: 'done', spooledAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    const rows = store.list();
    expect(rows).toHaveLength(2); expect(rows.map((r) => r.attempt).sort()).toEqual([1, 2]);
    expect(JSON.stringify(rows)).not.toContain('printer key');
    store.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('rasterPrintHtml', () => {
  it('creates a fixed-width bitmap-only receipt', () => {
    const html = rasterPrintHtml('data:image/png;base64,AAAA');
    expect(html).toContain('width:80mm');
    expect(html).toContain('data:image/png;base64,AAAA');
  });

  it('rejects non-PNG input', () => {
    expect(() => rasterPrintHtml('https://example.com/receipt.png')).toThrow('Invalid raster');
  });
});

describe('receipt capture', () => {
  it('strips interactive controls and identifies a printable root', () => {
    expect(PREPARE_RECEIPT_SCRIPT).toContain("querySelectorAll('button,input,select,textarea");
    expect(PREPARE_RECEIPT_SCRIPT).toContain('.paper');
    expect(PREPARE_RECEIPT_SCRIPT).toContain('.bar');
    expect(PREPARE_RECEIPT_SCRIPT).toContain('[data-print-root]');
    expect(PREPARE_RECEIPT_SCRIPT).toContain('getBoundingClientRect');
  });

  it('preserves the bitmap aspect ratio in the physical page size', () => {
    expect(rasterPageHeightMicrons(320, 640)).toBe(160000);
    expect(rasterPageHeightMicrons(640, 320)).toBe(40000);
    expect(() => rasterPageHeightMicrons(0, 100)).toThrow('dimensions');
  });
});
