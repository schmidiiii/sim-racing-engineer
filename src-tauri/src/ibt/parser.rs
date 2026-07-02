use std::fs;
use std::path::Path;
use crate::ibt::binary::*;
use crate::ibt::types::*;

pub struct IbtFile {
    data: Vec<u8>,
    pub header: IbtHeader,
    pub disk_header: DiskSubHeader,
    pub var_headers: Vec<VarHeader>,
}

impl IbtFile {
    pub fn from_bytes(data: Vec<u8>) -> Result<Self, String> {
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

    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let data = fs::read(&path).map_err(|e| e.to_string())?;
        Self::from_bytes(data)
    }

    pub fn channels(&self) -> Vec<Channel> {
        self.var_headers.iter().map(|vh| Channel {
            name: cstr_to_string(&vh.name),
            description: cstr_to_string(&vh.desc),
            unit: cstr_to_string(&vh.unit),
            var_type: VarType::from_i32(vh.var_type)
                .map(|t| format!("{:?}", t))
                .unwrap_or_else(|| format!("Unknown({})", vh.var_type)),
        }).collect()
    }

    pub fn session_info_yaml(&self) -> String {
        let start = self.header.session_info_offset as usize;
        let len = self.header.session_info_len as usize;
        if start + len > self.data.len() {
            return String::new();
        }
        String::from_utf8_lossy(&self.data[start..start + len])
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
            // LapLastLapTime is written at the start of the next lap
            // LapLastLapTime is written at the first sample of the next lap
            let lap_time = llt_var
                .map(|v| self.read_f64(end.min(record_count.saturating_sub(1)), v) as f32)
                .unwrap_or(0.0);

            Lap {
                lap_number: lap_num,
                lap_time,
                is_valid: lap_time > 10.0,
                start_sample: start,
                end_sample: end,
            }
        }).collect();

        let yaml = self.session_info_yaml();
        let track = extract_yaml_field(&yaml, "TrackDisplayName")
            .unwrap_or_else(|| "Unknown Track".into());
        let car = extract_yaml_field(&yaml, "CarScreenName")
            .unwrap_or_else(|| "Unknown Car".into());
        let date = chrono::DateTime::from_timestamp(self.disk_header.session_start_date, 0)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "Unknown".into());

        Ok(Session {
            id: uuid::Uuid::new_v4().to_string(),
            file_path,
            track,
            car,
            date,
            tick_rate: self.header.tick_rate,
            record_count: self.disk_header.session_record_count,
            laps,
            available_channels: self.channels(),
        })
    }

    pub fn get_lap_channel_data(&self, lap: &Lap, channel: &str) -> Option<LapChannelData> {
        let ch_var = self.find_var(channel)?;
        let st_var = self.find_var("SessionTime")?;
        let total = self.disk_header.session_record_count as usize;
        let end = lap.end_sample.min(total);

        let t0 = self.read_f64(lap.start_sample, st_var);

        let samples: Vec<f64> = (lap.start_sample..end)
            .map(|i| self.read_f64(i, ch_var))
            .collect();
        let timestamps: Vec<f64> = (lap.start_sample..end)
            .map(|i| self.read_f64(i, st_var) - t0)
            .collect();

        Some(LapChannelData {
            lap_number: lap.lap_number,
            channel: channel.to_string(),
            samples,
            timestamps,
        })
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
}
