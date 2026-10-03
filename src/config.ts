import { z } from 'zod';

const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const tenantSchema = z.object({
  id: z.string().regex(TENANT_ID),
  ingestSecret: z.string().min(16),
  readToken: z.string().min(16),
});

export type TenantConfig = z.infer<typeof tenantSchema>;

export function parseTenants(input: unknown): TenantConfig[] {
  const result = z.array(tenantSchema).min(1).safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Tenant configuration is invalid: ${detail}`);
  }
  const seen = new Set<string>();
  for (const tenant of result.data) {
    if (seen.has(tenant.id)) {
      throw new Error(`Duplicate tenant id "${tenant.id}".`);
    }
    seen.add(tenant.id);
  }
  return result.data;
}

export function loadTenants(raw: string | undefined): TenantConfig[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'LEDGER_TENANTS is required. Set it to a JSON array of { id, ingestSecret, readToken }.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LEDGER_TENANTS is not valid JSON.');
  }
  return parseTenants(parsed);
}
