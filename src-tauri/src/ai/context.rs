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
        "{}\n\nYou are an expert iRacing driving coach. Analyze this telemetry session.\n\n\
         Respond in this exact markdown format:\n\n\
         ## Session Overview\n\
         One sentence summary of the session quality.\n\n\
         ## Coaching Tips\n\
         For each tip use this format:\n\
         ### [Tip Title]\n\
         **What:** One sentence describing the issue.\n\
         **How to fix:** One concrete action.\n\
         **Data:** Reference a specific number from the telemetry.\n\n\
         Give 3-5 tips. Focus on: braking points, throttle application, consistency, lap delta.\n\
         Be direct and concise. No filler text.",
        ctx
    )
}
