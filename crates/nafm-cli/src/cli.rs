use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "nafm")]
#[command(about = "Manage sites and detect duplicate or missing files")]
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
  Site(SiteCommand),
  Scan {
    selector: String,
  },
  Duplicates {
    selector: String,
  },
  Missing {
    site: String,
    #[arg(long)]
    against: String,
  },
}

#[derive(Debug, Subcommand)]
pub enum SiteCommand {
  Create {
    name: String,
  },
  Add {
    site: String,
    folder: PathBuf,
    #[arg(long, value_enum, default_value_t = HiddenArg::Include)]
    hidden: HiddenArg,
  },
  List,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum HiddenArg {
  Include,
  Skip,
}
