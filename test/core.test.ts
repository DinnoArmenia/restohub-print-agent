import { describe, expect, it } from 'vitest';
import { documentUrl, normalizeConfig } from '../src/core';
describe('configuration', () => {
  it('requires HTTPS except local development', () => { expect(() => normalizeConfig({ baseUrl: 'http://evil.test' })).toThrow('HTTPS'); expect(normalizeConfig({ baseUrl: 'http://localhost:3000' }).baseUrl).toBe('http://localhost:3000'); });
  it('normalizes and deduplicates printer keys', () => { const c=normalizeConfig({baseUrl:'https://restohub.am/x',printers:[{name:' Kitchen ',key:' CHAYN ',deviceName:'POS',enabled:true},{name:'Copy',key:'chayn',deviceName:'X',enabled:true}],pollMs:50}); expect(c.printers).toHaveLength(1); expect(c.printers[0].key).toBe('chayn'); expect(c.pollMs).toBe(1000); });
  it('builds only supported document URLs', () => { expect(documentUrl('https://restohub.am',{doc:'bill',query:'venue=1'})).toContain('/print/bill?'); expect(documentUrl('https://restohub.am',{doc:'unknown',query:'order=1'})).toContain('/print/chit?'); });
});
