# Sim Racing Engineer

A desktop app for iRacing telemetry analysis — built with Tauri, React, and Rust.

Load your `.ibt` session files and get a clear picture of every lap: overlaid telemetry traces, a live track map, braking analysis, lap deltas, and AI-powered coaching feedback. The app watches your iRacing telemetry folder and picks up new sessions automatically.


---

## Features

- **Telemetry viewer** — multi-lap overlays for all channels (throttle, brake, speed, gear, lateral/longitudinal G, etc.), grouped and color-coded by lap
- **Track map** — SVG map of the circuit with a crosshair cursor synced to the chart, colored by speed or braking zone
- **Brake analysis** — per-corner entry speed, brake pressure, and release profile across laps
- **Lap delta** — compare any two laps time-by-time across the circuit
- **AI coaching** — ask questions about your data or get automatic post-session analysis; works with Ollama (local), OpenAI, or Gemini
- **Auto-update** — the app notifies you when a new version is available and installs it in one click

---

## Download

Grab the latest installer from the [Releases](https://github.com/schmidiiii/sim-racing-engineer/releases/latest) page.

