use std::fs;
use std::path::Path;
use crate::ibt::binary::*;
use crate::ibt::types::*;

pub struct IbtFile {
    data: std::sync::Arc<Vec<u8>>,
    pub header: IbtHeader,
    pub disk_header: DiskSubHeader,
    pub var_headers: Vec<VarHeader>,
}

impl IbtFile {
    pub fn from_bytes(data: std::sync::Arc<Vec<u8>>) -> Result<Self, String> {
        if data.len() < 144 {
            return Err("Data too small to be a valid IBT file".into());
        }
        let header: IbtHeader = unsafe { read_struct(&data, 0) };
        if header.ver < 1 || header.ver > 3 {
            return Err(format!("Unexpected IBT version {}", header.ver));
        }
        let disk_header: DiskSubHeader = unsafe { read_struct(&data, 112) };
        let vh_offset = header.var_header_offset as usize;
        let num_vars = header.num_vars as usize;
        let required = vh_offset + num_vars * 144;
        if required > data.len() {
            return Err(format!(
                "Data too small for {} var headers (need {} bytes, have {})",
                num_vars, required, data.len()
            ));
        }
        let var_headers: Vec<VarHeader> = (0..num_vars)
            .map(|i| unsafe { read_struct(&data, vh_offset + i * 144) })
            .collect();
        Ok(IbtFile { data, header, disk_header, var_headers })
    }

