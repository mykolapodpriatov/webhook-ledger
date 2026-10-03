import { describe, expect, it } from 'vitest';
import { loadTenants, parseTenants } from './config';

const ACME = {
  id: 'acme',
  ingestSecret: 'acme-ingest-secret-01',
  readToken: 'acme-read-token-0001',
};

describe('loadTenants', () => {
  it('parses a JSON array', () => {
    expect(loadTenants(JSON.stringify([ACME]))).toEqual([ACME]);
  });

  it('refuses to boot without the variable', () => {
    expect(() => loadTenants(undefined)).toThrow(/LEDGER_TENANTS is required/);
    expect(() => loadTenants('   ')).toThrow(/LEDGER_TENANTS is required/);
  });

  it('rejects malformed JSON, short secrets, and duplicate ids', () => {
    expect(() => loadTenants('{')).toThrow(/not valid JSON/);
    expect(() => parseTenants([{ ...ACME, ingestSecret: 'too-short' }])).toThrow(
      /Tenant configuration is invalid/,
    );
    expect(() => parseTenants([ACME, ACME])).toThrow(/Duplicate tenant id "acme"/);
  });
});
