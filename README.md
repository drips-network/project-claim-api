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
| `LIT_CHIPOTLE_API_KEY` | Yes | - | API key for the Lit Chipotle API (see [Lit Express Dashboard](https://dashboard.chipotle.litprotocol.com/)) |
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

This service proxies requests to the Lit Chipotle REST API, which executes a Lit Action (see `src/oracle-code.txt`) that produces signed ownership claims. The main Drips app talks to this service via `PROJECT_CLAIM_API_URL`.

The oracle code in `src/oracle-code.txt` is built from the Drips contracts repo (see `contracts/oracle/`). To regenerate it, run `npm run getDeployment ./out` in the contracts oracle directory and copy the output here.
