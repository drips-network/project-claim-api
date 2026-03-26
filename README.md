# project-claim-api

Standalone service that executes Lit Protocol actions to generate owner-signature proofs for Drips project claims. Supports GitHub (via FUNDING.json) and ORCID source types.

## Endpoints

### `POST /owner-signature`

Request body:

```json
{
  "sourceKind": "gitHub",
  "name": "owner/repo",
  "chainName": "ethereum"
}
```

or

```json
{
  "sourceKind": "orcid",
  "name": "0000-0002-1825-0097",
  "chainName": "ethereum"
}
```

Response:

```json
{
  "sourceId": 0,
  "name": "owner/repo",
  "owner": "0x...",
  "timestamp": 1711000000,
  "r": "0x...",
  "vs": "0x..."
}
```

### `GET /health`

Returns `{ "status": "ok" }`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3100` | Port to listen on |
| `LIT_NETWORK` | No | `naga` | Lit network: `dev`, `test`, or `naga` |
| `LIT_ETHEREUM_PRIVATE_KEY` | For `test`/`naga` | - | Private key for Lit auth. Optional on `dev`. |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | No | - | GitHub token for FUNDING.json lookups (avoids rate limits) |
| `CACHE_REDIS_CONNECTION_STRING` | No | - | Redis URL for rate limiting (e.g. `redis://localhost:6379`) |

## Development

```sh
npm install
cp .env.example .env  # configure env vars
npm run dev            # starts with tsx watch
```

## Production

```sh
npm run build
npm start
```

## Docker

```sh
docker build -f Dockerfile.dockerhub -t project-claim-api .
docker run -p 3100:3100 --env-file .env project-claim-api
```

The GitHub Actions workflow in `.github/workflows/publish-docker.yml` builds and publishes multi-arch images to Docker Hub on push.

## Architecture

This service was extracted from the main Drips app to isolate the Lit Protocol SDK (~845MB) and its ethers v5/v6 dependency conflicts from the SvelteKit build. The app proxies requests to this service via `PROJECT_CLAIM_API_URL`.
