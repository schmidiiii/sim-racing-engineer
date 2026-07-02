/// irsdk_header — 112 bytes total
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct IbtHeader {
    pub ver: i32,
    pub status: i32,
    pub tick_rate: i32,
    pub session_info_update: i32,
    pub session_info_len: i32,
    pub session_info_offset: i32,
    pub num_vars: i32,
    pub var_header_offset: i32,
    pub num_buf: i32,
    pub buf_len: i32,
    pub pad: [i32; 2],
    pub var_buf: [VarBuf; 4],
}

/// 16 bytes each
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct VarBuf {
    pub tick_count: i32,
    pub buf_offset: i32,
    pub pad: [i32; 2],
}

/// irsdk_diskSubHeader — 32 bytes at offset 112
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct DiskSubHeader {
    pub session_start_date: i64,
    pub session_start_time: f64,
    pub session_end_time: f64,
    pub session_lap_count: i32,
    pub session_record_count: i32,
}

/// irsdk_varHeader — 144 bytes
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct VarHeader {
    pub var_type: i32,
    pub offset: i32,
    pub count: i32,
    pub count_as_time: u8,
    pub pad: [u8; 3],
    pub name: [u8; 32],
    pub desc: [u8; 64],
    pub unit: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum VarType {
    Char = 0,
    Bool = 1,
    Int = 2,
    BitField = 3,
    Float = 4,
    Double = 5,
}

impl VarType {
    pub fn from_i32(v: i32) -> Option<Self> {
        match v {
            0 => Some(VarType::Char),
            1 => Some(VarType::Bool),
            2 => Some(VarType::Int),
            3 => Some(VarType::BitField),
            4 => Some(VarType::Float),
            5 => Some(VarType::Double),
            _ => None,
        }
    }
}

/// Read a C struct from a byte slice at the given offset.
/// SAFETY: T must be a #[repr(C)] struct containing only numeric types with no invalid bit patterns.
pub unsafe fn read_struct<T: Copy>(bytes: &[u8], offset: usize) -> T {
    assert!(
        bytes.len() >= offset + std::mem::size_of::<T>(),
        "not enough bytes: need {} at offset {}, have {}",
        std::mem::size_of::<T>(), offset, bytes.len()
    );
    unsafe { std::ptr::read_unaligned(bytes[offset..].as_ptr() as *const T) }
}

pub fn cstr_to_string(bytes: &[u8]) -> String {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ibt_header_is_112_bytes() {
        assert_eq!(std::mem::size_of::<IbtHeader>(), 112);
    }

    #[test]
    fn disk_sub_header_is_32_bytes() {
        assert_eq!(std::mem::size_of::<DiskSubHeader>(), 32);
    }

    #[test]
    fn var_header_is_144_bytes() {
        assert_eq!(std::mem::size_of::<VarHeader>(), 144);
    }

    #[test]
    fn var_buf_is_16_bytes() {
        assert_eq!(std::mem::size_of::<VarBuf>(), 16);
    }

    #[test]
    fn cstr_stops_at_null() {
        let mut buf = [0u8; 32];
        buf[..5].copy_from_slice(b"Speed");
        assert_eq!(cstr_to_string(&buf), "Speed");
    }
}
