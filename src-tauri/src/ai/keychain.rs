//! Secrets in the OS keychain (Windows Credential Manager, macOS Keychain). Service `"Novel AI
//! Tutor"`, account = the connection id. Nothing here (or anywhere) reads a secret back to the
//! webview: the only reader is the connection resolver, in Rust.
//!
//! Errors never carry the secret: a keychain failure is mapped to a fixed message by its kind and
//! the platform error text is dropped.

use super::{AiError, Secret};

/// The keychain service name.
pub const SERVICE: &str = "Novel AI Tutor";

/// Longest secret accepted (sanity bound; the platform has its own, smaller one).
pub const MAX_SECRET_BYTES: usize = 16 * 1024;
/// Longest connection id accepted.
pub const MAX_ID_BYTES: usize = 128;

/// Where secrets live. The app uses [`KeyringStore`]; tests use the keyring crate's mock or an
/// in-memory store.
pub trait SecretStore: Send + Sync + 'static {
    fn set(&self, connection_id: &str, secret: &str) -> Result<(), AiError>;
    /// `Ok(None)` when there is no secret for the connection.
    fn get(&self, connection_id: &str) -> Result<Option<Secret>, AiError>;
    /// Deleting a missing secret is not an error.
    fn delete(&self, connection_id: &str) -> Result<(), AiError>;
}

/// The OS keychain through the `keyring` crate. A secret longer than one keychain entry holds (Windows
/// Credential Manager: 2,560 bytes, stored as UTF-16, so 1,280 characters) is split over several
/// entries (see [`chunked_set`]); a ChatGPT sign-in's token record is that long.
pub struct KeyringStore;

/// One OS keychain entry per account, no splitting.
struct RawKeyring;

fn entry(account: &str) -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(SERVICE, account).map_err(|e| keychain_error(&e))
}

/// A fixed message per failure kind. The keyring error's own text is never used.
fn keychain_error(e: &keyring::Error) -> AiError {
    let message = match e {
        keyring::Error::NoStorageAccess(_) => "The system keychain is locked or not available.",
        keyring::Error::TooLong(..) => "The credential is too long for the system keychain.",
        keyring::Error::Invalid(..) => "The credential cannot be stored in the system keychain.",
        keyring::Error::BadEncoding(_) => "The stored credential could not be read.",
        _ => "The system keychain could not be used.",
    };
    AiError::new("auth", message)
}

impl SecretStore for RawKeyring {
    fn set(&self, account: &str, secret: &str) -> Result<(), AiError> {
        entry(account)?.set_password(secret).map_err(|e| keychain_error(&e))
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, AiError> {
        match entry(account)?.get_password() {
            Ok(s) => Ok(Some(Secret::new(s))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), AiError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(&e)),
        }
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, connection_id: &str, secret: &str) -> Result<(), AiError> {
        chunked_set(&RawKeyring, connection_id, secret)
    }

    fn get(&self, connection_id: &str) -> Result<Option<Secret>, AiError> {
        chunked_get(&RawKeyring, connection_id)
    }

    fn delete(&self, connection_id: &str) -> Result<(), AiError> {
        chunked_delete(&RawKeyring, connection_id)
    }
}

// ---- Splitting a long secret over several entries --------------------------------------------------
//
// A long secret is stored as a *generation* of parts plus a small manifest in the head entry:
//
//   <id>            "novel-chunked:2:<gen>:<count>:<sha256 hex of the whole secret>"
//   <id>#<slot>#<k> part k (k = 0 .. count-1), slot = gen % 2
//
// A write puts the new parts in the slot the current manifest does not use, then replaces the
// manifest in one keychain write (the switch), then deletes the old slot's parts. So:
// - a failed or interrupted write leaves the old manifest and its parts as they were;
// - a reader always gets a manifest whose parts were written before it; if the parts it reads do not
//   match the manifest's checksum (a reader that still held the old manifest while a later write
//   reused its slot), the read is retried once and then reported as transient, never as signed out;
// - parts left over by a crash sit in the unused slot and are removed by the next write or delete
//   (each slot is cleared from its first missing part on: parts are always contiguous from 0).
// A short secret is the head entry itself, as before.

