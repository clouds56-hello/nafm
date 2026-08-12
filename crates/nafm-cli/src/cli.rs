use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(name = "nafm")]
#[command(about = "Manage sites and detect duplicate or missing files")]
pub struct Cli {
  #[arg(long, global = true)]
  pub cache: Option<PathBuf>,
  #[arg(long, global = true)]
  pub workspace: Option<String>,
  #[arg(long, global = true)]
  pub json: bool,
  #[arg(long, global = true)]
  pub no_color: bool,
  #[command(subcommand)]
  pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
  /// Verify and save credentials for an SMB share.
  Connect {
    #[arg(value_name = "SMB_URL")]
    url: String,
    /// Username used to authenticate with the SMB server.
    #[arg(long)]
    username: String,
  },
  /// Show the current workspace, sites, and saved connections.
  Status,
  #[command(subcommand)]
  Workspace(WorkspaceCommand),
  #[command(subcommand)]
  Site(SiteCommand),
  #[command(subcommand)]
  Stage(StageCommand),
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

#[derive(Debug, Subcommand)]
pub enum WorkspaceCommand {
  Create {
    name: String,
    #[arg(long)]
    activate: bool,
  },
  Activate {
    name: String,
  },
  Current,
  List,
}

#[derive(Debug, Subcommand)]
pub enum StageCommand {
  Add { path: PathBuf },
  Remove { path: PathBuf },
  Undo,
  Redo,
  Reset,
  Commit,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum HiddenArg {
  Include,
  Skip,
}

#[cfg(test)]
mod tests {
  use clap::Parser;

  use super::{Cli, Command, SiteCommand};

  #[test]
  fn parses_smb_connect_command() {
    let cli = Cli::try_parse_from(["nafm", "connect", "smb://nas.example.test/Media", "--username", "alice"]).unwrap();

    assert!(matches!(
      cli.command,
      Command::Connect { url, username }
        if url == "smb://nas.example.test/Media" && username == "alice"
    ));
  }

  #[test]
  fn parses_status_command() {
    let cli = Cli::try_parse_from(["nafm", "status"]).unwrap();

    assert!(matches!(cli.command, Command::Status));
  }

  #[test]
  fn parses_json_before_subcommand() {
    let cli = Cli::try_parse_from(["nafm", "--json", "site", "list"]).unwrap();

    assert!(cli.json);
    assert!(matches!(cli.command, Command::Site(SiteCommand::List)));
  }

  #[test]
  fn parses_json_after_subcommand() {
    let cli = Cli::try_parse_from(["nafm", "site", "list", "--json"]).unwrap();

    assert!(cli.json);
    assert!(matches!(cli.command, Command::Site(SiteCommand::List)));
  }

  #[test]
  fn parses_json_between_nested_subcommands() {
    let cli = Cli::try_parse_from(["nafm", "site", "--json", "list"]).unwrap();

    assert!(cli.json);
    assert!(matches!(cli.command, Command::Site(SiteCommand::List)));
  }
}
