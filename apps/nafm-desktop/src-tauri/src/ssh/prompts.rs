use std::{
  collections::BTreeMap,
  sync::{Arc, Mutex},
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tokio::sync::oneshot;
use uuid::Uuid;
use zeroize::Zeroizing;

pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Serialize)]
pub struct Prompt {
  pub prompt_id: String,
  pub ssh_target: String,
  pub message: String,
  pub confirmation: bool,
}

struct Pending {
  prompt: Prompt,
  answer: oneshot::Sender<Option<Zeroizing<String>>>,
}

pub struct PromptHub {
  notify: Box<dyn Fn() + Send + Sync>,
  pending: Mutex<BTreeMap<String, Pending>>,
}

impl PromptHub {
  pub fn new(app: AppHandle) -> Self {
    Self {
      notify: Box::new(move || {
        let _ = app.emit_to("main", "ssh://prompts-changed", ());
      }),
      pending: Mutex::new(BTreeMap::new()),
    }
  }

  #[cfg(test)]
  pub(super) fn for_test() -> Arc<Self> {
    Arc::new(Self {
      notify: Box::new(|| {}),
      pending: Mutex::new(BTreeMap::new()),
    })
  }

  fn changed(&self) {
    (self.notify)();
  }

  pub async fn ask(self: &Arc<Self>, target: &str, message: String, confirmation: bool) -> Option<Zeroizing<String>> {
    let prompt_id = Uuid::new_v4().to_string();
    let (answer, response) = oneshot::channel();
    let prompt = Prompt {
      prompt_id: prompt_id.clone(),
      ssh_target: target.into(),
      message,
      confirmation,
    };
    self
      .pending
      .lock()
      .ok()?
      .insert(prompt_id.clone(), Pending { prompt, answer });
    let _guard = PendingGuard {
      hub: self.clone(),
      prompt_id,
    };
    self.changed();
    tokio::time::timeout(PROMPT_TIMEOUT, response).await.ok()?.ok()?
  }

  pub(super) fn list(&self) -> Result<Vec<Prompt>, String> {
    Ok(
      self
        .pending
        .lock()
        .map_err(|_| "Prompt registry unavailable")?
        .values()
        .map(|pending| pending.prompt.clone())
        .collect(),
    )
  }

  pub(super) fn reply(&self, id: &str, response: Option<Zeroizing<String>>) -> Result<(), String> {
    if response.as_ref().is_some_and(|value| !valid_answer(value)) {
      return Err("Response is too long or contains a newline/NUL".into());
    }
    let pending = self
      .pending
      .lock()
      .map_err(|_| "Prompt registry unavailable")?
      .remove(id)
      .ok_or("This SSH prompt has expired")?;
    self.changed();
    pending
      .answer
      .send(response)
      .map_err(|_| "This SSH prompt has expired".into())
  }
}

fn valid_answer(value: &str) -> bool {
  value.len() <= 8192 && !value.contains(['\r', '\n', '\0'])
}

struct PendingGuard {
  hub: Arc<PromptHub>,
  prompt_id: String,
}
impl Drop for PendingGuard {
  fn drop(&mut self) {
    if let Ok(mut pending) = self.hub.pending.lock() {
      pending.remove(&self.prompt_id);
    }
    self.hub.changed();
  }
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
  if window.label() == "main" {
    Ok(())
  } else {
    Err("SSH prompts are restricted to the main window".into())
  }
}

#[tauri::command]
pub fn ssh_prompts(window: WebviewWindow, hub: State<'_, Arc<PromptHub>>) -> Result<Vec<Prompt>, String> {
  require_main(&window)?;
  hub.list()
}

// Deliberately not Debug/Serialize: responses must never appear in events or logs.
#[derive(Deserialize)]
pub struct PromptReply {
  prompt_id: String,
  response: Option<String>,
}

#[tauri::command]
pub fn ssh_prompt_reply(
  window: WebviewWindow,
  hub: State<'_, Arc<PromptHub>>,
  request: PromptReply,
) -> Result<(), String> {
  let response = request.response.map(Zeroizing::new);
  require_main(&window)?;
  hub.reply(&request.prompt_id, response)
}

#[cfg(test)]
mod tests {
  #[test]
  fn responses_cannot_inject_additional_lines() {
    assert!(super::valid_answer(""));
    assert!(super::valid_answer("a secret with spaces 照片"));
    for invalid in ["a\nb", "a\rb", "a\0b"] {
      assert!(!super::valid_answer(invalid));
    }
    assert!(!super::valid_answer(&"x".repeat(8193)));
  }
}
