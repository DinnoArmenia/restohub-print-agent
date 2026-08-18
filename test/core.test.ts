import { describe, expect, it } from 'vitest';
import { documentUrl, normalizeConfig, PREPARE_RECEIPT_SCRIPT, rasterPrintHtml } from '../src/core';
describe('configuration', () => {
  it('requires HTTPS except local development', () => { expect(() => normalizeConfig({ baseUrl: 'http://evil.test' })).toThrow('HTTPS'); expect(normalizeConfig({ baseUrl: 'http://localhost:3000' }).baseUrl).toBe('http://localhost:3000'); });
  it('normalizes and deduplicates printer keys', () => { const c=normalizeConfig({baseUrl:'https://restohub.am/x',printers:[{name:' Kitchen ',key:' CHAYN ',deviceName:'POS',enabled:true},{name:'Copy',key:'chayn',deviceName:'X',enabled:true}],pollMs:50}); expect(c.printers).toHaveLength(1); expect(c.printers[0].key).toBe('chayn'); expect(c.pollMs).toBe(1000); });
  it('builds only supported document URLs', () => { expect(documentUrl('https://restohub.am',{doc:'bill',query:'venue=1'})).toContain('/print/bill?'); expect(documentUrl('https://restohub.am',{doc:'unknown',query:'order=1'})).toContain('/print/chit?'); });
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
    expect(PREPARE_RECEIPT_SCRIPT).toContain('[data-print-root]');
    expect(PREPARE_RECEIPT_SCRIPT).toContain('getBoundingClientRect');
  });
});
