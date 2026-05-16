use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "nafm")]
#[command(about = "Manage folders and find duplicate files")]
pub struct Cli {
  #[arg(long, global = true)]
  pub cache: Option<PathBuf>,
  #[arg(long, global = true)]
  pub json: bool,
  #[arg(long, global = true)]
  pub no_color: bool,
  #[command(subcommand)]
  pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
  #[command(subcommand)]
  Folder(FolderCommand),
  Scan {
    selector: Option<String>,
  },
  Duplicates {
    selector: Option<String>,
  },
  Trash {
    #[arg(long)]
    group: String,
    #[arg(long)]
    keep: String,
    #[arg(long)]
    dry_run: bool,
  },
}

#[derive(Debug, Subcommand)]
pub enum FolderCommand {
  Add {
    path: PathBuf,
    #[arg(long)]
    alias: Option<String>,
    #[arg(long, value_enum, default_value_t = HiddenArg::Include)]
    hidden: HiddenArg,
  },
  List,
  Remove {
    selector: String,
  },
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum HiddenArg {
  Include,
  Skip,
}
