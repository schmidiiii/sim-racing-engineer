use std::path::Path;
use crate::ibt::types::*;

pub struct IbtFile;

impl IbtFile {
    pub fn open<P: AsRef<Path>>(_path: P) -> Result<Self, String> {
        Err("Not yet implemented".into())
    }
}
