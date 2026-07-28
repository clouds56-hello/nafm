mod app;
mod cli;
mod output;

use std::process::ExitCode;

use clap::Parser;

use crate::cli::Cli;
use crate::output::format_json_error;

#[tokio::main]
async fn main() -> ExitCode {
  let args = std::env::args_os().collect::<Vec<_>>();
  let wants_json = args.iter().any(|arg| arg == "--json");

  let cli = match Cli::try_parse_from(&args) {
    Ok(cli) => cli,
    Err(error) => {
      let exit_code = error.exit_code();
      if wants_json && exit_code != 0 {
        eprint!(
          "{}",
          format_json_error(&anyhow::Error::msg(error.to_string()))
            .unwrap_or_else(|_| { "{\"error\":\"failed to render error\"}\n".to_owned() })
        );
      } else {
        error.print().ok();
      }
      return ExitCode::from(u8::try_from(exit_code).unwrap_or(2));
    }
  };

  match app::run_with_cli(cli).await {
    Ok(()) => ExitCode::SUCCESS,
    Err(error) => {
      if wants_json {
        eprint!(
          "{}",
          format_json_error(&error).unwrap_or_else(|_| "{\"error\":\"failed to render error\"}\n".to_owned())
        );
      } else {
        eprintln!("Error: {error:?}");
      }
      ExitCode::from(1)
    }
  }
}
