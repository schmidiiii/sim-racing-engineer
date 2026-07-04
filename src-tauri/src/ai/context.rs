use crate::ibt::{Session, LapStats};

pub fn build_analysis_prompt(session: &Session, stats: &[LapStats], language: &str) -> String {
    let lang_name = match language {
        "de" => "German (Deutsch)",
        "fr" => "French (Français)",
        "es" => "Spanish (Español)",
        "it" => "Italian (Italiano)",
        "pt" => "Portuguese (Português)",
        "nl" => "Dutch (Nederlands)",
        "pl" => "Polish (Polski)",
        "ru" => "Russian (Русский)",
        "ja" => "Japanese (日本語)",
        "zh" => "Chinese (中文)",
        _ => "English",
    };
    // Separate valid laps from out-laps
    let valid: Vec<&LapStats> = stats.iter().filter(|s| s.lap_time > 10.0).collect();
    let best_time = valid.iter().map(|s| s.lap_time).fold(f32::INFINITY, f32::min);
    let worst_time = valid.iter().map(|s| s.lap_time).fold(f32::NEG_INFINITY, f32::max);
    let avg_time = if valid.is_empty() {
        0.0
    } else {
        valid.iter().map(|s| s.lap_time).sum::<f32>() / valid.len() as f32
    };

    fn fmt(t: f32) -> String {
        if t <= 0.0 || t.is_infinite() { return "–".into(); }
        format!("{}:{:.3}", t as u32 / 60, t % 60.0)
    }

    let mut lap_lines = String::new();
    for s in &valid {
        let delta = s.lap_time - best_time;
        let delta_str = if delta < 0.001 { " (best)".into() } else { format!(" (+{:.3}s)", delta) };
        lap_lines.push_str(&format!("  Lap {}: {}{}\n", s.lap_number, fmt(s.lap_time), delta_str));

        // Key channel stats with iRacing units
        // Speed: m/s (multiply by 3.6 for km/h)
        // Throttle/Brake: 0.0–1.0 ratio
        // Gear: integer
        if let Some(spd) = s.channel_stats.get("Speed") {
            lap_lines.push_str(&format!(
                "    Speed: min {:.0} max {:.0} avg {:.0} km/h\n",
                spd.min * 3.6, spd.max * 3.6, spd.avg * 3.6
            ));
        }
        if let Some(thr) = s.channel_stats.get("Throttle") {
            lap_lines.push_str(&format!(
                "    Throttle: avg {:.0}% max {:.0}%\n",
                thr.avg * 100.0, thr.max * 100.0
            ));
        }
        if let Some(brk) = s.channel_stats.get("Brake") {
            lap_lines.push_str(&format!(
                "    Brake: avg {:.0}% max {:.0}%\n",
                brk.avg * 100.0, brk.max * 100.0
            ));
        }
        if let Some(gear) = s.channel_stats.get("Gear") {
            lap_lines.push_str(&format!(
                "    Gear: min {} max {}\n",
                gear.min as i32, gear.max as i32
            ));
        }
        if let Some(steer) = s.channel_stats.get("SteeringWheelAngle") {
            // radians → degrees
            lap_lines.push_str(&format!(
                "    Steering: max angle {:.1}°\n",
                steer.max.abs() * 57.2958
            ));
        }
    }

    format!(
        "IMPORTANT: Respond ONLY in {lang_name}. Do not use any other language.\n\
         \n\
         ## Session Telemetry — {track} | {car} | {date}\n\
         Valid laps: {n} | Best: {best} | Avg: {avg} | Worst: {worst} | Spread: {spread:.3}s\n\
         \n\
         ## Lap-by-Lap Data\n\
         {laps}\n\
         ## Task\n\
         Analyse this telemetry as the driver's personal race engineer. \
         Do NOT reference real-world lap times. Do NOT use filler praise like \"great job\" or \"well done\". \
         Be direct, data-driven, and constructively critical. Use motorsport vocabulary \
         (trail-braking, apex, throttle application, rotation, understeer, oversteer, track limits, minimum speed).\n\
         When referencing corners, use the OFFICIAL turn numbers for {track} from your knowledge, \
         combined with the corner name — e.g. \"T3 (Raidillon)\", \"T1 (La Source)\", \"T10 (Bruxelles)\". \
         If the official turn number is uncertain for a corner, use the corner name only.\n\
         \n\
         Respond in this exact structure — keep it tight and punchy:\n\
         \n\
         ## Reference Benchmark\n\
         Based ONLY on iRacing knowledge (not real-world), state the approximate fastest achievable lap \
         for a {car} at {track}. Note if uncertain. State the gap to driver's best ({best}).\n\
         \n\
         ## Session Snapshot\n\
         One sentence: overall pace and biggest consistency weakness from the numbers.\n\
         \n\
         ## 1. Braking & Entry\n\
         Bullet points on: brake point accuracy, trail-braking usage, minimum corner speed. \
         Reference specific lap numbers, turn numbers with names, and data values.\n\
         \n\
         ## 2. Apex & Exit\n\
         Bullet points on: throttle application timing, progressive vs. erratic gas pickup, \
         use of track limits at exit. Reference specific lap numbers, turn numbers with names, and data values.\n\
         \n\
         ## 3. Line & Balance\n\
         Bullet points on: understeer / oversteer indicators from steering angle and speed data, \
         consistency of line. Reference specific lap numbers, turn numbers with names, and data values.\n\
         \n\
         ## ⚑ Top Priority\n\
         The single most impactful thing to fix in the next stint. One sentence, no fluff.",
        lang_name = lang_name,
        track = session.track,
        car = session.car,
        date = session.date,
        n = valid.len(),
        best = fmt(best_time),
        avg = fmt(avg_time),
        worst = fmt(worst_time),
        spread = (worst_time - best_time).max(0.0),
        laps = lap_lines,
    )
}
