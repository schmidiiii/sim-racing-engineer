use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use tauri::{AppHandle, Emitter};

pub fn start_watcher(app: AppHandle, dir: PathBuf) {
    if !dir.exists() {
        return; // telemetry dir may not exist yet; watcher not started
    }

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("Failed to create file watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("Failed to watch {:?}: {}", dir, e);
            return;
        }

        for res in rx {
            match res {
                Ok(event) => {
                    // Only emit on file creation (not modify/delete)
                    let is_create = matches!(
                        event.kind,
                        EventKind::Create(_)
                    );
                    if is_create {
                        for path in event.paths {
                            if path.extension().map(|e| e == "ibt").unwrap_or(false) {
                                let path_str = path.to_string_lossy().to_string();
                                if let Err(e) = app.emit("new-ibt-file", &path_str) {
                                    eprintln!("Failed to emit new-ibt-file event: {}", e);
                                }
                            }
                        }
                    }
                }
                Err(e) => eprintln!("Watch error: {}", e),
            }
        }
    });
}
