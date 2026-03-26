import 'dotenv/config';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Signature } from 'ethers';
import { createLitClient } from '@lit-protocol/lit-client';
import { getIpfsId } from '@lit-protocol/lit-client/ipfs';
import { nagaDev, nagaTest, naga as nagaMainnet } from '@lit-protocol/networks';
import { createAuthManager, storagePlugins } from '@lit-protocol/auth';
import { LitActionResource } from '@lit-protocol/auth-helpers';
import { LIT_ABILITY } from '@lit-protocol/constants';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Octokit } from '@octokit/rest';
import redisSdk from 'redis';

// --- Config ---

const PORT = parseInt(process.env.PORT ?? '3100', 10);

const LIT_ETHEREUM_PRIVATE_KEY = process.env.LIT_ETHEREUM_PRIVATE_KEY;
const LIT_NETWORK_ENV = process.env.LIT_NETWORK;
const GITHUB_PERSONAL_ACCESS_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const CACHE_REDIS_CONNECTION_STRING = process.env.CACHE_REDIS_CONNECTION_STRING;

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

function getLitNetworkName() {
  return LIT_NETWORK_ENV ?? 'naga';
}

function getLitNetwork() {
  const networkName = getLitNetworkName();
  switch (networkName) {
    case 'dev':
      return nagaDev;
    case 'test':
      return nagaTest;
    case 'naga':
      return nagaMainnet;
    default:
      throw new Error(`Unknown LIT_NETWORK: ${networkName}`);
  }
}

let cachedIpfsCid: string | undefined;
async function getLitActionIpfsCid(): Promise<string> {
  if (!cachedIpfsCid) {
    cachedIpfsCid = await getIpfsId(litActionCode);
  }
  return cachedIpfsCid;
}

let cachedPrivateKey: `0x${string}` | undefined;
function getPrivateKey(): `0x${string}` {
  if (cachedPrivateKey) return cachedPrivateKey;

  if (LIT_ETHEREUM_PRIVATE_KEY) {
    cachedPrivateKey = LIT_ETHEREUM_PRIVATE_KEY as `0x${string}`;
    return cachedPrivateKey;
  }

  const litNetwork = getLitNetworkName();
  if (litNetwork !== 'dev') {
    throw new Error(
      `LIT_ETHEREUM_PRIVATE_KEY is required for Lit network '${litNetwork}'. It is only optional on 'dev'.`,
    );
  }

  cachedPrivateKey = generatePrivateKey();
  return cachedPrivateKey;
}

const storage = storagePlugins.localStorageNode({
  appName: 'drips-app',
  networkName: getLitNetworkName(),
  storagePath: join(currentDir, '.lit-auth-storage'),
});
const authManager = createAuthManager({ storage });

const LIT_TIMEOUT_MS = 60_000;
const LIT_MAX_RETRIES = 2;
const LIT_RETRY_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_COOLDOWN_SECONDS = 60;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function executeLitAction(source: { kind: string; name: string }, chainName: string) {
  let litClient;

  try {
    litClient = await createLitClient({ network: getLitNetwork() });

    const account = privateKeyToAccount(getPrivateKey());
    const ipfsCid = await getLitActionIpfsCid();

    const authContext = await authManager.createEoaAuthContext({
      litClient,
      config: { account },
      authConfig: {
        resources: [
          {
            resource: new LitActionResource(ipfsCid),
            ability: LIT_ABILITY.LitActionExecution,
          },
        ],
      },
    });

    return await litClient.executeJs({
      code: litActionCode,
      jsParams: {
        source,
        chains: [chainName],
      },
      authContext,
    });
  } finally {
    litClient?.disconnect();
  }
}

async function executeLitActionWithRetry(source: { kind: string; name: string }, chainName: string) {
  let lastError: unknown;

  for (let attempt = 0; attempt <= LIT_MAX_RETRIES; attempt++) {
    try {
      return await withTimeout(
        executeLitAction(source, chainName),
        LIT_TIMEOUT_MS,
        'Lit Action execution',
      );
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
  if (redis) {
    const rateLimitKey = `lit-owner-sig:${sourceKind}:${name}:${chainName}`;
    const existing = await redis.get(rateLimitKey);

    if (existing) {
      return errorResponse(
        429,
        'A signature was recently requested for this source and chain. Please wait before trying again.',
      );
    }

    await redis.set(rateLimitKey, '1', { EX: RATE_LIMIT_COOLDOWN_SECONDS });
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
    const result = await executeLitActionWithRetry({ kind: sourceKind, name }, chainName);

    const rawResponse =
      typeof result.response === 'string' ? JSON.parse(result.response) : result.response;

    const litResponseSchema = z.object({
      sourceId: z.number(),
      name: z.string(),
      owners: z.record(z.string(), z.string()),
      timestamp: z.number(),
    });

    const response = litResponseSchema.parse(rawResponse);

    const owner = response.owners[chainName];
    if (!owner) {
      return errorResponse(400, `No owner found for chain '${chainName}'`);
    }

    const chainSig = result.signatures?.[chainName];
    if (!chainSig) {
      return errorResponse(500, `No signature returned by Lit for chain '${chainName}'`);
    }

    const { sourceId, name: responseName, timestamp } = response;

    // Convert signature to EIP-2098 compact format
    const sig = Signature.from(chainSig.signature + '0' + chainSig.recoveryId);
    const r = sig.r;
    const vs = sig.yParityAndS;

    return jsonResponse(200, { sourceId, name: responseName, owner, timestamp, r, vs });
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