    #[allow(dead_code)]
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let data = fs::read(&path).map_err(|e| e.to_string())?;
        Self::from_bytes(std::sync::Arc::new(data))
    }

    pub fn channels(&self) -> Vec<Channel> {
        let mut out: Vec<Channel> = self.var_headers.iter().map(|vh| Channel {
            name: cstr_to_string(&vh.name),
            description: cstr_to_string(&vh.desc),
            unit: cstr_to_string(&vh.unit),
            var_type: VarType::from_i32(vh.var_type)
                .map(|t| format!("{:?}", t))
                .unwrap_or_else(|| format!("Unknown({})", vh.var_type)),
        }).collect();

        // Inject computed slip-ratio channels when wheel-speed channels exist
        let has_speed = self.find_var("Speed").is_some();
        if has_speed {
            for corner in &["LF", "RF", "LR", "RR"] {
                if self.find_var(&format!("{}speed", corner)).is_some() {
                    out.push(Channel {
                        name: format!("{}slipRatio", corner),
                        description: format!("{} slip ratio (computed)", corner),
                        unit: "%".into(),
                        var_type: "Float".into(),
                    });
                }
            }
        }
        out
    }

    pub fn session_info_yaml(&self) -> String {
        let start = self.header.session_info_offset as usize;
        let len = self.header.session_info_len as usize;
        if start + len > self.data.len() {
            return String::new();
        }
        decode_session_text(&self.data[start..start + len])
            .trim_end_matches('\0')
            .to_string()
    }

    pub fn find_var(&self, name: &str) -> Option<&VarHeader> {
        self.var_headers.iter().find(|vh| cstr_to_string(&vh.name) == name)
    }

    /// Read one value from record `record_idx` for the given var, returned as f64.
    pub fn read_f64(&self, record_idx: usize, vh: &VarHeader) -> f64 {
        let buf_start = self.header.var_buf[0].buf_offset as usize;
        let rec_start = buf_start + record_idx * self.header.buf_len as usize;
        let off = rec_start + vh.offset as usize;

        match VarType::from_i32(vh.var_type) {
            Some(VarType::Float) => {
                if off + 4 > self.data.len() { return 0.0; }
                f32::from_le_bytes(self.data[off..off + 4].try_into().unwrap_or([0; 4])) as f64
            }
            Some(VarType::Double) => {
                if off + 8 > self.data.len() { return 0.0; }
                f64::from_le_bytes(self.data[off..off + 8].try_into().unwrap_or([0; 8]))
            }
            Some(VarType::Int) | Some(VarType::BitField) => {
                if off + 4 > self.data.len() { return 0.0; }
                i32::from_le_bytes(self.data[off..off + 4].try_into().unwrap_or([0; 4])) as f64
            }
            Some(VarType::Bool) | Some(VarType::Char) => {
                if off >= self.data.len() { return 0.0; }
                self.data[off] as f64
            }
            None => 0.0,
        }
    }

    pub fn parse_session(&self, file_path: String) -> Result<Session, String> {
        let record_count = self.disk_header.session_record_count as usize;

        let lap_var = self.find_var("Lap")
            .ok_or("Missing 'Lap' channel")?;
        let llt_var = self.find_var("LapLastLapTime");

        let lap_nums: Vec<i32> = (0..record_count)
            .map(|i| self.read_f64(i, lap_var) as i32)
            .collect();

        let segments = split_by_lap(&lap_nums);

        let laps: Vec<Lap> = segments.iter().map(|&(lap_num, start, end)| {
            // `LapLastLapTime` is STALE at the segment boundary — it still holds the
            // *previous* lap's time and only settles to THIS lap's official time a
            // fraction of a second into the next segment. Reading it at `end` therefore
            // shifts every lap's time one segment off from its telemetry data. Instead we
            // scan forward from `end` for the first change: that settled value is the
            // official time of the lap this segment represents (LapDistPct 0→1).
            let lap_time = if let Some(v) = llt_var {
                let boundary = self.read_f64(end.min(record_count.saturating_sub(1)), v) as f32;
                let scan_end = (end + self.header.tick_rate as usize * 3).min(record_count);
                let mut settled = 0.0f32;
                for i in end..scan_end {
                    let cur = self.read_f64(i, v) as f32;
                    if (cur - boundary).abs() > 0.01 && cur > 0.0 {
                        settled = cur;
                        break;
                    }
                }
                settled
            } else {
                0.0
            };

            // Require at least 20% of expected samples — filters recording-started-mid-lap artefacts
    let sample_count = end.saturating_sub(start);
    let min_samples = if self.header.tick_rate > 0 && lap_time > 0.0 {
        (lap_time * self.header.tick_rate as f32 * 0.20) as usize
    } else {
        0
    };
    let is_valid = lap_time > 10.0 && sample_count >= min_samples;

    Lap {
                // iRacing's `Lap` channel is 0-indexed at the out-lap; standard IBT
                // viewers display laps 1-indexed. +1 makes our numbering match them.
                lap_number: lap_num + 1,
                lap_time,
                is_valid,
                start_sample: start,
                end_sample: end,
            }
        }).collect();

        let yaml = self.session_info_yaml();
        let track = extract_yaml_field(&yaml, "TrackDisplayName")
            .unwrap_or_else(|| "Unknown Track".into());
        let track_id = extract_yaml_field(&yaml, "TrackID")
            .and_then(|v| v.trim().parse::<i32>().ok());
        let driver = extract_driver_name(&yaml);
        let car = extract_driver_car_name(&yaml)
            .unwrap_or_else(|| "Unknown Car".into());
        let date = chrono::DateTime::from_timestamp(self.disk_header.session_start_date, 0)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "Unknown".into());

        Ok(Session {
            id: uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, file_path.as_bytes()).to_string(),
            file_path,
            track,
            track_id,
            driver,
            car,
            date,
            tick_rate: self.header.tick_rate,
            record_count: self.disk_header.session_record_count,
            laps,
            available_channels: self.channels(),
        })
    }

    pub fn get_lap_channel_data(&self, lap: &Lap, channel: &str) -> Option<LapChannelData> {
        self.get_lap_channel_data_strided(lap, channel, 1)
    }

    /// `stride` > 1 returns every n-th sample. Slow-moving channels can be
    /// thinned this way, which keeps long laps off the IPC bridge: a 26k-sample
    /// lap at stride 10 is 2.6k values instead.
    pub fn get_lap_channel_data_strided(&self, lap: &Lap, channel: &str, stride: usize) -> Option<LapChannelData> {
        let st_var = self.find_var("SessionTime")?;
        let ldp_var = self.find_var("LapDistPct");
        let total = self.disk_header.session_record_count as usize;
        let seg_start = lap.start_sample;
        let seg_end = lap.end_sample.min(total);

        let step = stride.max(1);
        let lap_dist_pct: Vec<f64> = match ldp_var {
            Some(v) => (seg_start..seg_end).step_by(step).map(|i| self.read_f64(i, v)).collect(),
            None => (0..(seg_end - seg_start)).step_by(step)
                .map(|i| i as f64 / (seg_end - seg_start).max(1) as f64).collect(),
        };

        // Computed slip-ratio channels: e.g. "LFslipRatio" → (LFspeed - Speed) / Speed * 100
        if let Some(corner) = channel.strip_suffix("slipRatio") {
            let speed_var = self.find_var("Speed")?;
            let wheel_var = self.find_var(&format!("{}speed", corner))?;
            let t0 = self.read_f64(seg_start, st_var);
            let samples: Vec<f64> = (seg_start..seg_end).step_by(step).map(|i| {
                let car_spd = self.read_f64(i, speed_var);
                let whl_spd = self.read_f64(i, wheel_var);
                if car_spd > 0.5 { (whl_spd - car_spd) / car_spd * 100.0 } else { 0.0 }
            }).collect();
            let timestamps: Vec<f64> = (seg_start..seg_end).step_by(step)
                .map(|i| self.read_f64(i, st_var) - t0)
                .collect();
            return Some(LapChannelData {
                lap_number: lap.lap_number, channel: channel.to_string(),
                samples, timestamps, lap_dist_pct,
            });
        }

        let ch_var = self.find_var(channel)?;
        let t0 = self.read_f64(seg_start, st_var);

        let samples: Vec<f64> = (seg_start..seg_end).step_by(step)
            .map(|i| self.read_f64(i, ch_var))
            .collect();
        let timestamps: Vec<f64> = (seg_start..seg_end).step_by(step)
            .map(|i| self.read_f64(i, st_var) - t0)
            .collect();

        Some(LapChannelData {
            lap_number: lap.lap_number,
            channel: channel.to_string(),
            samples,
            timestamps,
            lap_dist_pct,
        })
    }

    /// One summary per lap, from a single walk through the buffer.
    ///
    /// The obvious implementation asks `get_lap_channel_data` for twenty-odd
    /// channels per lap, which re-reads the file once per channel per lap. A
    /// thirty-lap stint would touch the buffer six hundred times for data that
    /// is all sitting in the same record. Here the record is read once and
    /// every accumulator takes what it needs from it.
    pub fn lap_summaries(&self, laps: &[Lap]) -> Vec<LapSummary> {
        const CORNERS: [&str; 4] = ["LF", "RF", "LR", "RR"];
        // Pedal travel below this is the pedal resting, not the driver using it
        const PEDAL: f64 = 0.05;
        // A wheel dropping over a kerb is not an excursion. Four tenths of a
        // second off is.
        const OFF_MIN_S: f64 = 0.4;
        // Movement smaller than this is the wheel breathing in the driver's
        // hands. Measured on a lap of Imola: a one-degree deadband counts 121
        // reversals a minute, which is the noise floor rather than the driver.
        // Five degrees is the usual figure in telemetry work and lands at 57.
        const STEER_DEADBAND: f64 = 0.087; // radians, 5 degrees

        let sectors = self.sector_starts();
        let total = self.disk_header.session_record_count as usize;

        let st = self.find_var("SessionTime");
        let pct = self.find_var("LapDistPct");
        let spd = self.find_var("Speed");
        let thr = self.find_var("Throttle");
        let brk = self.find_var("Brake");
        let steer = self.find_var("SteeringWheelAngle");
        let fuel = self.find_var("FuelLevel");
        let surf = self.find_var("PlayerTrackSurface");
        let pit = self.find_var("OnPitRoad");
        let ttemp = self.find_var("TrackTemp");
        let atemp = self.find_var("AirTemp");
        let tyre: Vec<_> = CORNERS.iter().map(|c| (
            self.find_var(&format!("{}tempCL", c)),
            self.find_var(&format!("{}tempCM", c)),
            self.find_var(&format!("{}tempCR", c)),
            self.find_var(&format!("{}wearL", c)),
            self.find_var(&format!("{}wearM", c)),
            self.find_var(&format!("{}wearR", c)),
            self.find_var(&format!("{}pressure", c)),
        )).collect();

        let get = |i: usize, v: Option<&VarHeader>| v.map(|v| self.read_f64(i, v)).unwrap_or(0.0);

        laps.iter().map(|lap| {
            let start = lap.start_sample.min(total);
            let end = lap.end_sample.min(total);
            let n = end.saturating_sub(start);

            let mut s = LapSummary {
                lap_number: lap.lap_number,
                lap_time: lap.lap_time,
                is_valid: lap.is_valid,
                pit_time: 0.0,
                out_lap: false,
                in_lap: false,
                sectors: Vec::new(),
                fuel_used: 0.0,
                fuel_left: 0.0,
                max_speed: 0.0,
                avg_speed: 0.0,
                throttle_full_pct: 0.0,
                braking_pct: 0.0,
                coasting_pct: 0.0,
                overlap_pct: 0.0,
                max_brake: 0.0,
                steering_reversals: 0.0,
                off_track: 0,
                tyres: Vec::new(),
                track_temp: 0.0,
                air_temp: 0.0,
            };
            if n == 0 { return s; }

            let t0 = get(start, st);
            let t_end = get(end - 1, st);
            let duration = (t_end - t0).max(0.0);

            // Where the timed lap actually begins. The segment runs from one
            // change of the `Lap` counter to the next, which is the line to
            // within a tick on every lap but the first timed one: measured on a
            // Nürburgring stint, lap 2's segment opens 1.74 s before its lap
            // time starts, because the session's opening segment ends late.
            // Anchoring on the end — which `LapCurrentLapTime` confirms sits on
            // the line — makes the sectors add up to the lap they belong to.
            let lap_start_t = if lap.lap_time > 10.0 && duration > lap.lap_time as f64 {
                t_end - lap.lap_time as f64
            } else {
                t0
            };

            // Sector boundaries are crossings, not buckets: taking the first and
            // last sample inside a sector drops the fraction of a tick either
            // side of the line, and five sectors would lose a tenth over a lap.
            let mut crossings: Vec<f64> = vec![lap_start_t];
            let mut next = 1usize; // sector 0 starts at the line
            let mut prev_pct = get(start, pct);
            let mut prev_t = t0;

            let (mut full, mut braking, mut coasting, mut overlap) = (0usize, 0usize, 0usize, 0usize);
            let mut speed_sum = 0.0;
            let mut steer_dir = 0i8;
            let mut steer_extreme = get(start, steer);
            let mut reversals = 0usize;
            let mut off_run = 0usize;
            let (mut pit_samples, mut pit_first, mut pit_last) = (0usize, None::<usize>, None::<usize>);
            let ticks_per_s = if duration > 0.0 { n as f64 / duration } else { 60.0 };

            for i in start..end {
                let t = get(i, st);
                let p = get(i, pct);
                let on_pit = get(i, pit) > 0.5;
                if on_pit {
                    pit_samples += 1;
                    if pit_first.is_none() { pit_first = Some(i); }
                    pit_last = Some(i);
                }

                // Crossing a sector line. `p - prev_pct` guards the wrap at the
                // start/finish line, where pct jumps from ~1 back to ~0.
                while next < sectors.len() && p >= sectors[next] && p - prev_pct < 0.5 && p > prev_pct {
                    let span = (p - prev_pct).max(1e-9);
                    let f = (sectors[next] - prev_pct) / span;
                    crossings.push((prev_t + (t - prev_t) * f).max(lap_start_t));
                    next += 1;
                }
                prev_pct = p;
                prev_t = t;

                let v = get(i, spd);
                speed_sum += v;
                if v > s.max_speed { s.max_speed = v; }

                let th = get(i, thr);
                let br = get(i, brk);
                if br > s.max_brake { s.max_brake = br; }
                if th >= 0.98 { full += 1; }
                if br > PEDAL { braking += 1; }
                if br > PEDAL && th > PEDAL { overlap += 1; }
                if br <= PEDAL && th <= PEDAL { coasting += 1; }

                // A reversal is a direction change that actually went somewhere.
                // Everything is measured against the extreme the wheel last
                // reached, not against the previous sample: a turn back only
                // counts once it has travelled past the deadband, so a wheel
                // trembling on the straight never registers.
                let a = get(i, steer);
                let d = a - steer_extreme;
                if d.abs() > 1e-9 {
                    let dir: i8 = if d > 0.0 { 1 } else { -1 };
                    if dir != steer_dir {
                        if steer_dir == 0 {
                            steer_dir = dir;
                            steer_extreme = a;
                        } else if d.abs() > STEER_DEADBAND {
                            reversals += 1;
                            steer_dir = dir;
                            steer_extreme = a;
                        }
                    } else {
                        steer_extreme = a;
                    }
                }

                // TrkLoc: 0 is off track, 3 is on it. Pit entry reports off
                // track on the way in, which is not a mistake.
                if get(i, surf) < 0.5 && !on_pit {
                    off_run += 1;
                } else {
                    if off_run as f64 / ticks_per_s >= OFF_MIN_S { s.off_track += 1; }
                    off_run = 0;
                }
            }
            if off_run as f64 / ticks_per_s >= OFF_MIN_S { s.off_track += 1; }

            s.pit_time = pit_samples as f64 / ticks_per_s;
            let fifth = n / 5;
            s.out_lap = pit_first.map(|i| i - start <= fifth).unwrap_or(false);
            s.in_lap = pit_last.map(|i| end - 1 - i <= fifth).unwrap_or(false);

            crossings.push(t_end);
            if crossings.len() > 2 {
                s.sectors = crossings.windows(2).map(|w| w[1] - w[0]).collect();
            }

            let nf = n as f64;
            s.avg_speed = speed_sum / nf;
            s.throttle_full_pct = full as f64 / nf * 100.0;
            s.braking_pct = braking as f64 / nf * 100.0;
            s.coasting_pct = coasting as f64 / nf * 100.0;
            s.overlap_pct = overlap as f64 / nf * 100.0;
            s.steering_reversals = if duration > 0.0 { reversals as f64 / duration * 60.0 } else { 0.0 };

            s.fuel_left = get(end - 1, fuel);
            // Refuelling makes the difference negative; report nothing rather
            // than a negative burn.
            s.fuel_used = (get(start, fuel) - s.fuel_left).max(0.0);
            s.track_temp = get(end - 1, ttemp);
            s.air_temp = get(end - 1, atemp);

            s.tyres = CORNERS.iter().zip(tyre.iter()).map(|(c, v)| TyreState {
                corner: c.to_string(),
                temp_l: get(end - 1, v.0),
                temp_m: get(end - 1, v.1),
                temp_r: get(end - 1, v.2),
                wear: (get(end - 1, v.3) + get(end - 1, v.4) + get(end - 1, v.5)) / 3.0,
                pressure: get(end - 1, v.6),
            }).collect();

            s
        }).collect()
    }

    /// Where iRacing puts the sector lines, as fractions of a lap. Sessions
    /// without a `SplitTimeInfo` block get no sectors rather than invented ones.
    fn sector_starts(&self) -> Vec<f64> {
        let yaml = self.session_info_yaml();
        let Some(block) = yaml.split("SplitTimeInfo:").nth(1) else { return vec![] };
        let mut out = Vec::new();
        for line in block.lines() {
            let t = line.trim();
            if let Some(v) = t.strip_prefix("SectorStartPct:") {
                if let Ok(f) = v.trim().parse::<f64>() { out.push(f); }
            } else if !t.is_empty()
                && !t.starts_with("Sectors:")
                && !t.starts_with("- SectorNum:")
                && !t.starts_with("SectorNum:")
            {
                break; // out of the block and into whatever follows it
            }
        }
        out.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out
    }

    pub fn compute_lap_stats(
        &self,
        lap: &Lap,
        channels: &[&str],
    ) -> LapStats {
        use std::collections::HashMap;
        let mut channel_stats = HashMap::new();
        for &ch in channels {
            if let Some(data) = self.get_lap_channel_data(lap, ch) {
                let n = data.samples.len() as f64;
                if n == 0.0 { continue; }
                let min = data.samples.iter().cloned().fold(f64::INFINITY, f64::min);
                let max = data.samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let avg = data.samples.iter().sum::<f64>() / n;
                channel_stats.insert(ch.to_string(), ChannelStat { min, max, avg });
            }
        }
        LapStats {
            lap_number: lap.lap_number,
            lap_time: lap.lap_time,
            channel_stats,
        }
    }
}

