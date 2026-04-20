import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Octokit } from '@octokit/rest';
import redisSdk from 'redis';

// --- Config ---

const PORT = parseInt(process.env.PORT ?? '3100', 10);

const LIT_CHIPOTLE_API_KEY = process.env.LIT_CHIPOTLE_API_KEY;
const GITHUB_PERSONAL_ACCESS_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const CACHE_REDIS_CONNECTION_STRING = process.env.CACHE_REDIS_CONNECTION_STRING;

if (!LIT_CHIPOTLE_API_KEY) {
  throw new Error('LIT_CHIPOTLE_API_KEY is required');
}

const octokit = new Octokit({ auth: GITHUB_PERSONAL_ACCESS_TOKEN });

// --- Redis ---

const redis = CACHE_REDIS_CONNECTION_STRING
  ? redisSdk.createClient({ url: CACHE_REDIS_CONNECTION_STRING })
  : undefined;

redis?.on('error', (err) => console.error('Redis error:', err));
await redis?.connect();

// --- Lit action code ---

const currentDir = dirname(fileURLToPath(import.meta.url));
const litActionCode = readFileSync(join(currentDir, 'oracle-code.txt'), 'utf-8');

// --- Schemas ---

const VALID_CHAIN_NAMES = [
  'ethereum',
  'filecoin',
  'optimism',
  'metis',
  'sepolia',
  'baseSepolia',
  'optimismSepolia',
  'amoy',
  'localtestnet',
];

const chainNameSchema = z.enum(VALID_CHAIN_NAMES as [string, ...string[]]);

const gitHubPayloadSchema = z.object({
  sourceKind: z.literal('gitHub'),
  name: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'name must be in "owner/repo" format'),
  chainName: chainNameSchema,
});

const orcidPayloadSchema = z.object({
  sourceKind: z.enum(['orcid', 'orcidSandbox']),
  name: z
    .string()
    .regex(/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/, 'name must be a valid ORCID iD'),
  chainName: chainNameSchema,
});

const payloadSchema = z.discriminatedUnion('sourceKind', [
  gitHubPayloadSchema,
  orcidPayloadSchema,
]);

// --- Lit Protocol helpers ---

const LIT_API_URL = 'https://api.chipotle.litprotocol.com/core/v1/lit_action';
const LIT_TIMEOUT_MS = 60_000;
const LIT_MAX_RETRIES = 2;
const LIT_RETRY_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_COOLDOWN_SECONDS = 60;

const litActionResponseSchema = z.object({
  logs: z.string().optional(),
  response: z.object({
    oracleAddress: z.string(),
    sourceId: z.number(),
    name: z.string(),
    timestamp: z.number(),
    chains: z.record(
      z.string(),
      z.object({
        owner: z.string(),
        r: z.string(),
        vs: z.string(),
      }),
    ),
  }),
});

type LitActionResponse = z.infer<typeof litActionResponseSchema>['response'];

