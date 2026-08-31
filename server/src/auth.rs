use crate::{
    db::Database,
    error::{AppError, AppResult},
    models::{AuthUser, User},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::Rng;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const SESSION_NEVER_EXPIRES: &str = "9999-12-31T23:59:59.999Z";

pub fn validate_username(username: &str) -> AppResult<String> {
    let value = username.trim();
    if value.len() < 3
        || value.len() > 32
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(AppError::BadRequest(
            "username must be 3-32 letters, numbers, hyphens, or underscores".into(),
        ));
    }
    Ok(value.to_string())
}

pub fn validate_password(password: &str) -> AppResult<()> {
    if password.is_empty() {
        return Err(AppError::BadRequest("password is required".into()));
    }
    Ok(())
}

pub fn hash_password(password: &str) -> AppResult<String> {
    validate_password(password)?;
    let mut salt_bytes = [0_u8; 16];
    rand::rng().fill(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes).map_err(AppError::internal)?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|value| value.to_string())
        .map_err(AppError::internal)
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .ok()
        .and_then(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .ok()
        })
        .is_some()
}

pub fn token_hash(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub async fn create_session(db: &Database, user: User) -> AppResult<(String, User)> {
    let mut bytes = [0_u8; 32];
    rand::rng().fill(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    sqlx::query(
        "INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&user.id)
    .bind(token_hash(&token))
    .bind(SESSION_NEVER_EXPIRES)
    .bind(Utc::now().to_rfc3339())
    .execute(&db.pool)
    .await?;
    Ok((token, user))
}

pub async fn authenticate(db: &Database, token: &str) -> AppResult<AuthUser> {
    db.auth_by_token_hash(&token_hash(token))
        .await?
        .ok_or(AppError::Unauthorized)
}
