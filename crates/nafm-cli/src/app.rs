use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Result, bail};
use nafm_core::{
  AddSiteFolderRequest, DEFAULT_WORKSPACE_NAME, HiddenPolicy, NafmError, Repository, RepositoryOptions,
  WorkspaceManager,
};
use serde::Serialize;

use crate::cli::{Cli, Command, HiddenArg, SiteCommand, StageCommand, WorkspaceCommand};
use crate::output::{format_duplicate_groups_by_folder, print_json_line, print_json_or, site_folder_label, spinner};

pub async fn run_with_cli(cli: Cli) -> Result<()> {
  let workspace_manager = WorkspaceManager::from_default_root()?;
  workspace_manager.ensure_default_workspace(None).await?;

  match cli.command {
    Command::Workspace(command) => handle_workspace(&workspace_manager, command, cli.json).await?,
    command => {
      let repo = open_repository(&workspace_manager, cli.workspace.as_deref(), cli.cache).await?;
      match command {
        Command::Site(command) => handle_site(&repo, command, cli.json).await?,
        Command::Stage(command) => handle_stage(&repo, command, cli.json).await?,
        Command::Scan { selector } => handle_scan(&repo, &selector, cli.json).await?,
        Command::Duplicates { selector } => handle_duplicates(&repo, &selector, cli.json).await?,
        Command::Missing { site, against } => handle_missing(&repo, &site, &against, cli.json).await?,
        Command::Workspace(_) => unreachable!("workspace command handled separately"),
      }
    }
  }

  Ok(())
}

async fn open_repository(
  workspace_manager: &WorkspaceManager,
  explicit_workspace: Option<&str>,
  cache_path: Option<PathBuf>,
) -> Result<Repository> {
  let cache_path = resolve_repository_cache_path(workspace_manager, explicit_workspace, cache_path)?;
  Repository::open(RepositoryOptions {
    cache_path,
    hash_algorithm: None,
  })
  .await
  .map_err(Into::into)
}

fn resolve_repository_cache_path(
  workspace_manager: &WorkspaceManager,
  explicit_workspace: Option<&str>,
  cache_path: Option<PathBuf>,
) -> Result<PathBuf> {
  match cache_path {
    Some(cache_path) => {
      if explicit_workspace.is_some() {
        bail!("--cache cannot be combined with --workspace");
      }
      Ok(cache_path)
    }
    None => {
      let workspace_name = workspace_manager.resolve_workspace_name(explicit_workspace)?;
      if explicit_workspace.is_some() && !workspace_manager.workspace_exists(&workspace_name)? {
        return Err(NafmError::WorkspaceNotFound(workspace_name).into());
      }
      workspace_manager.workspace_db_path(&workspace_name).map_err(Into::into)
    }
  }
}

async fn handle_workspace(manager: &WorkspaceManager, command: WorkspaceCommand, json: bool) -> Result<()> {
  match command {
    WorkspaceCommand::Create { name, activate } => {
      manager.create_workspace(&name, activate, None).await?;
      let current_workspace = manager.current_workspace_name()?;
      print_json_or(
        json,
        &serde_json::json!({
          "name": name,
          "activate": activate,
          "current_workspace": current_workspace,
        }),
        || {
          if activate {
            println!("created and activated workspace {name}");
          } else {
            println!("created workspace {name}");
          }
        },
      )?;
    }
    WorkspaceCommand::Activate { name } => {
      manager.activate_workspace(&name)?;
      print_json_or(json, &serde_json::json!({ "workspace": name }), || {
        println!("activated workspace {name}");
      })?;
    }
    WorkspaceCommand::Current => {
      let current_workspace = manager.current_workspace_name()?;
      print_json_or(json, &serde_json::json!({ "workspace": current_workspace }), || {
        if current_workspace == DEFAULT_WORKSPACE_NAME {
          println!("current workspace {current_workspace} (default)");
        } else {
          println!("current workspace {current_workspace}");
        }
      })?;
    }
    WorkspaceCommand::List => {
      let workspaces = manager.list_workspaces()?;
      print_json_or(json, &workspaces, || {
        if workspaces.is_empty() {
          println!("no workspaces created");
        } else {
          for workspace in &workspaces {
            if workspace.active {
              println!("{}  active", workspace.name);
            } else {
              println!("{}", workspace.name);
            }
          }
        }
      })?;
    }
  }

  Ok(())
}

