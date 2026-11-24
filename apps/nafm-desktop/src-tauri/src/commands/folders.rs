use std::path::{Path, PathBuf};

use nafm_core::{NafmError, SmbLocation};
use serde::Deserialize;
use tauri::State;
use tokio::process::Command;

use crate::state::AppState;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FolderDestination {
  FileManager,
  Terminal,
}

#[derive(Deserialize)]
pub struct OpenFolderRequest {
  workspace_name: String,
  site_id: String,
  node_id: String,
  destination: FolderDestination,
}

#[tauri::command]
pub async fn open_folder_in(state: State<'_, AppState>, request: OpenFolderRequest) -> Result<(), String> {
  let repository = state.repository_for(&request.workspace_name).await?;
  let path = repository
    .storage_folder_path(&request.site_id, &request.node_id)
    .await
    .map_err(|error| match error {
      NafmError::StorageNodeNotFound(_) | NafmError::StorageNodeNotNavigable(_) | NafmError::SiteNotFound(_) => {
        "This folder is unavailable in the current inventory.".to_owned()
      }
      other => other.to_string(),
    })?;
  let target = folder_target(path, request.destination).await?;
  launch(&target, request.destination).await
}

async fn folder_target(path: PathBuf, destination: FolderDestination) -> Result<PathBuf, String> {
  if let Some(url) = path.to_str().filter(|value| value.starts_with("smb://")) {
    if destination == FolderDestination::Terminal {
      return Err("Terminal requires a local folder.".into());
    }
    let share = SmbLocation::parse(url).map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    return windows_share_path(&share);
    #[cfg(not(target_os = "windows"))]
    return Ok(PathBuf::from(share.normalized_url));
  }
  if !path.is_absolute() {
    return Err("The folder needs an absolute filesystem path.".into());
  }
  let metadata = tokio::fs::metadata(&path)
    .await
    .map_err(|error| format!("The folder is unavailable: {error}"))?;
  if !metadata.is_dir() {
    return Err("This location is no longer a folder.".into());
  }
  Ok(path)
}

#[cfg(target_os = "macos")]
fn mac_command(path: &Path, destination: FolderDestination) -> Command {
  let bundle = match destination {
    FolderDestination::FileManager => "com.apple.finder",
    FolderDestination::Terminal => "com.apple.Terminal",
  };
  let mut command = Command::new("/usr/bin/open");
  command.args(["-b", bundle]).arg(path);
  command
}

#[cfg(target_os = "macos")]
async fn launch(path: &Path, destination: FolderDestination) -> Result<(), String> {
  let output = mac_command(path, destination)
    .output()
    .await
    .map_err(|error| format!("Could not open the folder: {error}"))?;
  if !output.status.success() {
    let message = String::from_utf8_lossy(&output.stderr);
    return Err(format!(
      "Could not open the folder ({}). {}",
      output.status,
      message.trim()
    ));
  }
  Ok(())
}

#[cfg(target_os = "linux")]
async fn launch(path: &Path, destination: FolderDestination) -> Result<(), String> {
  use std::{ffi::OsString, io::ErrorKind, time::Duration};

  let programs: &[&str] = match destination {
    FolderDestination::FileManager => &["xdg-open"],
    FolderDestination::Terminal => &[
      "xdg-terminal-exec",
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xterm",
    ],
  };
  for program in programs {
    let mut command = Command::new(program);
    match *program {
      "xdg-open" => {
        command.arg(path);
      }
      "xdg-terminal-exec" => {
        let mut dir = OsString::from("--dir=");
        dir.push(path);
        command.arg(dir);
      }
      "gnome-terminal" => {
        command.arg("--working-directory").arg(path);
      }
      "konsole" => {
        command.arg("--workdir").arg(path);
      }
      _ => {
        command.current_dir(path);
      }
    }
    let mut child = match command.spawn() {
      Ok(child) => child,
      Err(error) if error.kind() == ErrorKind::NotFound => continue,
      Err(error) => return Err(format!("Could not start {program}: {error}")),
    };
    // Some desktop launchers hand off immediately, others live as long as the window.
    match tokio::time::timeout(Duration::from_millis(350), child.wait()).await {
      Ok(Ok(status)) if status.success() => return Ok(()),
      Ok(Ok(status)) => return Err(format!("{program} could not open the folder ({status}).")),
      Ok(Err(error)) => return Err(format!("Could not open the folder: {error}")),
      Err(_) => {
        tokio::spawn(async move {
          let _ = child.wait().await;
        });
        return Ok(());
      }
    }
  }
  Err(
    match destination {
      FolderDestination::FileManager => "Could not find xdg-open to open the file manager.",
      FolderDestination::Terminal => "Could not find a terminal emulator.",
    }
    .into(),
  )
}

