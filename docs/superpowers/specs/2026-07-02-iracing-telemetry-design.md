# iRacing Telemetry Viewer — Design Spec
**Date:** 2026-07-02
**Status:** Approved

---

## Overview

A desktop application for viewing and analyzing iRacing IBT telemetry files. The app auto-loads the latest session from the iRacing telemetry folder, displays multi-lap overlays of all telemetry channels, renders a track map with data overlays, and provides AI-powered coaching feedback via local Ollama or external providers (OpenAI, Gemini).

**Target platform:** Windows (cross-platform support planned via Tauri)
**Tech stack:** Tauri (Rust backend) + React + TypeScript frontend

---

## Architecture

### Backend (Rust / Tauri)

**`ibt/`** — IBT Parser
- Reads the binary iRacing IBT format from disk
- Extracts: session metadata (track, car, date), channel definitions, and per-lap sample data at ~60Hz

**`session/`** — Session Manager
- Holds the currently loaded session(s) in memory
- File watcher: monitors `Documents/iRacing/telemetry/` for new `.ibt` files
- Tauri commands: `get_latest_session`, `load_session`, `watch_telemetry_folder`, `get_lap_data`

**`ai/`** — AI Service
- `AiProvider` trait: `chat(messages, context) → Stream<String>`
- Three providers: Ollama (localhost), OpenAI (REST), Gemini (REST)
- Context builder: converts session/lap stats into structured prompt

### Frontend (React + TypeScript)

**State:** Zustand for active session, selected laps, AI provider config

**Pages:** Viewer (main), Settings

**Components:** LapSidebar, TelemetryPanel (TabBar + TraceGroup + TrackMap), AiPanel (AutoFeedback + ChatThread)

---

## UI Design

**Theme:** Dark mode default, shadcn/ui + Tailwind

**Layout:** Three-column
```
┌──────────┬──────────────────────────────┬───────────────┐
│  Lap     │  [General][Setup][Wheel...]  │   AI Panel    │
│  List    │   Telemetry Traces           │  Auto-Analyse │
│  ☑ L1   │   (synchronized crosshair)   │  (streamed)   │
│  ☑ L2   │                              │  Chat input   │
│  [+Load] ├──────────────────────────────┤               │
│          │   Track Map + Data Overlay   │               │
└──────────┴──────────────────────────────┴───────────────┘
```

**Lap colors:** 8-color cycle, toggled via checkboxes

**Synchronized crosshair:** Hovering any trace updates a vertical line across all charts

**Track Map:** SVG from GPS (Lat/Lon) coordinates, color-coded by speed

---

## AI Integration

| Provider | Config |
|----------|--------|
| Ollama   | Base URL + model (auto-discovered) |
| OpenAI   | API key + model |
| Gemini   | API key + model |

**Auto-Analysis:** Triggered on session load, sends lap stats (not raw data) to AI, streams response

**Chat:** User questions with session context, maintains history

---

## IBT Format (verified)

- Header = 112 bytes, DiskSubHeader = 32 bytes at offset 112
- VarHeader = 144 bytes each
- `ver` = 2 in current iRacing files
- Data: `varBuf[0].bufOffset + recordIndex * bufLen`
- Key channels: SessionTime(double), Speed(float,m/s), Throttle, Brake, Gear, Lap(int), LapDistPct, LapLastLapTime, SteeringWheelAngle, Lat, Lon
- YAML: TrackDisplayName under WeekendInfo, CarScreenName under DriverInfo > Drivers

---

## Out of Scope (v1)

- Multi-user session comparison, video sync, setup export, cloud storage, mobile