async fn handle_stage(repo: &Repository, command: StageCommand, json: bool) -> Result<()> {
  match command {
    StageCommand::Add { path } => {
      let report = repo.stage_add_path(&path).await?;
      print_json_or(json, &report, || {
        if report.staged_files.is_empty() {
          println!("no files added to stage");
        } else {
          println!("staged {} files:", report.staged_files.len());
          for file in &report.staged_files {
            println!("  {}", file.path.display());
          }
        }
        if !report.warnings.is_empty() {
          println!("warnings:");
          for warning in &report.warnings {
            println!("  {}: {}", warning.path.display(), stage_warning_label(&warning.reason));
          }
        }
      })?;
    }
    StageCommand::Remove { path } => {
      let report = repo.stage_remove_path(&path).await?;
      print_json_or(json, &report, || {
        if report.removed_files.is_empty() {
          println!("no files removed from stage");
        } else {
          println!("removed {} files from stage:", report.removed_files.len());
          for file in &report.removed_files {
            println!("  {}", file.path.display());
          }
        }
        if !report.warnings.is_empty() {
          println!("warnings:");
          for warning in &report.warnings {
            println!("  {}: {}", warning.path.display(), stage_warning_label(&warning.reason));
          }
        }
      })?;
    }
    StageCommand::Undo => {
      let report = repo.stage_undo().await?;
      print_json_or(json, &report, || {
        if report.applied {
          println!("stage undo restored {} staged files", report.restored_files.len());
          for file in &report.restored_files {
            println!("  {}", file.path.display());
          }
        }
      })?;
    }
    StageCommand::Redo => {
      let report = repo.stage_redo().await?;
      print_json_or(json, &report, || {
        if report.applied {
          println!("stage redo restored {} staged files", report.restored_files.len());
          for file in &report.restored_files {
            println!("  {}", file.path.display());
          }
        }
      })?;
    }
    StageCommand::Reset => {
      let report = repo.stage_reset().await?;
      print_json_or(json, &report, || {
        if report.removed_files.is_empty() {
          println!("stage already empty");
        } else {
          println!("removed {} files from stage:", report.removed_files.len());
          for file in &report.removed_files {
            println!("  {}", file.path.display());
          }
        }
      })?;
    }
    StageCommand::Commit => {
      let report = repo.stage_commit_dry_run().await?;
      print_json_or(json, &report, || {
        println!("stage commit dry-run");
        println!("db entry count stable: {}", report.db_entry_count_stable);
        println!(
          "tracked files: {} -> {}",
          report.tracked_file_count_before, report.tracked_file_count_after
        );
        println!(
          "duplicate groups: {} -> {}",
          report.duplicate_group_count_before, report.duplicate_group_count_after
        );
        println!(
          "duplicate files: {} -> {}",
          report.duplicate_file_count_before, report.duplicate_file_count_after
        );
        if report.staged_files.is_empty() {
          println!("no files staged for deletion");
        } else {
          println!("files to be deleted:");
          for file in &report.staged_files {
            println!("  {}", file.path.display());
          }
        }
        if report.duplicate_groups_after.is_empty() {
          println!("no duplicates would remain");
        } else {
          println!("duplicates that would remain:");
          println!(
            "{}",
            format_duplicate_groups_by_folder(
              &report.duplicate_groups_after,
              &parent_folder_counts_from_duplicates(&report.duplicate_groups_after),
            )
          );
        }
      })?;
    }
  }
  Ok(())
}

async fn handle_site(repo: &Repository, command: SiteCommand, json: bool) -> Result<()> {
  match command {
    SiteCommand::Create { name } => {
      let site = repo.create_site(&name).await?;
      print_json_or(json, &site, || {
        println!("created site {}", site.name);
      })?;
    }
    SiteCommand::Add { site, folder, hidden } => {
      let site_folder = repo
        .add_site_folder(
          &site,
          AddSiteFolderRequest {
            path: folder,
            hidden_policy: hidden.into(),
          },
        )
        .await?;
      print_json_or(json, &site_folder, || {
        println!("added site folder {}", site_folder_label(&site, &site_folder.path));
      })?;
    }
    SiteCommand::List => {
      let sites = repo.list_sites().await?;
      let site_folders = repo.list_site_folders(None).await?;
      let mut folders_by_site = BTreeMap::new();
      for site_folder in site_folders {
        folders_by_site
          .entry(site_folder.site_id.clone())
          .or_insert_with(Vec::new)
          .push(site_folder);
      }

      let payload = sites
        .iter()
        .map(|site| SiteListEntry {
          site: site.clone(),
          folders: folders_by_site.get(&site.id).cloned().unwrap_or_default(),
        })
        .collect::<Vec<_>>();

      print_json_or(json, &payload, || {
        if sites.is_empty() {
          println!("no sites registered");
        } else {
          for site in &sites {
            println!("{}  id={}", site.name, site.id);
            match folders_by_site.get(&site.id) {
              Some(site_folders) => {
                for site_folder in site_folders {
                  println!(
                    "  {}  hidden={:?}",
                    site_folder.path.display(),
                    site_folder.hidden_policy
                  );
                }
              }
              None => println!("  no folders"),
            }
          }
        }
      })?;
    }
  }
  Ok(())
}

