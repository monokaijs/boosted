use boosted_server::{Config, run};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("boosted_server=info".parse()?),
        )
        .init();
    run(Config::from_env()).await?;
    Ok(())
}
