use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub file_path: String,
    pub track: String,
    /// iRacing's own id for the track *and* layout. Keys the stored centreline,
    /// which the display name cannot: "Circuit de Spa-Francorchamps" covers
    /// several layouts that do not share geometry.
    pub track_id: Option<i32>,
    /// The driver whose car this file recorded, if the session listed them
    pub driver: Option<String>,
    pub car: String,
    pub date: String,
    pub tick_rate: i32,
    pub record_count: i32,
    pub laps: Vec<Lap>,
    /// Where iRacing puts its sector lines, as fractions of a lap, starting at
    /// 0. The count varies with track length — five at Imola, twelve on the
    /// Nordschleife — so nothing may assume three. Empty if the session
    /// declared none.
    pub sector_starts: Vec<f64>,
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
    pub lap_dist_pct: Vec<f64>,
}

/// Everything worth knowing about a lap that is *not* a curve over distance.
/// One of these per lap is what a race engineer reads between runs: the table
/// that says which lap was quick, what it cost in fuel and rubber, and how the
/// driver got there. Filled in a single pass over the buffer, so asking for the
/// whole session costs one read rather than one per lap per channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LapSummary {
    pub lap_number: i32,
    pub lap_time: f32,
    pub is_valid: bool,
    /// Seconds spent on pit road during this lap.
    ///
    /// A single "was in the pits" flag is too blunt: measured on a Nürburgring
    /// stint, the in-laps carry 3.7 s of pit road at the very end and are
    /// otherwise driven at full pace, while the out-laps carry thirty to
    /// seventy-five seconds at the start. Reporting the two separately lets an
    /// in-lap still be read as a lap, which is what it mostly is.
    pub pit_time: f64,
    /// Left the pits during the first fifth of the lap
    pub out_lap: bool,
    /// Entered the pits during the last fifth
    pub in_lap: bool,
    /// Split at iRacing's own sector boundaries; empty if the session had none
    pub sectors: Vec<f64>,
    pub fuel_used: f64,
    pub fuel_left: f64,
    pub max_speed: f64,
    pub avg_speed: f64,
    /// Share of the lap at full throttle, on the brakes, on neither, and on both
    pub throttle_full_pct: f64,
    pub braking_pct: f64,
    pub coasting_pct: f64,
    pub overlap_pct: f64,
    pub max_brake: f64,
    /// Changes of steering direction per minute — a car that is unhappy, or a
    /// driver correcting it, shows up here before it shows up in the lap time
    pub steering_reversals: f64,
    /// Times iRacing reported the car off the racing surface for at least four
    /// tenths of a second, pit entry excluded. Measured excursions run about a
    /// second, so the threshold separates them from clipping a kerb.
    pub off_track: i32,
    pub tyres: Vec<TyreState>,
    pub track_temp: f64,
    pub air_temp: f64,
}

/// Tyre condition at the end of the lap. Left/middle/right are in the car's
/// frame, not inner/outer, because that is how iRacing reports them and
/// flipping the two sides would quietly hide which way a tyre is working.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TyreState {
    pub corner: String,
    pub temp_l: f64,
    pub temp_m: f64,
    pub temp_r: f64,
    /// Tread remaining, 0..1, averaged across the three measurement points.
    ///
    /// Unlike temperature and pressure this is NOT a per-lap value: iRacing
    /// only refreshes it when the tyre is inspected in the pits, so it holds
    /// one figure per stint and steps down at each stop. Presented as such.
    pub wear: f64,
    /// Hot pressure in kPa, live
    pub pressure: f64,
}

/// A moment worth looking at. An eight-minute lap of the Nordschleife is a lot
/// of trace to read; this reduces it to the handful of places where something
/// actually happened, each carrying the session time so the charts and the 3D
/// view can be sent straight there.
///
/// ABS engagement is deliberately not among the kinds. In a GT3 it fires on
/// every heavy braking — 83 separate engagements of half a second or more over
/// one stint — so listing it would bury the events that matter. It is already
/// visible as the amber section of the brake trace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LapEvent {
    pub lap_number: i32,
    /// Seconds from the start of the lap
    pub at: f64,
    /// Absolute session time, which is what drives the crosshair
    pub session_time: f64,
    /// Where on the lap it happened, 0..1
    pub lap_dist_pct: f64,
    /// "lockup" | "wheelspin" | "offTrack" | "missedShift"
    pub kind: String,
    /// The wheel it belongs to, where it belongs to one
    pub corner: Option<String>,
    /// How bad: percent of slip for a wheel, seconds for an excursion
    pub magnitude: f64,
    pub duration: f64,
    /// Speed at the worst moment, m/s
    pub speed: f64,
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