/// UTF-16 units per entry: under Windows' 1,280.
pub const CHUNK_UNITS: usize = 1000;
/// Most parts one secret may use (`MAX_SECRET_BYTES` fits).
const MAX_CHUNKS: usize = 40;
/// A manifest starts with this. No plain value starts so: every value is a binding wrapper, JSON
/// starting with `{` (connections.rs).
const MANIFEST: &str = "novel-chunked:2:";
/// The first format (one generation, parts `<id>#1..`); still read and deleted, never written.
const LEGACY_HEAD: &str = "novel-chunked:1:";

/// The error of a read that met a write in progress: retry, the sign-in is not lost.
pub fn transient() -> AiError {
    AiError::new("network", "The saved sign-in was being updated. Try again.")
}

fn part_account(connection_id: &str, slot: u64, k: usize) -> String {
    format!("{connection_id}#{slot}#{k}")
}

fn legacy_part(connection_id: &str, k: usize) -> String {
    format!("{connection_id}#{k}")
}

fn sha256_hex(s: &str) -> String {
    ring::digest::digest(&ring::digest::SHA256, s.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// What a head entry holds.
enum Head<'a> {
    Plain,
    Manifest { gen: u64, count: usize, sum: &'a str },
    /// The first format: part count and the first piece.
    Legacy { count: usize, first: &'a str },
    /// Starts like a manifest but cannot be read.
    Damaged,
}

fn head_of(value: &str) -> Head<'_> {
    if let Some(rest) = value.strip_prefix(MANIFEST) {
        let mut f = rest.split(':');
        let (Some(g), Some(n), Some(sum), None) = (f.next(), f.next(), f.next(), f.next()) else { return Head::Damaged };
        return match (g.parse::<u64>(), n.parse::<usize>()) {
            (Ok(gen), Ok(count)) if (2..=MAX_CHUNKS).contains(&count) && sum.len() == 64 => Head::Manifest { gen, count, sum },
            _ => Head::Damaged,
        };
    }
    if let Some(rest) = value.strip_prefix(LEGACY_HEAD) {
        return match rest.split_once(':').and_then(|(n, first)| n.parse::<usize>().ok().map(|n| (n, first))) {
            Some((count, first)) if (2..=MAX_CHUNKS).contains(&count) => Head::Legacy { count, first },
            _ => Head::Damaged,
        };
    }
    Head::Plain
}

/// Pieces of at most `CHUNK_UNITS` UTF-16 units, never cut inside a character.
fn split(secret: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut units) = (0, 0);
    for (i, c) in secret.char_indices() {
        if units + c.len_utf16() > CHUNK_UNITS {
            parts.push(&secret[start..i]);
            start = i;
            units = 0;
        }
        units += c.len_utf16();
    }
    parts.push(&secret[start..]);
    parts
}

/// Delete a slot's parts from `from` on, up to the first missing one. False if one could not be deleted.
fn clear_slot(raw: &dyn SecretStore, connection_id: &str, slot: u64, from: usize) -> bool {
    let mut ok = true;
    for k in from..MAX_CHUNKS {
        let account = part_account(connection_id, slot, k);
        match raw.get(&account) {
            Ok(None) => break,
            Ok(Some(_)) => ok &= raw.delete(&account).is_ok(),
            Err(_) => ok &= raw.delete(&account).is_ok(),
        }
    }
    ok
}

/// Delete the first format's parts. False if one could not be deleted.
fn clear_legacy(raw: &dyn SecretStore, connection_id: &str, count: usize) -> bool {
    let mut ok = true;
    for k in 1..count {
        ok &= raw.delete(&legacy_part(connection_id, k)).is_ok();
    }
    ok
}

/// Store `secret` under `connection_id` (see the section comment). On error the earlier value is still
/// readable.
pub fn chunked_set(raw: &dyn SecretStore, connection_id: &str, secret: &str) -> Result<(), AiError> {
    let parts = split(secret);
    if parts.len() > MAX_CHUNKS {
        return Err(AiError::bad_request("The credential is empty or too long."));
    }
    // An unreadable head is not overwritten blind: its slot is unknown.
    let old = raw.get(connection_id)?;
    let old_head = old.as_ref().map(|s| s.expose());
    let (old_gen, old_slot, legacy_count) = match old_head.map(head_of) {
        Some(Head::Manifest { gen, .. }) => (gen, Some(gen % 2), 0),
        Some(Head::Legacy { count, .. }) => (0, None, count),
        _ => (0, None, 0),
    };
    if parts.len() == 1 {
        raw.set(connection_id, secret)?;
    } else {
        let gen = old_gen + 1;
        let slot = gen % 2;
        let written = (|| {
            for (k, part) in parts.iter().enumerate() {
                raw.set(&part_account(connection_id, slot, k), part)?;
            }
            // Leftovers of a longer, interrupted write in this slot.
            clear_slot(raw, connection_id, slot, parts.len());
            raw.set(connection_id, &format!("{MANIFEST}{gen}:{}:{}", parts.len(), sha256_hex(secret)))
        })();
        if let Err(e) = written {
            // The old manifest still points at the other slot; this slot's parts are spare.
            clear_slot(raw, connection_id, slot, 0);
            return Err(e);
        }
    }
    if let Some(s) = old_slot {
        clear_slot(raw, connection_id, s, 0);
    }
    if legacy_count > 0 {
        clear_legacy(raw, connection_id, legacy_count);
    }
    Ok(())
}

fn read_once(raw: &dyn SecretStore, connection_id: &str) -> Result<Option<Result<Secret, ()>>, AiError> {
    let Some(head) = raw.get(connection_id)? else { return Ok(None) };
    match head_of(head.expose()) {
        Head::Plain => Ok(Some(Ok(head))),
        Head::Damaged => Ok(Some(Err(()))),
        Head::Legacy { count, first } => {
            let mut whole = String::from(first);
            for k in 1..count {
                match raw.get(&legacy_part(connection_id, k))? {
                    Some(p) => whole.push_str(p.expose()),
                    None => return Ok(Some(Err(()))),
                }
            }
            Ok(Some(Ok(Secret::new(whole))))
        }
        Head::Manifest { gen, count, sum } => {
            let mut whole = String::new();
            for k in 0..count {
                match raw.get(&part_account(connection_id, gen % 2, k))? {
                    Some(p) => whole.push_str(p.expose()),
                    None => return Ok(Some(Err(()))),
                }
            }
            Ok(Some(if sha256_hex(&whole) == sum { Ok(Secret::new(whole)) } else { Err(()) }))
        }
    }
}

/// The secret under `connection_id`, put back together and checked. A read that does not match its
/// manifest is retried once; if it still does not, the error is [`transient`].
pub fn chunked_get(raw: &dyn SecretStore, connection_id: &str) -> Result<Option<Secret>, AiError> {
    for _ in 0..2 {
        match read_once(raw, connection_id)? {
            None => return Ok(None),
            Some(Ok(s)) => return Ok(Some(s)),
            Some(Err(())) => continue,
        }
    }
    Err(transient())
}

/// Delete the secret and every part of it, also when the head cannot be read (both slots are cleared).
/// Deleting a missing secret is not an error. A part that could not be deleted is reported after the
/// rest is done.
pub fn chunked_delete(raw: &dyn SecretStore, connection_id: &str) -> Result<(), AiError> {
    let head = raw.get(connection_id);
    let mut parts_ok = true;
    if let Ok(Some(h)) = &head {
        if let Head::Legacy { count, .. } = head_of(h.expose()) {
            parts_ok &= clear_legacy(raw, connection_id, count);
        }
    }
    if head.is_err() {
        parts_ok &= clear_legacy(raw, connection_id, MAX_CHUNKS);
    }
    parts_ok &= clear_slot(raw, connection_id, 0, 0);
    parts_ok &= clear_slot(raw, connection_id, 1, 0);
    raw.delete(connection_id)?;
    if parts_ok {
        Ok(())
    } else {
        Err(AiError::new("auth", "Part of the saved credential could not be removed from the system keychain."))
    }
}

fn check_id(connection_id: &str) -> Result<(), AiError> {
    // `#` separates a split secret's parts (`<id>#<slot>#<k>`): an id with one could alias them.
    if connection_id.is_empty() || connection_id.len() > MAX_ID_BYTES || connection_id.chars().any(|c| c.is_control() || c == '#') {
        return Err(AiError::bad_request("The connection id is not valid."));
    }
    Ok(())
}

/// A secret must not be empty or oversized.
pub fn check_secret(secret: &str) -> Result<(), AiError> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        return Err(AiError::bad_request("The credential is empty or too long."));
    }
    Ok(())
}

