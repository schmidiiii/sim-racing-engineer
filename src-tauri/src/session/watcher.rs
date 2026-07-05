use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// iRacing creates the .ibt file at session start and writes to it continuously.
// We debounce both Create and Modify events so the frontend only gets notified
// once the file has settled (no writes for 1.5 s) — i.e. session ended.
pub fn start_watcher(app: AppHandle, dir: PathBuf) {
    if !dir.exists() {
        return;
    }

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let pending: Arc<Mutex<HashMap<PathBuf, Instant>>> = Arc::new(Mutex::new(HashMap::new()));

        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => { eprintln!("Failed to create file watcher: {}", e); return; }
        };

        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("Failed to watch {:?}: {}", dir, e);
            return;
        }

        // Debouncer: poll every 500 ms, emit for files idle ≥ 1.5 s
        let pending_clone = Arc::clone(&pending);
        let app_clone = app.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let now = Instant::now();
                let mut map = pending_clone.lock().unwrap();
                let settled: Vec<PathBuf> = map
                    .iter()
                    .filter(|(_, t)| now.duration_since(**t) >= Duration::from_millis(1500))
                    .map(|(p, _)| p.clone())
                    .collect();
                for path in settled {
                    map.remove(&path);
                    let path_str = path.to_string_lossy().to_string();
                    if let Err(e) = app_clone.emit("new-ibt-file", &path_str) {
                        eprintln!("Failed to emit new-ibt-file event: {}", e);
                    }
                }
            }
        });

        for res in rx {
            match res {
                Ok(event) => {
                    let relevant = matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_)
                    );
                    if relevant {
                        let mut map = pending.lock().unwrap();
                        for path in event.paths {
                            if path.extension().map(|e| e == "ibt").unwrap_or(false) {
                                map.insert(path, Instant::now());
                            }
                        }
                    }
                }
                Err(e) => eprintln!("Watch error: {}", e),
            }
        }
    });
}
