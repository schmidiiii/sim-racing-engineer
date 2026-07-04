# Sim Racing Engineer

**iRacing telemetry analysis with AI coaching — desktop app for Windows**

Load your `.ibt` session files and immediately see what's happening across every lap: overlaid traces, brake zone comparison, lap delta, and an AI coach that gives you direct, data-driven feedback on your driving.

## Download

**[→ Download latest installer (.msi)](https://github.com/schmidiiii/sim-racing-engineer/releases/latest)**

Windows only. Just install and run — no Python, no Node, no setup required. The app auto-updates itself when new versions are released.

[![Latest Release](https://img.shields.io/github/v/release/schmidiiii/sim-racing-engineer?style=flat-square&label=Latest)](https://github.com/schmidiiii/sim-racing-engineer/releases/latest)
[![Windows](https://img.shields.io/badge/platform-Windows-blue?style=flat-square&logo=windows)](https://github.com/schmidiiii/sim-racing-engineer/releases/latest)

---

## Features

### Telemetry Viewer
Multi-lap overlays for 11 channel groups, each color-coded by lap:

| Tab | Channels |
|-----|----------|
| General | Throttle, Brake, Speed, Gear, G-Forces, Steering |
| Braking | Brake zone detection, entry speed, pressure profile |
| Ride Height | All 4 corners (mm) |
| Rake | Pitch & Roll |
| Wheel Speed | All 4 wheels |
| Wheel Spin | Slip angle & ratio |
| Shocks | Deflection per corner |
| Shocks Hist | Shock velocity histogram |
| Tyre Temp | L/M/R per corner |
| Tyre Pressure | Hot pressure per corner |
| Delta | Lap time delta vs. reference lap, sector splits |

### Track Map
Live SVG circuit map generated from GPS data. The cursor syncs to the chart crosshair so you always know exactly where on track you are. Colored by throttle, brake, or gear.

### Brake Analysis
Detects all brake zones per lap and overlays them on the track map. A comparison table shows the exact entry position (% of lap) and entry speed for each zone across all selected laps — with Δ showing whether you brake earlier or later than the reference lap.

### Lap Delta
Time delta chart across the full lap distance. See exactly where time is gained or lost between any two laps, with sector time breakdown.

### Setup Viewer
Reads the car setup embedded in the `.ibt` file and displays it alongside your telemetry. Compare setups across sessions.

### AI Coaching
An AI race engineer that analyzes your data and gives you direct, honest feedback. No filler, no generic advice — specific lap numbers, corner references, and concrete things to fix.

**Supported AI providers:**
- **Ollama** (local, free) — runs models on your own PC
- **OpenAI** — GPT-4o and others via API key
- **Google Gemini** — Gemini 1.5 Pro and others via API key

**10 languages:** English, Deutsch, Français, Español, Italiano, Português, Nederlands, Polski, Русский, 日本語, 中文

### Auto-Update
When a new version is released, a banner appears in the app. One click downloads and installs it silently.

---

## AI Setup

### Ollama (Free, runs locally)
1. Download and install [Ollama](https://ollama.com)
2. Open a terminal and run: `ollama serve`
3. Pull a model: `ollama pull llama3.1` (or any model you prefer)
4. In the app: **Settings → Ollama** → enter `http://localhost:11434` and the model name → **Load model**

Recommended models: `llama3.1`, `mistral`, `qwen2.5`

### OpenAI (GPT-4o etc.)
1. Create an account at [platform.openai.com](https://platform.openai.com)
2. Add billing credits at [platform.openai.com/settings/billing](https://platform.openai.com/settings/billing)
3. Generate an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
4. In the app: **Settings → OpenAI** → paste your key and model name (e.g. `gpt-4o-mini`) → **Load model**

> **Note:** A ChatGPT Plus subscription does **not** include API access. The API requires separate prepaid credits.

### Google Gemini
1. Go to [aistudio.google.com](https://aistudio.google.com) and create a free API key
2. In the app: **Settings → Gemini** → paste your key and model name (e.g. `gemini-1.5-flash`) → **Load model**

---

## How to Use

1. **Load a session** — click `+ Load file(s)…` in the sidebar and select one or more `.ibt` files, or point the app at your iRacing telemetry folder (`Documents\iRacing\telemetry`)
2. **Select laps** — check the laps you want to analyze in the sidebar (up to 5 at a time)
3. **Browse tabs** — switch between channel groups using the tab bar
4. **AI feedback** — select your AI provider in Settings, then switch to any tab — the AI coach automatically analyzes the current view and selected laps
5. **Ask questions** — type a specific question in the chat panel at any time

---

## Tech Stack

- **Frontend:** React + TypeScript + Tailwind CSS
- **Backend:** Rust (Tauri v2)
- **Charts:** Recharts
- **AI:** Ollama / OpenAI / Gemini (streaming SSE)
- **Telemetry parsing:** Custom Rust `.ibt` parser

---

## Build from Source

Requirements: [Node.js 20+](https://nodejs.org), [Rust](https://rustup.rs), [Tauri CLI](https://tauri.app/start/prerequisites/)

```bash
git clone https://github.com/schmidiiii/sim-racing-engineer.git
cd sim-racing-engineer
npm install
npm run tauri dev
```

To build the installer:
```bash
npm run tauri build
```

---

## License

MIT
