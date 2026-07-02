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
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, String> {
        let data = fs::read(&path).map_err(|e| e.to_string())?;

        if data.len() < 144 {
            return Err("File too small to be a valid IBT file".into());
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
                "IBT file too small for {} var headers (need {} bytes, have {})",
                num_vars, required, data.len()
            ));
        }
        let var_headers: Vec<VarHeader> = (0..num_vars)
            .map(|i| unsafe { read_struct(&data, vh_offset + i * 144) })
            .collect();

        Ok(IbtFile { data, header, disk_header, var_headers })
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
}