#[cfg(any(target_os = "windows", test))]
fn windows_share_path(share: &SmbLocation) -> Result<PathBuf, String> {
  let host = share
    .server_address
    .strip_suffix(":445")
    .ok_or("File Explorer requires the standard SMB port.")?;
  let host = if let Some(ipv6) = host.strip_prefix('[').and_then(|address| address.strip_suffix(']')) {
    format!("{}.ipv6-literal.net", ipv6.replace(':', "-"))
  } else if host == "." || host == ".." || host.contains(['?', '\\', '/', '%', ':']) {
    return Err("This SMB server name cannot be opened in File Explorer.".into());
  } else {
    host.to_owned()
  };
  if share.share.contains(':') || share.relative_path.contains(':') {
    return Err("This SMB path cannot be opened in File Explorer.".into());
  }
  let mut unc = format!(r"\\{host}\{}", share.share);
  if !share.relative_path.is_empty() {
    unc.push('\\');
    unc.push_str(&share.relative_path.replace('/', r"\"));
  }
  Ok(PathBuf::from(unc))
}

#[cfg(target_os = "windows")]
async fn launch(path: &Path, destination: FolderDestination) -> Result<(), String> {
  let windows = std::env::var_os("SystemRoot")
    .map(PathBuf::from)
    .ok_or("The Windows directory is unavailable.")?;
  let path = dunce::simplified(path);
  let mut command = match destination {
    FolderDestination::FileManager => {
      let mut command = Command::new(windows.join("explorer.exe"));
      command.arg(path);
      command
    }
    FolderDestination::Terminal => {
      let mut command = Command::new(windows.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
      const CREATE_NEW_CONSOLE: u32 = 0x00000010;
      command
        .args(["-NoLogo", "-NoProfile"])
        .current_dir(path)
        .creation_flags(CREATE_NEW_CONSOLE);
      command
    }
  };
  let mut child = command
    .spawn()
    .map_err(|error| format!("Could not open the folder: {error}"))?;
  tokio::spawn(async move {
    let _ = child.wait().await;
  });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn local_target_must_exist_and_be_a_directory() {
    let fixture = tempfile::tempdir().unwrap();
    let folder = fixture.path().join("Maps & charts; notes");
    std::fs::create_dir(&folder).unwrap();
    let file = fixture.path().join("map");
    std::fs::write(&file, "").unwrap();
    for destination in [FolderDestination::FileManager, FolderDestination::Terminal] {
      assert_eq!(folder_target(folder.clone(), destination).await.unwrap(), folder);
      assert!(folder_target(file.clone(), destination).await.is_err());
      assert!(folder_target(fixture.path().join("absent"), destination).await.is_err());
    }
  }

  #[tokio::test]
  async fn smb_is_validated_and_can_only_open_in_a_file_manager() {
    let path = PathBuf::from("smb://studio.example.test/Shared/Field%20notes");
    let target = folder_target(path.clone(), FolderDestination::FileManager)
      .await
      .unwrap();
    #[cfg(not(target_os = "windows"))]
    assert_eq!(target, path);
    #[cfg(target_os = "windows")]
    assert_eq!(target, PathBuf::from(r"\\studio.example.test\Shared\Field notes"));
    assert!(folder_target(path, FolderDestination::Terminal).await.is_err());
    assert!(
      folder_target("smb://studio.example.test".into(), FolderDestination::FileManager)
        .await
        .is_err()
    );
  }

  #[test]
  fn explorer_uses_decoded_unc_paths_and_rejects_device_namespaces_and_custom_ports() {
    let share = SmbLocation::parse("smb://studio.example.test/Field%20drive/Maps/West%20coast").unwrap();
    assert_eq!(
      windows_share_path(&share).unwrap(),
      PathBuf::from(r"\\studio.example.test\Field drive\Maps\West coast")
    );
    for url in ["smb://./pipe/folder", "smb://studio.example.test:1445/share"] {
      assert!(windows_share_path(&SmbLocation::parse(url).unwrap()).is_err());
    }
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn mac_launch_passes_the_folder_as_one_argument() {
    let path = Path::new("Field notes & maps; draft");
    for (destination, bundle) in [
      (FolderDestination::Terminal, "com.apple.Terminal"),
      (FolderDestination::FileManager, "com.apple.finder"),
    ] {
      let command = mac_command(path, destination);
      let command = command.as_std();
      assert_eq!(command.get_program(), "/usr/bin/open");
      assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        ["-b".as_ref(), bundle.as_ref(), path.as_os_str()]
      );
    }
  }
}
