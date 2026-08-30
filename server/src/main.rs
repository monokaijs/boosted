use boosted_server::{cli::Cli, run};
use clap::Parser;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("boosted_server=info".parse()?),
        )
        .init();
    run(Cli::parse().into_config()).await?;
    Ok(())
}
