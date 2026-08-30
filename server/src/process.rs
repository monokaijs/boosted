use std::ffi::OsStr;
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Creates a command for background work owned by the Boosted UI.
///
/// A Windows desktop build has no parent console. Without `CREATE_NO_WINDOW`,
/// starting a console-subsystem executable such as Git or Codex makes Windows
/// allocate a visible console window for it.
#[cfg(windows)]
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    Command::new(program)
}