async function executeLitAction(
  source: { kind: string; name: string },
  chainName: string,
): Promise<LitActionResponse> {
  const res = await fetch(LIT_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-Key': LIT_CHIPOTLE_API_KEY!,
    },
    body: JSON.stringify({
      code: litActionCode,
      js_params: { source, chains: [chainName] },
    }),
    signal: AbortSignal.timeout(LIT_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Lit API HTTP ${res.status}: ${errBody}`);
  }

  const parsed = litActionResponseSchema.parse(await res.json());
  return parsed.response;
}

async function executeLitActionWithRetry(
  source: { kind: string; name: string },
  chainName: string,
): Promise<LitActionResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= LIT_MAX_RETRIES; attempt++) {
    try {
      return await executeLitAction(source, chainName);
    } catch (e) {
      lastError = e;
      console.error(`Lit attempt ${attempt + 1}/${LIT_MAX_RETRIES + 1} failed:`, e);

      if (attempt < LIT_MAX_RETRIES) {
        const delay = LIT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// --- GitHub helpers ---

type FundingJson = {
  drips?: {
    [key: string]: {
      ownedBy: string;
    };
  };
};

async function fetchFundingJson(owner: string, repo: string): Promise<FundingJson> {
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: 'FUNDING.json',
    request: { cache: 'reload' },
    headers: { 'If-None-Match': '' },
  });

  const fileContent = Buffer.from((data as { content: string }).content, 'base64').toString('utf-8');
  return JSON.parse(fileContent);
}

// --- HTTP helpers ---

function jsonResponse(statusCode: number, body: unknown): { statusCode: number; body: string; headers: Record<string, string> } {
  return {
    statusCode,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

function errorResponse(statusCode: number, message: string) {
  return jsonResponse(statusCode, { error: message });
}

// --- Request handler ---

async function handlePost(bodyText: string) {
  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(JSON.parse(bodyText));
  } catch {
    return errorResponse(400, 'Invalid payload');
  }

  const { sourceKind, name, chainName } = payload;

  // Rate limit
  const rateLimitKey = `lit-owner-sig:${sourceKind}:${name}:${chainName}`;
  if (redis) {
    const existing = await redis.get(rateLimitKey);

    if (existing) {
      return errorResponse(
        429,
        'A signature was recently requested for this source and chain. Please wait before trying again.',
      );
    }
  }

  // Pre-validate source
  if (sourceKind === 'gitHub') {
    const [repoOwner, repo] = name.split('/');
    try {
      const fundingJson = await fetchFundingJson(repoOwner, repo);
      const ownedBy = fundingJson.drips?.[chainName]?.ownedBy;

      if (!ownedBy) {
        return errorResponse(
          400,
          `FUNDING.json does not contain an ownedBy entry for chain '${chainName}'.`,
        );
      }
    } catch {
      return errorResponse(400, 'Unable to fetch or parse FUNDING.json from the repository.');
    }
  } else if (sourceKind === 'orcid' || sourceKind === 'orcidSandbox') {
    const subdomain = sourceKind === 'orcidSandbox' ? 'sandbox.' : '';
    const orcidApiUrl = `https://pub.${subdomain}orcid.org/v3.0/${name}/researcher-urls`;

    try {
      const res = await fetch(orcidApiUrl, { headers: { Accept: 'application/json' } });
      if (!res.ok) return errorResponse(400, 'Unable to fetch ORCID profile.');

      const data = await res.json();
      const urls: string[] = (data?.['researcher-url'] ?? [])
        .map((ru: { url?: { value?: string } }) => ru?.url?.value)
        .filter(Boolean);

      const hasValidClaim = urls.some((url: string) => {
        try {
          const parsed = new URL(url);
          return (
            parsed.origin === 'http://0.0.0.0' &&
            parsed.pathname === '/DRIPS_OWNERSHIP_CLAIM' &&
            parsed.searchParams.has(chainName)
          );
        } catch {
          return false;
        }
      });

      if (!hasValidClaim) {
        return errorResponse(
          400,
          `ORCID profile does not contain a valid DRIPS_OWNERSHIP_CLAIM URL for chain '${chainName}'.`,
        );
      }
    } catch {
      return errorResponse(400, 'Unable to fetch or validate ORCID profile.');
    }
  }

  // Execute Lit Action
  try {
    const response = await executeLitActionWithRetry({ kind: sourceKind, name }, chainName);

    const claim = response.chains[chainName];
    if (!claim) {
      return errorResponse(400, `No owner found for chain '${chainName}'`);
    }

    if (redis) {
      await redis.set(rateLimitKey, '1', { EX: RATE_LIMIT_COOLDOWN_SECONDS });
    }

    return jsonResponse(200, {
      sourceId: response.sourceId,
      name: response.name,
      owner: claim.owner,
      timestamp: response.timestamp,
      r: claim.r,
      vs: claim.vs,
    });
  } catch (e) {
    console.error('Lit owner signature error (all retries exhausted):', e);
    return errorResponse(500, e instanceof Error ? e.message : 'Failed to get owner signature from Lit');
  }
}

// --- Server ---

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/owner-signature') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();

    const result = await handlePost(body);
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '::', () => {
  console.log(`project-claim-api listening on [::]:${PORT}`);
});
