use crate::ibt::{Session, LapStats};

pub fn build_analysis_prompt(session: &Session, stats: &[LapStats]) -> String {
    let mut ctx = format!(
        "Track: {}\nCar: {}\nSession: {}\n\n",
        session.track, session.car, session.date
    );

    ctx.push_str("Lap summary:\n");
    for s in stats {
        ctx.push_str(&format!(
            "  Lap {}: {:.3}s{}\n",
            s.lap_number,
            s.lap_time,
            if s.lap_time < 10.0 { " (invalid/outlap)" } else { "" }
        ));
        for (ch, stat) in &s.channel_stats {
            ctx.push_str(&format!(
                "    {}: min={:.2} avg={:.2} max={:.2}\n",
                ch, stat.min, stat.avg, stat.max
            ));
        }
    }

    format!(
        "{}\n\nYou are an expert iRacing driving coach. \
         Analyze this telemetry session and give 3-5 specific, actionable coaching tips. \
         Focus on braking points, throttle application, and consistency between laps. \
         Be concise and direct.",
        ctx
    )
}