/// Returns (lap_number, start_record_inclusive, end_record_exclusive) for each lap
pub fn split_by_lap(lap_nums: &[i32]) -> Vec<(i32, usize, usize)> {
    if lap_nums.is_empty() { return vec![]; }
    let mut result = Vec::new();
    let mut cur = lap_nums[0];
    let mut start = 0usize;
    for (i, &n) in lap_nums.iter().enumerate() {
        if n != cur {
            result.push((cur, start, i));
            cur = n;
            start = i;
        }
    }
    result.push((cur, start, lap_nums.len()));
    result
}

pub fn extract_yaml_field(yaml: &str, key: &str) -> Option<String> {
    yaml.lines()
        .find(|line| line.trim_start().starts_with(key))
        .and_then(|line| line.splitn(2, ':').nth(1))
        .map(|v| v.trim().trim_matches('"').to_string())
}

/// Extract the user's own car name by matching DriverCarIdx → Drivers[N].CarScreenName.
/// Falls back to the first non-safety CarScreenName if the index lookup fails.
/// The driver's own name, taken from the same block as their car. Everyone in
/// the session is listed, so it has to be the entry matching DriverCarIdx —
/// picking the first would name whoever happened to be first on the grid.
fn extract_driver_name(yaml: &str) -> Option<String> {
    extract_driver_field(yaml, "UserName")
}

