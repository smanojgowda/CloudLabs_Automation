# CloudLabs AI Guide (Chrome Extension + Backend Proxy)

CloudLabs AI Guide is a Chrome Extension that provides guided, step-by-step assistance on web pages (especially Azure Portal), powered by an Express backend proxy for Azure OpenAI.

## What This Project Includes

- Chrome Extension (Manifest V3)
  - Side panel UI for guide generation, chat, and config
  - Content overlay to highlight target elements on the current page
  - Background service worker that orchestrates step generation and navigation
- Node.js backend proxy
  - Keeps API credentials server-side
  - Routes AI requests to Azure/OpenAI endpoints
  - Exposes health/test/chat/resolve-target endpoints used by the extension

## Project Structure

```text
.
├─ manifest.json
├─ background.js
├─ content.js
├─ overlay.css
├─ sidepanel/
│  ├─ sidepanel.html
│  ├─ sidepanel.css
│  └─ sidepanel.js
└─ backend/
   ├─ server.js
   ├─ package.json
   └─ .env.example
```

## Prerequisites

- Node.js 18+
- Google Chrome (latest)
- Azure OpenAI/OpenAI compatible endpoint and API key

## 1) Backend Setup

From the backend folder:

```bash
cd backend
npm install
```

Create `backend/.env` from `backend/.env.example` and set real values:

```env
PORT=3000
OPENAI_ENDPOINT=https://your-resource-name.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview
OPENAI_KEY=your_azure_openai_key_here
OPENAI_AUTH_HEADER=api-key
OPENAI_MODEL=gpt-5.3-chat
```

Start the backend:

```bash
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Expected response shape:

```json
{"ok":true,"configured":true,"model":"gpt-5.3-chat"}
```

## 2) Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the project root folder (the folder containing `manifest.json`).

## 3) Configure Proxy URL in Side Panel

1. Open the extension side panel.
2. Go to the **Config** tab.
3. Set Proxy URL to:
   - `http://localhost:3000` (default local backend)
4. Click **Test** to verify connection.
5. Click **Save**.

## 4) How to Use

### Guide tab

- Enter a goal (for example: "Create a Resource Group in Azure").
- Click **Generate Steps**.
- Follow highlighted UI guidance step-by-step.
- Use **Next** and **Previous** to navigate manually.

### Lab Guide tab

- Paste lab guide text or load a file.
- Click **Parse Guide** to generate structured steps.

### Ask AI tab

- Ask contextual questions about the task/page.

### Config tab

- Set backend proxy URL.
- Test and save connection settings.

## Backend API Endpoints

- `GET /` - basic service check
- `GET /health` - health/config status
- `GET /api/health` - same health status for extension checks
- `POST /api/chat` - AI chat completion proxy
- `POST /api/test` - quick AI connectivity test
- `POST /api/resolve-target` - resolve element selector from DOM snapshot + step context

## Troubleshooting

- "Backend proxy is unreachable"
  - Ensure backend is running in `backend/` with `npm start`.
  - Verify side panel Config proxy URL is correct.
- "Server not configured"
  - Confirm `backend/.env` exists and includes `OPENAI_ENDPOINT` and `OPENAI_KEY`.
- Push blocked by GitHub secret scanning
  - Never commit real keys in tracked files.
  - Keep placeholders in `.env.example` and real values only in local `backend/.env`.

## Security Notes

- Do not store real API keys in source-controlled files.
- Keep sensitive credentials in local environment variables (`backend/.env`).
- Rotate keys immediately if accidentally exposed.

## Development

Backend scripts:

```bash
cd backend
npm start   # production-style run
npm run dev # watch mode
```

---

If you want, this README can be extended with screenshots, an architecture diagram, and contribution guidelines (`CONTRIBUTING.md`).
