# Sim Racing Engineer

**iRacing telemetry analysis with a 3D replay and AI coaching — desktop app for Windows**

Load your `.ibt` session files and see what happened: overlaid traces across every lap, a 3D replay on the real circuit, the moments where something went wrong, and an AI race engineer that gives direct, data-driven feedback on your driving.

## Download

**[→ Download latest installer (.msi)](https://github.com/schmidiiii/sim-racing-engineer/releases/latest)**

Windows only. Just install and run — no Python, no Node, no setup required. The app auto-updates itself when new versions are released.

[![Latest Release](https://img.shields.io/github/v/release/schmidiiii/sim-racing-engineer?style=flat-square&label=Latest)](https://github.com/schmidiiii/sim-racing-engineer/releases/latest)
[![Windows](https://img.shields.io/badge/platform-Windows-blue?style=flat-square&logo=windows)](https://github.com/schmidiiii/sim-racing-engineer/releases/latest)

---

## The tabs

| Tab | What you see |
|-----|-------------|
| General | Speed, throttle, brake, gear, steering angle — with ABS drawn inside the brake trace |
| Delta | Time gained and lost across the lap, split at iRacing's own sector lines, plus a map of where it went |
| Laps | The whole session as a table: sectors, fuel, tyres, driver inputs, off-track excursions — and a fuel plan |
| Events | The handful of moments worth a second look: lockups, wheelspin, excursions, missed shifts |
| G-G | Lateral against longitudinal acceleration — how much of the tyre's grip is actually being used |
| Braking | Brake zone detection, entry position and speed, compared lap against lap |
| Corner Speed | Minimum speed through every corner, across all selected laps |
| Adjustments | Brake bias, ABS, traction control and throttle shape as the driver changed them |
| Setup | The car setup from the file, with a filter for the parameters that differ |
| Tyre Temp / Pressure | Per corner, three points across each tyre |
| Wheel Speed / Spin | Per wheel, with computed slip ratio |
| Ride Height / Rake / Shocks | Suspension, per corner |

---

## Features

### 3D replay
Watch the lap back on the circuit. Chase, hood, front and TV cameras. The car sits on the road, leans with the banking, and its wheels turn at their own measured speeds — a locked wheel actually stops.

The driving line can be coloured three ways: one colour per lap, by throttle and brake, or by where time is being gained and lost.

Alongside it: tyre temperatures and tread per corner, ABS and wheelspin lamps, live weather and track conditions from the session, sun position taken from the session clock — and moonlight after dark.

### Real track geometry
Thirteen circuits are drawn from stored geometry rather than from your driving line, so the road is where the road is and you can see a car take a kerb or run wide.

Road Atlanta · Road America · Spa-Francorchamps (GP and Endurance) · Hockenheimring · Silverstone Arena GP · Red Bull Ring · Watkins Glen Classic · Imola · Okayama · Winton · Summit Point · Nordschleife VLN

Everywhere else the road is still built around the driving line, which works but always shows the car in the middle of it.

### Lap table and fuel plan
One row per lap: sector splits at iRacing's real sector lines, fuel burned and left, tyre temperature, pressure and tread per corner, the share of the lap at full throttle, on the brakes, on neither and on both, steering corrections, off-track excursions, track and air temperature. Columns are grouped and can be switched off; the whole table exports to CSV.

Out-laps and in-laps are told apart and kept out of the pace figures — an in-lap is driven flat out and only ends in the pits.

Give it a race length in laps or minutes and it works out the fuel needed, the laps a tank lasts, how many stops that means and which lap each falls on, with the lap the tank runs dry beside it.

### Event log
A session reduced to the moments that matter. Clicking one selects that lap, jumps to a second before it happened and plays it back. The tab also surfaces the places you keep hitting — the same corner exit spinning up the rear in three separate laps.

Thresholds were measured against real telemetry rather than guessed: wheel slip below −12 % finds two lockups across a GT3 stint and twelve in a quarter of an hour of Formula Vee, which is what driving one is like.

### G-G diagram
Lateral against longitudinal acceleration, one cloud per lap. A cross means braking, turning and accelerating happen one after another; a filled round cloud means they overlap. A toggle splits it into the nine regions and gives the share of the lap spent in each.

### Track map
Circuit map generated from GPS. The cursor follows the chart crosshair, so you always know where on track you are. Coloured by throttle, brake or gear.

### Consistency
Shown in the sidebar when two or more laps are selected: a percentage from the spread of lap times, with the best lap and the ideal lap built from your best sectors.

### AI coaching
An AI race engineer that reads your data and answers directly — specific lap numbers, specific corners, concrete things to fix.

**Providers:** Ollama (local, free) · OpenAI · Google Gemini

**11 languages:** English, Deutsch, Français, Español, Italiano, Português, Nederlands, Polski, Русский, 日本語, 中文

### Units
Metric or imperial throughout. The CSV export always writes SI, whatever the display is set to.

### Auto-update
When a new version is released, a banner appears in the app. One click downloads and installs it.

---

## AI Setup

### Ollama (free, runs locally)
1. Download and install [Ollama](https://ollama.com)
2. Open a terminal and run: `ollama serve`
3. Pull a model: `ollama pull llama3.1` (or any model you prefer)
4. In the app: **Settings → Ollama** → enter `http://localhost:11434` and the model name → **Load model**

Recommended models: `llama3.1`, `mistral`, `qwen2.5`

### OpenAI
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

1. **Load a session** — click `+ Load file(s)…` in the sidebar and select one or more `.ibt` files, or let the app pick up new files from your iRacing telemetry folder (`Documents\iRacing\telemetry`) as they appear
2. **Select laps** — click the laps you want to compare in the sidebar (up to 5 at a time)
3. **Browse tabs** — switch between them in the tab bar, or with `[` and `]`
4. **Watch it back** — press `L` for the full-screen replay
5. **AI feedback** — choose a provider in Settings; the coach reads whichever view you are on
6. **Ask questions** — type into the chat panel at any time

---

## Tech Stack

- **Frontend:** React + TypeScript + Tailwind CSS
- **Backend:** Rust (Tauri v2)
- **3D:** three.js
- **Charts:** custom canvas renderers, plus Recharts for the corner speed bars
- **AI:** Ollama / OpenAI / Gemini (streaming SSE)
- **Telemetry parsing:** custom Rust `.ibt` parser

### Track geometry

The stored circuits are built by the scripts in [`scripts/`](scripts/) from OpenStreetMap ways and the [TUM racetrack database](https://github.com/TUMFTM/racetrack-database), fitted to a real driven lap and checked against it. The check is whether the car stays inside the width stored for that spot, not how close the driven line is to the middle — a racing line is supposed to leave the middle.

iRacing's own track files are encrypted and are not used.
