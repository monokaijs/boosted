use clap::{Parser, Subcommand};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};

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
        conflicts_with = "port",
        value_name = "ADDRESS"
    )]
    bind: Option<SocketAddr>,

    /// Public web port. Ignored when --bind is provided.
    #[arg(
        long,
        global = true,
        env = "BOOSTED_PORT",
        conflicts_with = "bind",
        value_parser = clap::value_parser!(u16).range(1..),
        value_name = "PORT"
    )]
    port: Option<u16>,

    /// Directory used for the database, uploads, and managed worktrees.
    #[arg(long, global = true, env = "BOOSTED_DATA_DIR", value_name = "PATH")]
    data_dir: Option<PathBuf>,

    /// Serve frontend files from this directory instead of the embedded web app.
    #[arg(long, global = true, env = "BOOSTED_WEB_DIR", value_name = "PATH")]
    web_dir: Option<PathBuf>,

    /// Disable serving the browser UI while keeping the API available.
    #[arg(
        long,
        global = true,
        env = "BOOSTED_DISABLE_WEB_UI",
        conflicts_with = "enable_web_ui"
    )]
    disable_web_ui: bool,

    /// Serve the browser UI even when the saved global setting disables it.
    #[arg(long, global = true, conflicts_with = "disable_web_ui")]
    enable_web_ui: bool,

    /// Only accept remote clients with this IP. Repeat for multiple IPs.
    #[arg(
        long,
        global = true,
        env = "BOOSTED_ALLOWED_IPS",
        value_delimiter = ',',
        conflicts_with = "public",
        value_name = "IP"
    )]
    allow_ip: Vec<IpAddr>,

    /// Accept all remote IPs even when a saved allowlist exists.
    #[arg(long, global = true, conflicts_with = "allow_ip")]
    public: bool,

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
                bind: self.bind.or_else(|| {
                    self.port
                        .map(|port| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port))
                }),
                local_bind: None,
                data_dir: self.data_dir.unwrap_or_else(Config::default_data_dir),
                web_dir: self.web_dir.unwrap_or_else(Config::default_web_dir),
                web_ui_enabled: if self.disable_web_ui {
                    Some(false)
                } else if self.enable_web_ui {
                    Some(true)
                } else {
                    None
                },
                allowed_ips: if self.public {
                    Some(Vec::new())
                } else if self.allow_ip.is_empty() {
                    None
                } else {
                    Some(self.allow_ip)
                },
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_saved_settings_and_public_fallback() {
        let config = Cli::try_parse_from(["boosted"])
            .expect("default CLI arguments")
            .into_config();

        assert_eq!(config.bind, None);
        assert_eq!(config.web_ui_enabled, None);
        assert_eq!(config.allowed_ips, None);
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

        assert_eq!(config.bind, Some("0.0.0.0:8080".parse().unwrap()));
        assert_eq!(config.data_dir, PathBuf::from("/var/lib/boosted"));
        assert_eq!(config.web_dir, PathBuf::from("/srv/boosted/web"));
    }

    #[test]
    fn accepts_web_access_overrides() {
        let config = Cli::try_parse_from([
            "boosted",
            "serve",
            "--port",
            "9000",
            "--disable-web-ui",
            "--allow-ip",
            "192.0.2.10",
            "--allow-ip",
            "2001:db8::10",
        ])
        .expect("web access CLI arguments")
        .into_config();

        assert_eq!(config.bind, Some("0.0.0.0:9000".parse().unwrap()));
        assert_eq!(config.web_ui_enabled, Some(false));
        assert_eq!(
            config.allowed_ips,
            Some(vec![
                "192.0.2.10".parse().unwrap(),
                "2001:db8::10".parse().unwrap()
            ])
        );
    }
}
