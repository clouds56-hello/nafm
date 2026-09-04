use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct HostKey {
  pub host: String,
  pub key_type: String,
  pub fingerprint: String,
}

/// Parse only OpenSSH's initial unknown-host challenge, never IP mismatch,
/// changed/revoked keys, or a retry asking for a context-free yes/no answer.
pub fn parse(message: &str) -> Result<Option<HostKey>, &'static str> {
  let trust_prompt = message.contains("authenticity of host")
    || message.contains("continue connecting")
    || message.contains(" key fingerprint is")
    || message.contains("REMOTE HOST IDENTIFICATION")
    || message.contains("REVOKED HOST KEY")
    || message.starts_with("Please type 'yes'");
  if !trust_prompt {
    return Ok(None);
  }
  let mut lines = message.lines();
  let host = lines
    .next()
    .and_then(|line| line.strip_prefix("The authenticity of host '"))
    .and_then(|line| line.trim_end_matches('.').strip_suffix("' can't be established"))
    .filter(|host| !host.is_empty())
    .ok_or("Unrecognized SSH host-trust prompt; verify the host using system SSH")?;
  let line = lines.next().ok_or("Missing host fingerprint")?;
  let (key_type, fingerprint) = line
    .split_once(" key fingerprint is")
    .ok_or("Missing host fingerprint")?;
  let fingerprint = fingerprint
    .strip_prefix(':')
    .unwrap_or(fingerprint)
    .trim()
    .trim_end_matches('.');
  let valid_fingerprint = fingerprint.strip_prefix("SHA256:").is_some_and(|value| {
    value.len() == 43
      && value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/')
  });
  if !valid_fingerprint
    || key_type.is_empty()
    || !key_type
      .bytes()
      .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
    || !message
      .trim_end()
      .ends_with("Are you sure you want to continue connecting (yes/no/[fingerprint])?")
    || message.contains("REMOTE HOST IDENTIFICATION")
    || message.contains("REVOKED HOST KEY")
  {
    return Err("Unrecognized SSH host-trust prompt; verify the host using system SSH");
  }
  Ok(Some(HostKey {
    host: host.into(),
    key_type: key_type.into(),
    fingerprint: fingerprint.into(),
  }))
}

#[cfg(test)]
pub(super) mod tests {
  use super::*;
  pub const FINGERPRINT: &str = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
  pub fn challenge() -> String {
    format!(
      "The authenticity of host 'omv.lan (192.0.2.1)' can't be established.\nED25519 key fingerprint is {FINGERPRINT}.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
    )
  }
  #[test]
  fn parses_old_and_new_openssh_wording() {
    for message in [challenge(), challenge().replace("is SHA256:", "is: SHA256:")] {
      let key = parse(&message).unwrap().unwrap();
      assert_eq!(key.host, "omv.lan (192.0.2.1)");
      assert_eq!(key.key_type, "ED25519");
      assert_eq!(key.fingerprint, FINGERPRINT);
    }
    assert!(parse("Password:").unwrap().is_none());
    assert!(
      parse("Enter passphrase for key '/keys/fingerprint_key':")
        .unwrap()
        .is_none()
    );
  }
  #[test]
  fn never_accepts_changed_incomplete_or_context_free_prompts() {
    for message in [
      "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!".into(),
      "REVOKED HOST KEY DETECTED".into(),
      "Are you sure you want to continue connecting (yes/no)?".into(),
      "Please type 'yes', 'no' or the fingerprint: ".into(),
      challenge().replace(FINGERPRINT, "SHA256:invalid"),
      challenge().replace("SHA256:", "MD5:"),
    ] {
      assert!(parse(&message).is_err());
    }
  }
}