fn extract_driver_car_name(yaml: &str) -> Option<String> {
    extract_driver_field(yaml, "CarScreenName").or_else(|| {
        // Fallback: first car name that isn't the pace or safety car
        yaml.lines()
            .filter(|l| l.trim().starts_with("CarScreenName:"))
            .find_map(|l| {
                let v = l.splitn(2, ':').nth(1)?.trim().trim_matches('"').to_string();
                if v.is_empty() || v.to_lowercase().starts_with("safety ") { None } else { Some(v) }
            })
    })
}

fn extract_driver_field(yaml: &str, field: &str) -> Option<String> {
    let driver_idx: usize = extract_yaml_field(yaml, "DriverCarIdx")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // In the Drivers list each entry starts with "- CarIdx: N" (the YAML list dash).
    // Results sections (ResultsPositions etc.) have CarIdx as a non-first key so they
    // appear WITHOUT the dash after trimming — this lets us skip them entirely.
    let list_entry = format!("- CarIdx: {}", driver_idx);
    let is_exact_entry = |s: &str| -> bool {
        if !s.starts_with(&list_entry) { return false; }
        let rest = &s[list_entry.len()..];
        rest.is_empty() || !rest.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false)
    };

    let mut in_driver_block = false;
    for line in yaml.lines() {
        let trimmed = line.trim();

        if is_exact_entry(trimmed) {
            in_driver_block = true;
        }

        if in_driver_block {
            if let Some(rest) = trimmed.strip_prefix(field).and_then(|r| r.strip_prefix(':')) {
                let v = rest.trim().trim_matches('"').to_string();
                return if v.is_empty() { None } else { Some(v) };
            }
            // Next driver entry starts → we've passed our block
            if trimmed.starts_with("- CarIdx:") && !is_exact_entry(trimmed) {
                break;
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_FILE: &str =
        r"C:\Users\schmi\Documents\iRacing\telemetry\ferrari296gt3_oulton international 2026-04-05 00-02-28.ibt";

    fn open_test_file() -> Option<IbtFile> {
        if !Path::new(TEST_FILE).exists() { return None; }
        Some(IbtFile::open(TEST_FILE).expect("should open"))
    }

    #[test]
    fn open_bad_path_errors() {
        assert!(IbtFile::open("does_not_exist.ibt").is_err());
    }

    #[test]
    fn open_real_file_parses_header() {
        let Some(f) = open_test_file() else { return };
        assert_eq!(f.header.tick_rate, 60);
        assert!(f.header.num_vars > 100);
        assert!(f.disk_header.session_lap_count > 0);
    }

    #[test]
    fn channels_include_speed_and_throttle() {
        let Some(f) = open_test_file() else { return };
        let names: Vec<_> = f.channels().iter().map(|c| c.name.clone()).collect();
        assert!(names.contains(&"Speed".to_string()));
        assert!(names.contains(&"Throttle".to_string()));
        assert!(names.contains(&"Lap".to_string()));
    }

    #[test]
    fn yaml_contains_track_name() {
        let Some(f) = open_test_file() else { return };
        let yaml = f.session_info_yaml();
        assert!(yaml.contains("TrackDisplayName"));
        assert!(yaml.contains("Oulton"));
    }

    #[test]
    fn read_f64_returns_session_time() {
        let Some(f) = open_test_file() else { return };
        let vh = f.find_var("SessionTime").expect("SessionTime must exist");
        let t0 = f.read_f64(0, vh);
        let t1 = f.read_f64(1, vh);
        assert!(t1 > t0, "session time must increase: {} not > {}", t0, t1);
    }

    #[test]
    fn split_two_laps() {
        let laps = split_by_lap(&[0, 0, 0, 1, 1]);
        assert_eq!(laps.len(), 2);
        assert_eq!(laps[0], (0i32, 0usize, 3usize));
        assert_eq!(laps[1], (1i32, 3usize, 5usize));
    }

    #[test]
    fn split_empty() {
        assert_eq!(split_by_lap(&[]), vec![]);
    }

    #[test]
    fn parse_session_extracts_track_and_car() {
        let Some(f) = open_test_file() else { return };
        let s = f.parse_session(TEST_FILE.to_string()).unwrap();
        assert!(s.track.contains("Oulton"), "track={}", s.track);
        assert!(s.car.contains("Ferrari"), "car={}", s.car);
        assert!(!s.laps.is_empty());
    }

    #[test]
    fn get_lap_channel_data_returns_speed() {
        let Some(f) = open_test_file() else { return };
        let s = f.parse_session(TEST_FILE.to_string()).unwrap();
        let lap = &s.laps[0];
        let data = f.get_lap_channel_data(lap, "Speed").expect("Speed must exist");
        assert!(!data.samples.is_empty());
        assert!(data.samples.iter().all(|&v| v >= 0.0), "speed should be non-negative");
    }

    #[test]
    fn lat_lon_values_nonzero() {
        let Some(f) = open_test_file() else { return };
        let s = f.parse_session(TEST_FILE.to_string()).unwrap();
        println!("Total laps: {}", s.laps.len());
        for (i, lap) in s.laps.iter().enumerate() {
            println!("Lap {}: num={}, time={:.2}, valid={}", i, lap.lap_number, lap.lap_time, lap.is_valid);
        }
        let valid_laps: Vec<_> = s.laps.iter().filter(|l| l.is_valid && l.lap_time > 10.0).collect();
        println!("Valid laps count: {}", valid_laps.len());
        if let Some(lap) = valid_laps.first() {
            let lat = f.get_lap_channel_data(lap, "Lat").expect("Lat must exist");
            let lon = f.get_lap_channel_data(lap, "Lon").expect("Lon must exist");
            println!("Lat[0..3]: {:?}", &lat.samples[..3.min(lat.samples.len())]);
            println!("Lon[0..3]: {:?}", &lon.samples[..3.min(lon.samples.len())]);
            let range_lat = lat.samples.iter().cloned().fold(f64::INFINITY, f64::min)
                ..=lat.samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            println!("Lat range: {:?}", range_lat);
        }
    }

    const PORSCHE_FILE: &str =
        r"C:\Users\schmi\Documents\iRacing\telemetry\porsche9922cup_imola gp 2026-07-01 19-08-35.ibt";
    const FV_FILE: &str =
        r"C:\Users\schmi\Documents\iRacing\telemetry\formulavee_winton national 2025-06-28 06-12-46.ibt";
    const F4_FILE: &str =
        r"C:\Users\schmi\Documents\iRacing\telemetry\formulair04_silverstone 2019 gp 2026-07-04 10-55-42.ibt";

    #[test]
    fn debug_fv_car_name() {
        if !Path::new(FV_FILE).exists() { return }
        let f = IbtFile::open(FV_FILE).expect("open");
        let yaml = f.session_info_yaml();
        println!("=== DriverCarIdx + CarIdx + CarScreenName lines ===");
        for line in yaml.lines() {
            let t = line.trim();
            if t.starts_with("DriverCarIdx") || t.starts_with("CarIdx") || t.starts_with("CarScreenName") || t.starts_with("CarPath") {
                println!("{:?}  |  {}", &line[..line.len().min(3)], line.trim());
            }
        }
        let s = f.parse_session(FV_FILE.to_string()).unwrap();
        println!("\nResult: car={:?}", s.car);
    }

    #[test]
    fn debug_porsche_car_name() {
        if !Path::new(PORSCHE_FILE).exists() { return }
        let f = IbtFile::open(PORSCHE_FILE).expect("open");
        let yaml = f.session_info_yaml();
        for line in yaml.lines() {
            if line.contains("DriverCarIdx") || line.contains("CarIdx") || line.contains("CarScreenName") {
                println!("{}", line);
            }
        }
        let s = f.parse_session(PORSCHE_FILE.to_string()).unwrap();
        println!("\nextract_driver_car_name result: {:?}", s.car);
    }

    #[test]
    fn print_carsetup_yaml() {
        let Some(f) = open_test_file() else { return };
        let yaml = f.session_info_yaml();
        let in_setup = yaml.lines()
            .skip_while(|l| !l.starts_with("CarSetup:"))
            .take(80);
        for line in in_setup {
            println!("{}", line);
        }
    }

    #[test]
    fn print_tyre_temp_ranges() {
        for path in &[PORSCHE_FILE, F4_FILE, TEST_FILE] {
            if !Path::new(path).exists() { continue }
            let f = IbtFile::open(path).expect("open");
            let s = f.parse_session(path.to_string()).unwrap();
            let lap = s.laps.iter().find(|l| l.is_valid && l.lap_time > 10.0);
            let Some(lap) = lap else { println!("FILE: {} — no valid lap", path); continue };
            println!("FILE: {}", path);
            for ch in &["LFtempL","LFtempM","LFtempR","LFtempCL","LFtempCM","LFtempCR"] {
                if let Some(data) = f.get_lap_channel_data(lap, ch) {
                    let min = data.samples.iter().cloned().fold(f64::INFINITY, f64::min);
                    let max = data.samples.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                    println!("  {}: min={:.2} max={:.2} range={:.2}", ch, min, max, max-min);
                }
            }
        }
    }

    #[test]
    fn print_wheel_channels() {
        for path in &[PORSCHE_FILE, FV_FILE, F4_FILE, TEST_FILE] {
            if !Path::new(path).exists() { continue }
            let f = IbtFile::open(path).expect("open");
            let chs = f.channels();
            let relevant: Vec<_> = chs.iter().filter(|c| {
                let l = c.name.to_lowercase();
                l.contains("slip") || l.contains("spin") || l.contains("tire") || l.contains("tyre")
                || l.starts_with("lf") || l.starts_with("rf") || l.starts_with("lr") || l.starts_with("rr")
            }).map(|c| format!("{} ({})", c.name, c.unit)).collect();
            println!("FILE: {}\n{:?}\n", path, relevant);
        }
    }

    #[test]
    fn sector_starts_are_ordered_fractions() {
        let Some(f) = open_test_file() else { return };
        let s = f.sector_starts();
        println!("sectors: {:?}", s);
        assert!(s.windows(2).all(|w| w[0] < w[1]), "must be increasing");
        assert!(s.iter().all(|&v| (0.0..1.0).contains(&v)), "must be lap fractions");
    }

    /// A long stint: eighteen laps, 474k records, and both an out-lap and an
    /// in-lap to tell apart.
    const STINT_FILE: &str =
        r"C:\Users\schmi\Documents\iRacing\telemetry\mercedesamgevogt3_nurburgring combinedshortb 2026-06-13 11-56-37.ibt";

    #[test]
    fn lap_summaries_match_the_lap_time() {
        for path in &[TEST_FILE, PORSCHE_FILE, F4_FILE, STINT_FILE] {
            if !Path::new(path).exists() { continue }
            let f = IbtFile::open(path).expect("open");
            let s = f.parse_session(path.to_string()).unwrap();
            let t = std::time::Instant::now();
            let sums = f.lap_summaries(&s.laps);
            let took = t.elapsed();
            assert_eq!(sums.len(), s.laps.len());
            println!("\nFILE: {}  ({} records, summarised in {:?})",
                path.rsplit('\\').next().unwrap(), s.record_count, took);
            for m in sums.iter().filter(|m| m.is_valid && !m.out_lap && !m.in_lap) {
                let sum: f64 = m.sectors.iter().sum();
                println!(
                    "  lap {:>2} {:>7.3}s  sectors {:?}  fuel {:.2}L rest {:.1}  vmax {:.0} km/h\n\
                              full {:.0}%  brake {:.0}%  coast {:.0}%  overlap {:.1}%  \
                     reversals {:.0}/min  off {}  LF {:.0}/{:.0}/{:.0}C wear {:.0}%",
                    m.lap_number, m.lap_time,
                    m.sectors.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>(),
                    m.fuel_used, m.fuel_left, m.max_speed * 3.6,
                    m.throttle_full_pct, m.braking_pct, m.coasting_pct, m.overlap_pct,
                    m.steering_reversals, m.off_track,
                    m.tyres[0].temp_l, m.tyres[0].temp_m, m.tyres[0].temp_r,
                    m.tyres[0].wear * 100.0,
                );
                // The sectors partition the lap, so they must add up to it. The
                // official time is measured at the line and our samples are not,
                // hence the tolerance of a couple of ticks.
                if !m.sectors.is_empty() && m.lap_time > 10.0 {
                    assert!(
                        (sum - m.lap_time as f64).abs() < 0.2,
                        "lap {}: sectors sum to {:.3} but the lap took {:.3}",
                        m.lap_number, sum, m.lap_time
                    );
                }
                assert!(m.throttle_full_pct + m.coasting_pct <= 100.5);
                assert!(m.braking_pct >= m.overlap_pct);
            }
        }
    }

    /// The distinction that decides which laps count towards pace: an in-lap is
    /// driven flat out and only ends in the pits, an out-lap is not.
    #[test]
    fn in_laps_and_out_laps_are_told_apart() {
        if !Path::new(STINT_FILE).exists() { return }
        let f = IbtFile::open(STINT_FILE).expect("open");
        let s = f.parse_session(STINT_FILE.to_string()).unwrap();
        let sums = f.lap_summaries(&s.laps);
        for m in &sums {
            if m.pit_time > 0.0 {
                println!("  lap {:>2} {:>7.1}s  pit {:>5.1}s  out={} in={}",
                    m.lap_number, m.lap_time, m.pit_time, m.out_lap, m.in_lap);
            }
        }
        let clean: Vec<_> = sums.iter()
            .filter(|m| m.is_valid && !m.out_lap && !m.in_lap && m.lap_time > 10.0)
            .collect();
        println!("  {} laps, {} of them clean", sums.len(), clean.len());
        assert!(sums.iter().any(|m| m.in_lap), "the stint contains in-laps");
        assert!(sums.iter().any(|m| m.out_lap), "the stint contains out-laps");
        // No lap is both unless it was almost entirely pit lane
        assert!(sums.iter().all(|m| !(m.in_lap && m.out_lap) || m.pit_time > 20.0));
    }

    #[test]
    fn print_gps_channels() {
        let Some(f) = open_test_file() else { return };
        let names: Vec<_> = f.channels().iter().map(|c| c.name.clone()).collect();
        let gps: Vec<_> = names.iter().filter(|n| {
            let l = n.to_lowercase();
            l.contains("lat") || l.contains("lon") || l.contains("gps") || l.contains("geo")
        }).collect();
        println!("GPS-related channels: {:?}", gps);
        println!("Has Lat: {}, Has Lon: {}", names.contains(&"Lat".to_string()), names.contains(&"Lon".to_string()));
    }
}
