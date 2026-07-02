use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub file_path: String,
    pub track: String,
    pub car: String,
    pub date: String,
    pub tick_rate: i32,
    pub record_count: i32,
    pub laps: Vec<Lap>,
    pub available_channels: Vec<Channel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lap {
    pub lap_number: i32,
    pub lap_time: f32,
    pub is_valid: bool,
    pub start_sample: usize,
    pub end_sample: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub name: String,
    pub description: String,
    pub unit: String,
    pub var_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LapChannelData {
    pub lap_number: i32,
    pub channel: String,
    pub samples: Vec<f64>,
    pub timestamps: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LapStats {
    pub lap_number: i32,
    pub lap_time: f32,
    pub channel_stats: HashMap<String, ChannelStat>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStat {
    pub min: f64,
    pub max: f64,
    pub avg: f64,
}
