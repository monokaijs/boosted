use clap::{Parser, Subcommand};
use std::{net::SocketAddr, path::PathBuf};

use crate::Config;

#[derive(Debug, Parser)]
#[command(
    name = "boosted",
    version,
    about = "Run the Boosted web workspace without a desktop shell"
)]
pub struct Cli {
    /// Address on which the web server listens.
    #[arg(
        long,
        global = true,
        env = "BOOSTED_BIND",
        default_value = "127.0.0.1:4782",
        value_name = "ADDRESS"
    )]
    bind: SocketAddr,

    /// Directory used for the database, uploads, and managed worktrees.
    #[arg(long, global = true, env = "BOOSTED_DATA_DIR", value_name = "PATH")]
    data_dir: Option<PathBuf>,

    /// Serve frontend files from this directory instead of the embedded web app.
    #[arg(long, global = true, env = "BOOSTED_WEB_DIR", value_name = "PATH")]
    web_dir: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Clone, Debug, Subcommand)]
enum Command {
    /// Serve the Boosted web app and API in headless mode.
    Serve,
}

impl Cli {
    pub fn into_config(self) -> Config {
        match self.command.unwrap_or(Command::Serve) {
            Command::Serve => Config {
                bind: self.bind,
                data_dir: self.data_dir.unwrap_or_else(Config::default_data_dir),
                web_dir: self.web_dir.unwrap_or_else(Config::default_web_dir),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_serving_headlessly() {
        let config = Cli::try_parse_from(["boosted"])
            .expect("default CLI arguments")
            .into_config();

        assert_eq!(config.bind, "127.0.0.1:4782".parse().unwrap());
    }

    #[test]
    fn accepts_serve_options_after_the_subcommand() {
        let config = Cli::try_parse_from([
            "boosted",
            "serve",
            "--bind",
            "0.0.0.0:8080",
            "--data-dir",
            "/var/lib/boosted",
            "--web-dir",
            "/srv/boosted/web",
        ])
        .expect("serve CLI arguments")
        .into_config();

        assert_eq!(config.bind, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(config.data_dir, PathBuf::from("/var/lib/boosted"));
        assert_eq!(config.web_dir, PathBuf::from("/srv/boosted/web"));
    }
}
