use std::sync::Mutex;

use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct TextClipboard(Mutex<Option<arboard::Clipboard>>);

impl TextClipboard {
  fn write(&self, text: String) -> Result<(), String> {
    let mut clipboard = self.0.lock().map_err(|_| "The system clipboard is unavailable.")?;
    // On Linux the clipboard owner serves paste requests after this command returns.
    let clipboard = match &mut *clipboard {
      Some(clipboard) => clipboard,
      slot @ None => slot.insert(arboard::Clipboard::new().map_err(clipboard_error)?),
    };
    clipboard.set_text(text).map_err(clipboard_error)
  }

  pub fn shutdown(&self) {
    let clipboard = self.0.lock().ok().and_then(|mut clipboard| clipboard.take());
    drop(clipboard);
  }
}

fn clipboard_error(error: arboard::Error) -> String {
  format!("Couldn’t write to the system clipboard. {error}")
}

#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || app.state::<TextClipboard>().write(text))
    .await
    .map_err(|error| format!("Couldn’t start the clipboard write. {error}"))?
}
