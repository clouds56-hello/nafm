mod app;
mod cli;
mod output;

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
  app::run().await
}
