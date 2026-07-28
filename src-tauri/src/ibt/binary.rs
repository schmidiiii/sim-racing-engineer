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

/// Windows-1252 differs from Latin-1 only in 0x80..=0x9F, where it carries
/// punctuation instead of control codes. Above that the two agree, and a byte
/// maps straight to the code point of the same value.
fn cp1252_char(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡',
        'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
        '\u{90}', '‘', '’', '“', '”', '•', '–', '—',
        '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..=0x9f).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }
}

/// Decode the session YAML, which is not written in a single encoding.
///
/// Track and driver names arrive as Windows-1252 — "Hockenheimring
/// Baden-Württemberg" carries a bare 0xFC — while fields iRacing fills from its
/// own database, such as the country flair, are UTF-8. Both turn up in the same
/// file: 14 of the 96 sample files hold "Bela Brünger" as 1252 and "Türkiye" as
/// UTF-8 side by side. Decoding wholesale either way therefore mangles the
/// other, and `from_utf8_lossy` simply dropped every 1252 character.
///
/// So each sequence is judged on its own: taken as UTF-8 where the bytes form a
/// valid one, and as Windows-1252 otherwise.
pub fn decode_session_text(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 16);
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b < 0x80 {
            out.push(b as char);
            i += 1;
            continue;
        }
        // Length this byte claims as a UTF-8 lead byte, if it is one at all
        let width = match b {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => 1,
        };
        if width > 1 && i + width <= bytes.len() {
            if let Ok(s) = std::str::from_utf8(&bytes[i..i + width]) {
                out.push_str(s);
                i += width;
                continue;
            }
        }
        out.push(cp1252_char(b));
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_windows_1252_track_names() {
        // "Baden-Württemberg" as iRacing writes it: a bare 0xFC
        let mut b = b"Baden-W".to_vec();
        b.push(0xfc);
        b.extend_from_slice(b"rttemberg");
        assert_eq!(decode_session_text(&b), "Baden-Württemberg");
    }

    #[test]
    fn keeps_utf8_where_it_is_already_utf8() {
        assert_eq!(decode_session_text("Türkiye".as_bytes()), "Türkiye");
    }

    #[test]
    fn handles_both_encodings_in_one_document() {
        // Exactly the mix found in 14 of the sample files
        let mut b = b"UserName: Bela Br".to_vec();
        b.push(0xfc);                                   // 1252
        b.extend_from_slice(b"nger\nFlairName: T");
        b.extend_from_slice("ü".as_bytes());            // UTF-8
        b.extend_from_slice(b"rkiye\n");
        assert_eq!(
            decode_session_text(&b),
            "UserName: Bela Brünger\nFlairName: Türkiye\n"
        );
    }

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
