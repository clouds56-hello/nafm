use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::Result;
use clap::Parser;
use nafm_core::{AddSiteFolderRequest, HiddenPolicy, Repository, RepositoryOptions};

use crate::cli::{Cli, Command, HiddenArg, SiteCommand};
use crate::output::{print_json_or, site_folder_label, spinner};

pub async fn run() -> Result<()> {
  let cli = Cli::parse();
  let repo = match cli.cache {
    Some(cache_path) => {
      Repository::open(RepositoryOptions {
        cache_path,
        hash_algorithm: None,
      })
      .await?
    }
    None => Repository::open_default().await?,
  };

  match cli.command {
    Command::Site(command) => handle_site(&repo, command, cli.json).await?,
    Command::Scan { selector } => handle_scan(&repo, &selector, cli.json).await?,
    Command::Duplicates { selector } => handle_duplicates(&repo, &selector, cli.json).await?,
    Command::Missing { site, against } => handle_missing(&repo, &site, &against, cli.json).await?,
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
        .map(|site| (site, folders_by_site.get(&site.id).cloned().unwrap_or_default()))
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
    None
  } else {
    let spinner = spinner.clone();
    Some(Arc::new(move |progress: &nafm_core::ScanProgress| {
      spinner.set_message(format!(
        "scanning {}/{} {}",
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
  Ok(())
}

async fn handle_duplicates(repo: &Repository, selector: &str, json: bool) -> Result<()> {
  let groups = if selector == "all" {
    repo.find_duplicates(None).await?
  } else {
    repo.find_duplicates(Some(selector)).await?
  };
  print_json_or(json, &groups, || {
    if groups.is_empty() {
      println!("no duplicates found");
    }
    for group in &groups {
      println!(
        "group {}: {} files, {} bytes each, algo={}",
        group.group_id,
        group.files.len(),
        group.size_bytes,
        group.hash_algorithm
      );
      for file in &group.files {
        println!("  {}  {}", file.file_id, file.path.display());
      }
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