async fn handle_scan(repo: &Repository, selector: &str, json: bool) -> Result<()> {
  let spinner = spinner(json, "scanning");
  let progress_callback = if json {
    Some(Arc::new(move |progress: &nafm_core::ScanProgress| {
      let _ = print_json_line(&ScanEvent::Progress(progress.clone()));
    }) as Arc<dyn Fn(&nafm_core::ScanProgress) + Send + Sync>)
  } else {
    let spinner = spinner.clone();
    Some(Arc::new(move |progress: &nafm_core::ScanProgress| {
      spinner.set_message(format!(
        "scanning {} {}/{} {}",
        progress.site_name,
        progress.files_scanned,
        progress.total_files,
        progress.current_path.display()
      ));
    }) as Arc<dyn Fn(&nafm_core::ScanProgress) + Send + Sync>)
  };
  let summaries = if selector == "all" {
    repo.scan_all_with_progress(progress_callback).await?
  } else {
    vec![repo.scan_site_with_progress(selector, progress_callback).await?]
  };
  spinner.finish_and_clear();

  if json {
    for summary in &summaries {
      print_json_line(&ScanEvent::Summary(summary.clone()))?;
    }
  } else {
    print_json_or(json, &summaries, || {
      if summaries.is_empty() {
        println!("no sites registered");
      }
      for summary in &summaries {
        println!(
          "site {}: {} folders, {} files, {} hashed, {} reused, {} duplicate groups",
          summary.site_name,
          summary.site_folders,
          summary.files_seen,
          summary.files_hashed,
          summary.files_reused,
          summary.duplicate_groups
        );
      }
    })?;
  }
  Ok(())
}

async fn handle_duplicates(repo: &Repository, selector: &str, json: bool) -> Result<()> {
  let site_selector = if selector == "all" { None } else { Some(selector) };
  let groups = if selector == "all" {
    repo.find_duplicates(None).await?
  } else {
    repo.find_duplicates(Some(selector)).await?
  };
  let file_counts_by_parent_folder = repo.file_counts_by_parent_folder(site_selector).await?;
  print_json_or(json, &groups, || {
    if groups.is_empty() {
      println!("no duplicates found");
    } else {
      println!(
        "{}",
        format_duplicate_groups_by_folder(&groups, &file_counts_by_parent_folder)
      );
    }
  })?;
  Ok(())
}

async fn handle_missing(repo: &Repository, site: &str, against: &str, json: bool) -> Result<()> {
  let groups = repo.find_missing(site, against).await?;
  print_json_or(json, &groups, || {
    if groups.is_empty() {
      println!("no missing content from {} to {}", site, against);
    }
    for group in &groups {
      println!(
        "missing group {}: {} source files, {} bytes, algo={}",
        group.group_id,
        group.source_files.len(),
        group.size_bytes,
        group.hash_algorithm
      );
      for file in &group.source_files {
        println!("  {}", file.path.display());
      }
    }
  })?;
  Ok(())
}

impl From<HiddenArg> for HiddenPolicy {
  fn from(value: HiddenArg) -> Self {
    match value {
      HiddenArg::Include => HiddenPolicy::Include,
      HiddenArg::Skip => HiddenPolicy::Skip,
    }
  }
}

fn stage_warning_label(reason: &nafm_core::StageWarningReason) -> &'static str {
  match reason {
    nafm_core::StageWarningReason::NotTracked => "not tracked",
    nafm_core::StageWarningReason::NotDuplicate => "not duplicate",
    nafm_core::StageWarningReason::AlreadyStaged => "already staged",
    nafm_core::StageWarningReason::NotStaged => "not staged",
    nafm_core::StageWarningReason::WouldRemoveLastCopy => "would remove last copy",
  }
}

fn parent_folder_counts_from_duplicates(groups: &[nafm_core::DuplicateGroup]) -> BTreeMap<String, u64> {
  let mut counts = BTreeMap::new();
  for group in groups {
    for file in &group.files {
      let parent = file
        .path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .display()
        .to_string();
      *counts.entry(parent).or_insert(0) += 1;
    }
  }
  counts
}

#[derive(Clone, Debug, Serialize)]
struct SiteListEntry {
  site: nafm_core::Site,
  folders: Vec<nafm_core::SiteFolder>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum ScanEvent {
  Progress(nafm_core::ScanProgress),
  Summary(nafm_core::ScanSummary),
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use nafm_core::{DEFAULT_WORKSPACE_NAME, WorkspaceManager};

  use super::resolve_repository_cache_path;

  #[tokio::test]
  async fn explicit_workspace_requires_existing_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let manager = WorkspaceManager::new(temp.path().to_path_buf());
    manager.ensure_default_workspace(None).await.unwrap();

    let error = resolve_repository_cache_path(&manager, Some("missing"), None).unwrap_err();

    assert_eq!(error.to_string(), "workspace not found: missing");
  }

  #[tokio::test]
  async fn implicit_workspace_uses_default_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let manager = WorkspaceManager::new(temp.path().to_path_buf());
    manager.ensure_default_workspace(None).await.unwrap();

    let cache_path = resolve_repository_cache_path(&manager, None, None).unwrap();

    assert_eq!(
      cache_path,
      manager.workspace_db_path(DEFAULT_WORKSPACE_NAME).unwrap()
    );
  }

  #[test]
  fn cache_path_cannot_be_combined_with_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let manager = WorkspaceManager::new(temp.path().to_path_buf());

    let error =
      resolve_repository_cache_path(&manager, Some("alpha"), Some(PathBuf::from("cache.sqlite3"))).unwrap_err();

    assert_eq!(error.to_string(), "--cache cannot be combined with --workspace");
  }
}