/// Store a secret for a connection (replacing any earlier one).
pub fn set_secret(store: &dyn SecretStore, connection_id: &str, secret: &str) -> Result<(), AiError> {
    check_id(connection_id)?;
    check_secret(secret)?;
    store.set(connection_id, secret)
}

pub fn delete_secret(store: &dyn SecretStore, connection_id: &str) -> Result<(), AiError> {
    check_id(connection_id)?;
    store.delete(connection_id)
}

#[cfg(test)]
pub fn has_secret(store: &dyn SecretStore, connection_id: &str) -> Result<bool, AiError> {
    check_id(connection_id)?;
    Ok(store.get(connection_id)?.is_some())
}

#[cfg(test)]
pub mod testing {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// An in-memory store (the keyring mock keeps no state between `Entry` values).
    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn set(&self, id: &str, secret: &str) -> Result<(), AiError> {
            self.0.lock().unwrap().insert(id.to_owned(), secret.to_owned());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<Secret>, AiError> {
            Ok(self.0.lock().unwrap().get(id).cloned().map(Secret::new))
        }
        fn delete(&self, id: &str) -> Result<(), AiError> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::testing::MemoryStore;
    use super::*;

    #[test]
    fn secret_round_trip_has_delete() {
        let store = MemoryStore::default();
        assert!(!has_secret(&store, "c1").unwrap());
        set_secret(&store, "c1", "sk-abc").unwrap();
        assert!(has_secret(&store, "c1").unwrap());
        assert_eq!(store.get("c1").unwrap().unwrap().expose(), "sk-abc");
        set_secret(&store, "c1", "sk-def").unwrap();
        assert_eq!(store.get("c1").unwrap().unwrap().expose(), "sk-def");
        delete_secret(&store, "c1").unwrap();
        assert!(!has_secret(&store, "c1").unwrap());
        delete_secret(&store, "c1").unwrap(); // deleting a missing secret is fine
    }

    #[test]
    fn rejects_bad_ids_and_empty_secrets() {
        let store = MemoryStore::default();
        for id in ["", "a\nb", &"x".repeat(MAX_ID_BYTES + 1)] {
            assert_eq!(set_secret(&store, id, "k").unwrap_err().kind, "bad_request");
            assert!(has_secret(&store, id).is_err());
            assert!(delete_secret(&store, id).is_err());
        }
        assert_eq!(set_secret(&store, "c1", "").unwrap_err().kind, "bad_request");
    }

    /// The fake keychain with hooks: a `set` can be made to fail, and a callback can run after the first
    /// `get` of the head (to interleave writes into a read).
    type Hook<F> = Mutex<Option<Box<F>>>;

    #[derive(Default)]
    struct Hooked {
        inner: MemoryStore,
        fail_set: Hook<dyn Fn(&str) -> bool + Send>,
        fail_get: Mutex<Option<String>>,
        before_set: Hook<dyn Fn(&MemoryStore) + Send>,
        after_head_get: Hook<dyn FnOnce(&MemoryStore) + Send>,
    }

    impl SecretStore for Hooked {
        fn set(&self, id: &str, secret: &str) -> Result<(), AiError> {
            if let Some(f) = self.before_set.lock().unwrap().as_ref() {
                f(&self.inner);
            }
            if self.fail_set.lock().unwrap().as_ref().is_some_and(|f| f(id)) {
                return Err(AiError::new("auth", "The system keychain could not be used."));
            }
            self.inner.set(id, secret)
        }
        fn get(&self, id: &str) -> Result<Option<Secret>, AiError> {
            if self.fail_get.lock().unwrap().as_deref() == Some(id) {
                return Err(AiError::new("auth", "The system keychain could not be used."));
            }
            let got = self.inner.get(id);
            if !id.contains('#') {
                if let Some(hook) = self.after_head_get.lock().unwrap().take() {
                    hook(&self.inner);
                }
            }
            got
        }
        fn delete(&self, id: &str) -> Result<(), AiError> {
            self.inner.delete(id)
        }
    }

    fn long(c: char, n: usize) -> String {
        format!("{{{}}}", c.to_string().repeat(n))
    }

    fn keys(m: &MemoryStore) -> Vec<String> {
        let mut k: Vec<String> = m.0.lock().unwrap().keys().cloned().collect();
        k.sort();
        k
    }

    #[test]
    fn a_long_secret_is_split_into_a_generation_with_a_checked_manifest() {
        let raw = MemoryStore::default();
        // A two-unit character straddles the first boundary.
        let secret = format!("{{{}\u{1F600}{}}}", "a".repeat(CHUNK_UNITS - 2), "b".repeat(CHUNK_UNITS * 2));
        chunked_set(&raw, "c1", &secret).unwrap();
        assert_eq!(keys(&raw), ["c1", "c1#1#0", "c1#1#1", "c1#1#2", "c1#1#3"]);
        {
            let m = raw.0.lock().unwrap();
            assert!(m.values().all(|v| v.encode_utf16().count() < 1280), "every entry fits Windows' limit");
            assert_eq!(m["c1"], format!("novel-chunked:2:1:4:{}", sha256_hex(&secret)));
        }
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), secret);
        // The next write uses the other slot and removes the old one.
        let next = long('n', CHUNK_UNITS + 5);
        chunked_set(&raw, "c1", &next).unwrap();
        assert_eq!(keys(&raw), ["c1", "c1#0#0", "c1#0#1"]);
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), next);
        // A short value is the head itself; the parts go.
        chunked_set(&raw, "c1", "{short}").unwrap();
        assert_eq!(keys(&raw), ["c1"]);
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), "{short}");
        chunked_set(&raw, "c1", &secret).unwrap();
        chunked_delete(&raw, "c1").unwrap();
        assert!(keys(&raw).is_empty());
        assert!(chunked_get(&raw, "c1").unwrap().is_none());
        chunked_delete(&raw, "c1").unwrap();
        assert!(chunked_set(&raw, "c2", &"y".repeat(CHUNK_UNITS * (MAX_CHUNKS + 1))).is_err());
    }

    #[test]
    fn a_read_during_a_write_sees_the_old_or_the_new_value_never_a_torn_one() {
        let old = long('o', CHUNK_UNITS * 2);
        let new = long('n', CHUNK_UNITS * 3);
        let raw = Hooked::default();
        chunked_set(&raw, "c1", &old).unwrap();
        // Read after every step of the write (each `set` of a part, then the switch).
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        *raw.before_set.lock().unwrap() = Some(Box::new(move |inner| {
            s2.lock().unwrap().push(chunked_get(inner, "c1").map(|s| s.map(|s| s.expose().to_owned())));
        }));
        chunked_set(&raw, "c1", &new).unwrap();
        *raw.before_set.lock().unwrap() = None;
        let seen = seen.lock().unwrap();
        assert!(seen.len() >= 4, "{}", seen.len());
        for r in seen.iter() {
            let v = r.as_ref().unwrap().as_deref().unwrap();
            assert!(v == old, "before the switch a reader sees the old value");
        }
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), new);
    }

    #[test]
    fn a_reader_holding_an_old_manifest_retries_and_gets_the_latest_value() {
        let raw = Hooked::default();
        chunked_set(&raw, "c1", &long('a', CHUNK_UNITS * 2)).unwrap();
        let latest = long('c', CHUNK_UNITS * 2);
        let l2 = latest.clone();
        // Between the reader's head read and its part reads, two writes land: the second reuses the
        // slot the reader's (old) manifest names, so its parts no longer match that manifest.
        *raw.after_head_get.lock().unwrap() = Some(Box::new(move |inner| {
            chunked_set(inner, "c1", &long('b', CHUNK_UNITS * 2)).unwrap();
            chunked_set(inner, "c1", &l2).unwrap();
        }));
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), latest);
    }

    #[test]
    fn a_read_that_never_matches_is_transient_not_signed_out() {
        let raw = MemoryStore::default();
        chunked_set(&raw, "c1", &long('x', CHUNK_UNITS * 2)).unwrap();
        raw.0.lock().unwrap().insert("c1#1#1".into(), "tampered".into());
        let e = chunked_get(&raw, "c1").unwrap_err();
        assert_eq!(e.kind, "network");
        assert!(e.message.contains("Try again") && !e.message.contains("xxxx"));
        raw.0.lock().unwrap().remove("c1#1#1");
        assert_eq!(chunked_get(&raw, "c1").unwrap_err().kind, "network", "a missing part too");
    }

    #[test]
    fn a_failed_write_leaves_the_old_value_readable_and_no_spare_parts() {
        let old = long('o', CHUNK_UNITS * 2);
        for (what, fails) in [("a part", "c1#0#1"), ("the switch", "c1")] {
            let raw = Hooked::default();
            chunked_set(&raw, "c1", &old).unwrap();
            let before = keys(&raw.inner);
            let target = fails.to_owned();
            *raw.fail_set.lock().unwrap() = Some(Box::new(move |id| id == target));
            assert!(chunked_set(&raw, "c1", &long('n', CHUNK_UNITS * 3)).is_err(), "{what}");
            *raw.fail_set.lock().unwrap() = None;
            assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), old, "{what}");
            assert_eq!(keys(&raw.inner), before, "{what}: the new slot was cleared");
        }
        // An unreadable head is not overwritten.
        let raw = Hooked::default();
        chunked_set(&raw, "c1", &old).unwrap();
        *raw.fail_get.lock().unwrap() = Some("c1".into());
        assert!(chunked_set(&raw, "c1", &long('n', CHUNK_UNITS * 2)).is_err());
        *raw.fail_get.lock().unwrap() = None;
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), old);
    }

    #[test]
    fn a_crash_between_steps_leaves_the_old_value_and_the_leftovers_are_cleaned_up() {
        let raw = MemoryStore::default();
        let old = long('o', CHUNK_UNITS * 2);
        chunked_set(&raw, "c1", &old).unwrap(); // generation 1, slot 1
        // A crash after writing three parts of generation 2 (slot 0), before the switch.
        for k in 0..3 {
            raw.set(&format!("c1#0#{k}"), "half-written").unwrap();
        }
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), old);
        // The next write (two parts, slot 0) leaves no third leftover part.
        let next = long('n', CHUNK_UNITS + 1);
        chunked_set(&raw, "c1", &next).unwrap();
        assert_eq!(keys(&raw), ["c1", "c1#0#0", "c1#0#1"]);
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), next);
        // Leftovers in the unused slot are removed by delete too.
        raw.set("c1#1#0", "orphan").unwrap();
        chunked_delete(&raw, "c1").unwrap();
        assert!(keys(&raw).is_empty());
    }

    #[test]
    fn delete_removes_the_parts_even_when_the_head_cannot_be_read() {
        let raw = Hooked::default();
        chunked_set(&raw, "c1", &long('x', CHUNK_UNITS * 2)).unwrap();
        *raw.fail_get.lock().unwrap() = Some("c1".into());
        chunked_delete(&raw, "c1").unwrap();
        *raw.fail_get.lock().unwrap() = None;
        assert!(keys(&raw.inner).is_empty());
    }

    #[test]
    fn the_first_format_is_still_read_deleted_and_upgraded() {
        let raw = MemoryStore::default();
        let a = "a".repeat(CHUNK_UNITS);
        let b = "b".repeat(10);
        raw.set("c1", &format!("novel-chunked:1:2:{a}")).unwrap();
        raw.set("c1#1", &b).unwrap();
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), format!("{a}{b}"));
        chunked_set(&raw, "c1", &long('n', CHUNK_UNITS + 1)).unwrap();
        assert_eq!(keys(&raw), ["c1", "c1#1#0", "c1#1#1"], "the old part c1#1 went");
        raw.set("c2", &format!("novel-chunked:1:2:{a}")).unwrap();
        raw.set("c2#1", &b).unwrap();
        chunked_delete(&raw, "c2").unwrap();
        assert_eq!(keys(&raw), ["c1", "c1#1#0", "c1#1#1"]);
    }

    #[test]
    fn an_id_with_a_hash_is_refused() {
        let store = MemoryStore::default();
        assert_eq!(set_secret(&store, "X#1", "k").unwrap_err().kind, "bad_request");
        assert!(delete_secret(&store, "X#0#1").is_err());
    }

    /// Through the real `KeyringStore` on the keyring crate's mock credential builder (never the OS
    /// keychain). The mock keeps no state between `Entry` values, so a stored secret cannot be read
    /// back here (that is what `MemoryStore` covers); this checks the wiring and that errors say
    /// nothing about the secret.
    #[test]
    fn keyring_store_on_the_mock_builder() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let store: Arc<dyn SecretStore> = Arc::new(KeyringStore);
        let secret = "sk-very-secret-value";
        set_secret(store.as_ref(), "c1", secret).unwrap();
        assert!(!has_secret(store.as_ref(), "c1").unwrap());
        delete_secret(store.as_ref(), "c1").unwrap();
        for e in [
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other(secret))),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other(secret))),
            keyring::Error::BadEncoding(secret.as_bytes().to_vec()),
            keyring::Error::TooLong(secret.to_owned(), 1),
            keyring::Error::Invalid(secret.to_owned(), secret.to_owned()),
        ] {
            let mapped = keychain_error(&e);
            assert!(!mapped.message.contains("secret"), "{}", mapped.message);
            assert!(!format!("{mapped:?}").contains(secret));
        }
    }
}
