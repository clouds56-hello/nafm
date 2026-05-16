use std::path::Path;

use anyhow::Result;
use indicatif::{ProgressBar, ProgressStyle};
use serde::Serialize;

pub fn print_json_or<T, F>(json: bool, value: &T, human: F) -> Result<()>
where
  T: Serialize,
  F: FnOnce(),
{
  if json {
    println!("{}", serde_json::to_string_pretty(value)?);
  } else {
    human();
  }
  Ok(())
}

pub fn spinner(json: bool, message: &'static str) -> ProgressBar {
  if json {
    return ProgressBar::hidden();
  }
  let spinner = ProgressBar::new_spinner();
  spinner.set_message(message);
  spinner
    .set_style(ProgressStyle::with_template("{spinner} {msg}").unwrap_or_else(|_| ProgressStyle::default_spinner()));
  spinner.enable_steady_tick(std::time::Duration::from_millis(120));
  spinner
}

pub fn folder_label(display_name: &str, alias: Option<&str>, path: &Path) -> String {
  match alias {
    Some(alias) => format!("{alias} ({display_name}) at {}", path.display()),
    None => format!("{display_name} at {}", path.display()),
  }
}
