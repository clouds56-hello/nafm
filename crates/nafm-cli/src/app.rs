use anyhow::Result;
use clap::Parser;
use nafm_core::{AddFolderRequest, HiddenPolicy, Repository, RepositoryOptions};

use crate::cli::{Cli, Command, FolderCommand, HiddenArg};
use crate::output::{folder_label, print_json_or, spinner};

pub async fn run() -> Result<()> {
  let cli = Cli::parse();
  let repo = match cli.cache {
    Some(cache_path) => Repository::open(RepositoryOptions { cache_path }).await?,
    None => Repository::open_default().await?,
  };

  match cli.command {
    Command::Folder(command) => handle_folder(&repo, command, cli.json).await?,
    Command::Scan { selector } => handle_scan(&repo, selector, cli.json).await?,
    Command::Duplicates { selector } => handle_duplicates(&repo, selector, cli.json).await?,
    Command::Trash { group, keep, dry_run } => handle_trash(&repo, group, keep, dry_run, cli.json).await?,
  }

  Ok(())
}

async fn handle_folder(repo: &Repository, command: FolderCommand, json: bool) -> Result<()> {
  match command {
    FolderCommand::Add { path, alias, hidden } => {
      let folder = repo
        .add_folder(AddFolderRequest {
          path,
          alias,
          hidden_policy: hidden.into(),
        })
        .await?;
      print_json_or(json, &folder, || {
        println!(
          "added folder {}",
          folder_label(&folder.id, folder.alias.as_deref(), &folder.path)
        );
      })?;
    }
    FolderCommand::List => {
      let folders = repo.list_folders().await?;
      print_json_or(json, &folders, || {
        if folders.is_empty() {
          println!("no folders registered");
        } else {
          for folder in &folders {
            println!(
              "{}  {}  hidden={:?}",
              folder.id,
              folder.alias.as_deref().unwrap_or("-"),
              folder.hidden_policy
            );
            println!("  {}", folder.path.display());
          }
        }
      })?;
    }
    FolderCommand::Remove { selector } => {
      let removed = repo.remove_folder(&selector).await?;
      print_json_or(json, &removed, || match &removed {
        Some(folder) => println!("removed folder {}", folder.path.display()),
        None => println!("folder not found: {selector}"),
      })?;
    }
  }
  Ok(())
}

async fn handle_scan(repo: &Repository, selector: Option<String>, json: bool) -> Result<()> {
  let spinner = spinner(json, "scanning");
  let summaries = match selector {
    Some(selector) => vec![repo.scan_folder(&selector).await?],
    None => repo.scan_all().await?,
  };
  spinner.finish_and_clear();

  print_json_or(json, &summaries, || {
    if summaries.is_empty() {
      println!("no folders registered");
    }
    for summary in &summaries {
      println!(
        "folder {}: {} files, {} hashed, {} reused, {} duplicate groups",
        summary.folder_id, summary.files_seen, summary.files_hashed, summary.files_reused, summary.duplicate_groups
      );
    }
  })?;
  Ok(())
}

async fn handle_duplicates(repo: &Repository, selector: Option<String>, json: bool) -> Result<()> {
  let groups = repo.find_duplicates(selector.as_deref()).await?;
  print_json_or(json, &groups, || {
    if groups.is_empty() {
      println!("no duplicates found");
    }
    for group in &groups {
      println!(
        "group {}: {} files, {} bytes each",
        group.group_id,
        group.files.len(),
        group.size_bytes
      );
      for file in &group.files {
        println!("  {}  {}", file.file_id, file.path.display());
      }
    }
  })?;
  Ok(())
}

async fn handle_trash(repo: &Repository, group: String, keep: String, dry_run: bool, json: bool) -> Result<()> {
  let plan = repo.trash_duplicate_group(&group, &keep, dry_run).await?;
  print_json_or(json, &plan, || {
    let verb = if dry_run { "would trash" } else { "trashed" };
    println!(
      "{} {} files from group {}; kept {}",
      verb,
      plan.trashed_files.len(),
      plan.group_id,
      plan.kept_file_id
    );
    for file in &plan.trashed_files {
      println!("  {}", file.path.display());
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
