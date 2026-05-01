# Vertex2OpenAI on Cloudflare Workers

An OpenAI-compatible API adapter for Google Vertex AI Gemini models, deployed on Cloudflare Workers. Provides a drop-in replacement endpoint so any tool or app built for the OpenAI API can use Gemini models seamlessly.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/vertex2openai-cf)

## Features

- **OpenAI-Compatible Endpoints**: Standard `/v1/chat/completions` and `/v1/models` endpoints
- **Streaming & Non-Streaming**: Full SSE streaming support with `TransformStream`
- **Multiple Auth Methods**: Vertex AI Express API Key and/or Service Account JSON
- **Official Vertex Routes**: Express keys use `publishers/google/models/...:generateContent`; service accounts use Vertex AI's OpenAI-compatible endpoint
- **Multi-Key Rotation**: Round-robin rotation when multiple API keys are configured
- **Thinking/Reasoning**: Extracts and surfaces `reasoning_content` from Gemini 2.5+ models
- **Tool/Function Calling**: Full support for OpenAI-style function calling
- **Image Generation**: Support for `-2k` and `-4k` image generation model variants
- **Grounded Search**: Use `-search` suffix for Google Search grounding
- **Zero Dependencies**: Uses only Web APIs (`fetch`, `TransformStream`, `Web Crypto`)
- **Edge Deployment**: Runs on Cloudflare's global edge network for low latency
- **One-Click Deploy**: Deploy button for instant setup

## Quick Start

### 1. Deploy

Click the **Deploy to Cloudflare** button above, or deploy manually:

```bash
git clone https://github.com/workHMZ/vertex2openai-cf.git
cd vertex2openai-cf
npm install
```

### 2. Configure Secrets

```bash
# Required: API key to protect your adapter
npx wrangler secret put API_KEY

# Required (choose one):
# Option A: Vertex AI Express API Key (recommended, simplest)
npx wrangler secret put VERTEX_EXPRESS_API_KEY
# Alias also supported: VERTEX_API_KEY

# Option B: Service Account JSON (for GCP project-based auth)
npx wrangler secret put GOOGLE_CREDENTIALS_JSON
```

### 3. Deploy

```bash
npx wrangler deploy
```

### 4. (Optional) Custom Domain

In Cloudflare Dashboard → Workers & Pages → your worker → Settings → Domains & Routes → Add Custom Domain.

## Environment Variables

### Secrets (encrypted, set via `wrangler secret put`)

| Name | Required | Description |
|------|----------|-------------|
| `API_KEY` | ✅ | API key to protect this adapter |
| `VERTEX_EXPRESS_API_KEY` / `VERTEX_API_KEY` | ⚠️ One of these | Vertex AI Express API Key(s), comma-separated |
| `GOOGLE_CREDENTIALS_JSON` | ⚠️ is required | Service Account JSON content(s) |

### Variables (set in `wrangler.toml` or dashboard)

| Name | Default | Description |
|------|---------|-------------|
| `GCP_LOCATION` | `global` | GCP region/location |
| `GCP_PROJECT_ID` | auto-detect | Explicit GCP project ID |
| `MODELS_CONFIG` | built-in | Custom model list JSON |

## API Usage

### Authentication

All requests require a Bearer token matching your configured `API_KEY`:

```
Authorization: Bearer YOUR_API_KEY
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completions |

### Example: Non-Streaming

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "user", "content": "Hello, what is 2+2?"}
    ]
  }'
```

### Example: Streaming

```bash
curl -X POST https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      {"role": "user", "content": "Write a short poem about coding."}
    ],
    "stream": true
  }'
```

## Model Variants

| Suffix | Description |
|--------|-------------|
| *(none)* | Standard model call |
| `-openai` | Explicit OpenAI-compatible endpoint (Service Account / `[PAY]` models only) |
| `-openaisearch` | OpenAI-compatible endpoint with web search (Service Account / `[PAY]` models only) |
| `-search` | Google Search grounding |
| `-nothinking` | Lower thinking budget/level where supported |
| `-max` | Highest thinking budget/level where supported |
| `-2k` | Image generation at 2K resolution |
| `-4k` | Image generation at 4K resolution |

Models are prefixed with `[EXPRESS]` or `[PAY]` based on auth method. If you call an unprefixed model and both auth methods are configured, the Worker prefers Express mode. Use `[PAY]` to force the Service Account path.

## Architecture

```
Client (OpenAI SDK/App)
    │
    ▼
┌──────────────────────┐
│  Cloudflare Worker    │
│  ┌────────────────┐  │
│  │ Auth Middleware │  │
│  └───────┬────────┘  │
│  ┌───────▼────────┐  │
│  │ Request Convert│  │
│  └───────┬────────┘  │
│  ┌───────▼────────┐  │
│  │ Vertex AI Call  │──┼──► Vertex AI Express or OpenAI-compat endpoint
│  └───────┬────────┘  │
│  ┌───────▼────────┐  │
│  │Response Convert│  │
│  └───────┬────────┘  │
│          │           │
└──────────┼───────────┘
           ▼
   Client receives
   OpenAI-format response
```

## Local Development

```bash
# Create .dev.vars for local secrets
cat > .dev.vars << 'EOF'
API_KEY=test123
VERTEX_EXPRESS_API_KEY=your_express_key_here
EOF

# Start dev server
npm run dev

# Test health check
curl http://localhost:8787/

# Test models
curl -H "Authorization: Bearer test123" http://localhost:8787/v1/models

# Test chat
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test123" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Hi!"}]}'
```

## Acknowledgments

This project is inspired by and references [vertex2openai](https://github.com/gzzhongqi/vertex2openai) by gzzhongqi — a Python/Docker-based OpenAI-to-Gemini adapter. This TypeScript/Cloudflare Workers version is a ground-up rewrite optimized for edge deployment with zero runtime dependencies.

## License

MIT — see [LICENSE](LICENSE) for details.
