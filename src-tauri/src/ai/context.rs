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

    let address_note = if language == "de" {
        "Du redest den Fahrer direkt an — verwende \"du\" (niemals \"Sie\" oder \"der Fahrer\"). Beispiel: \"Du bremst zu spät in der letzten Schikane\", nicht \"Der Fahrer bremst...\". "
    } else {
        "Address the driver directly as \"you\" — never say \"the driver\" or refer to them in third person. Example: \"You brake too late at the final chicane\", not \"The driver brakes...\". "
    };

    format!(
        "IMPORTANT: Respond ONLY in {lang_name}. Do not use any other language.\n\
         {address_note}\n\
         \n\
         ## Session Telemetry — {track} | {car} | {date}\n\
         Valid laps: {n} | Best: {best} | Avg: {avg} | Worst: {worst} | Spread: {spread:.3}s\n\
         \n\
         ## Lap-by-Lap Data\n\
         {laps}\n\
         ## Task\n\
         You are a personal race engineer giving direct, blunt feedback to the driver. \
         Do NOT reference real-world lap times. Do NOT use filler phrases like \"great job\", \"well done\", or \"interesting\". \
         Start immediately with the point. Be specific: reference lap numbers and data values. \
         Use motorsport vocabulary (trail-braking, apex, throttle application, rotation, understeer, oversteer, track limits, minimum speed).\n\
         NEVER invent or use corner names or turn numbers from your training data memory (e.g. \"Raidillon\", \"Parabolica\", \"Acque Minerali\", \"T3\", \"T10\"). \
         You have no real-time track map data. Describe corners only by their character: \
         \"the first heavy braking zone\", \"the fast mid-sector sweeper\", \"the tight hairpin at the end of the straight\". \
         If the driver explicitly names a corner in their message, you may use it.\n\
         \n\
         NEVER invent or guess lap time targets or benchmark times — you do not have reliable iRacing lap time data. \
         NEVER fabricate specific numbers (speeds in km/h, time gaps, percentages) that are not explicitly in this prompt. \
         Focus exclusively on the driver's actual data.\n\
         \n\
         Respond in this exact structure — keep it tight and punchy:\n\
         \n\
         ## Session Snapshot\n\
         One sentence: your overall pace and biggest consistency weakness from the numbers.\n\
         \n\
         ## 1. Braking & Entry\n\
         Bullet points on: your brake point accuracy, trail-braking usage, minimum corner speed. \
         Reference specific lap numbers and data values. Describe corners by character, not by name.\n\
         \n\
         ## 2. Apex & Exit\n\
         Bullet points on: your throttle application timing, progressive vs. erratic gas pickup, \
         use of track limits at exit. Reference specific lap numbers and data values.\n\
         \n\
         ## 3. Line & Balance\n\
         Bullet points on: understeer / oversteer indicators from your steering angle and speed data, \
         consistency of your line. Reference specific lap numbers and data values.\n\
         \n\
         ## ⚑ Top Priority\n\
         The single most impactful thing you need to fix in the next stint. One sentence, no fluff.",
        lang_name = lang_name,
        address_note = address_note,
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
