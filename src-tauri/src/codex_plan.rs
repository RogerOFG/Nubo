// Codex plan usage — the same source as CodexPlanGauge.swift on the Mac.
//
// Nubo asks the Codex CLI itself: `codex app-server` (the JSON-RPC server
// behind Codex's /status) is started, asked `account/rateLimits/read`, and
// stopped. Nubo makes no network call of its own and reads no credential:
// Codex answers with its own sign-in, exactly as /status does, and nothing is
// installed or written. It runs only when the pill shows or is clicked, at most
// once at a time, for 15 s at most, and is skipped while Nubo is paused.

use std::cmp::Ordering;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{self, AtomicBool};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::platform;

/// The Mac gives Codex the same 15 s.
const TIMEOUT: Duration = Duration::from_secs(15);
/// One JSON-RPC line we are willing to read; the answer is a few hundred bytes.
const MAX_LINE: usize = 256 * 1024;
/// Everything we are willing to read before the answer shows up.
const MAX_TOTAL: usize = 2 * 1024 * 1024;

/// What the Mac sends: initialize, initialized, then the one question.
const REQUESTS: &str = concat!(
    r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"nubo","version":"1"}}}"#,
    "\n",
    r#"{"method":"initialized"}"#,
    "\n",
    r#"{"id":2,"method":"account/rateLimits/read"}"#,
    "\n",
);

static BUSY: AtomicBool = AtomicBool::new(false);

struct NotBusy;
impl Drop for NotBusy {
    fn drop(&mut self) {
        BUSY.store(false, atomic::Ordering::Release);
    }
}

/// The limits part of Codex's `account/rateLimits/read` answer, or `None` when
/// Codex is not installed, not signed in, slow, already being asked, or Nubo
/// is paused. Blocking: call it off the main thread.
pub fn read() -> Option<Value> {
    if crate::integrations::PAUSED.load(atomic::Ordering::Relaxed) {
        return None;
    }
    if BUSY.swap(true, atomic::Ordering::AcqRel) {
        return None;
    }
    let _busy = NotBusy;

    let exe = platform::cli_candidates("codex").into_iter().next()?;
    let mut cmd = Command::new(&exe);
    cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    // An npm install is a `#!/usr/bin/env node` script (or a .cmd calling node):
    // its own folder first on PATH, as the Mac does, so it finds its Node.
    if let Some(dir) = exe.parent() {
        let mut dirs = vec![dir.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;

    let answer = (|| {
        let mut stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(first_answer(BufReader::new(stdout)));
        });
        stdin.write_all(REQUESTS.as_bytes()).ok()?;
        stdin.flush().ok()?;
        let answer = rx.recv_timeout(TIMEOUT).ok().flatten();
        // Closing its input is how app-server learns we are done.
        drop(stdin);
        answer
    })();
    // An npm install runs `codex.cmd`: killing cmd.exe alone would leave the
    // node app-server under it running. End the whole tree there.
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/T", "/F", "/PID", &child.id().to_string()]);
        platform::no_console(&mut kill);
        let _ = kill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
    answer.map(|result| limits_only(&result))
}

/// Reads JSON-RPC lines until the answer to request 2 and returns its `result`.
/// Gives up on a line or a stream that is far too long for what we expect.
pub fn first_answer(reader: impl BufRead) -> Option<Value> {
    let mut reader = reader;
    let mut total = 0usize;
    let mut line = Vec::new();
    loop {
        line.clear();
        let n = (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line).ok()?;
        if n == 0 {
            return None;
        }
        total += n;
        if total > MAX_TOTAL || line.len() > MAX_LINE {
            return None;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
        if message.get("id").and_then(Value::as_i64) == Some(2) {
            return message.get("result").filter(|r| r.is_object()).cloned();
        }
    }
}

/// Only what the card shows goes to the webview: the limits and the free resets.
fn limits_only(result: &Value) -> Value {
    json!({
        "rateLimits": result.get("rateLimits").cloned().unwrap_or(Value::Null),
        "rateLimitResetCredits": result.get("rateLimitResetCredits").cloned().unwrap_or(Value::Null),
    })
}

/// Compares version-like names with their numbers as numbers ("v20.1" > "v9.12"),
/// like Foundation's `.numeric` comparison the Mac sorts nvm's folders with.
#[cfg_attr(windows, allow(dead_code))]
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn parts(s: &str) -> Vec<Result<u64, String>> {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut digits = false;
        for c in s.chars() {
            if c.is_ascii_digit() != digits && !cur.is_empty() {
                out.push(if digits { Ok(cur.parse().unwrap_or(u64::MAX)) } else { Err(cur.clone()) });
                cur.clear();
            }
            digits = c.is_ascii_digit();
            cur.push(c);
        }
        if !cur.is_empty() {
            out.push(if digits { Ok(cur.parse().unwrap_or(u64::MAX)) } else { Err(cur) });
        }
        out
    }
    let (pa, pb) = (parts(a), parts(b));
    for (x, y) in pa.iter().zip(pb.iter()) {
        let ord = match (x, y) {
            (Ok(x), Ok(y)) => x.cmp(y),
            (Err(x), Err(y)) => x.cmp(y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    pa.len().cmp(&pb.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_to_the_question_is_picked_out_of_the_conversation() {
        let stream = concat!(
            r#"{"id":1,"result":{"userAgent":"codex"}}"#, "\n",
            "not json at all\n",
            r#"{"method":"account/updated","params":{}}"#, "\n",
            r#"{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":12.5,"resetsAt":1900000000}}}}"#, "\n",
            r#"{"id":3,"result":{}}"#, "\n",
        );
        let result = first_answer(stream.as_bytes()).unwrap();
        assert_eq!(result["rateLimits"]["primary"]["usedPercent"], 12.5);
    }

    #[test]
    fn an_error_a_closed_stream_or_a_flood_is_no_answer() {
        assert!(first_answer(r#"{"id":2,"error":{"message":"not signed in"}}"#.as_bytes()).is_none());
        assert!(first_answer(r#"{"id":1,"result":{}}"#.as_bytes()).is_none());
        assert!(first_answer(&b""[..]).is_none());
        let huge = "x".repeat(MAX_LINE + 10);
        assert!(first_answer(format!("{huge}\n{}\n", r#"{"id":2,"result":{}}"#).as_bytes()).is_none());
        // Many short lines add up too.
        let chatter = format!("{}\n", "y".repeat(1000)).repeat(MAX_TOTAL / 1000 + 10);
        assert!(first_answer(chatter.as_bytes()).is_none());
    }

    #[test]
    fn only_the_limits_reach_the_webview() {
        let result = json!({
            "rateLimits": { "planType": "plus" },
            "rateLimitResetCredits": { "availableCount": 1 },
            "account": { "email": "me@example.com" }
        });
        let kept = limits_only(&result);
        assert_eq!(kept["rateLimits"]["planType"], "plus");
        assert_eq!(kept["rateLimitResetCredits"]["availableCount"], 1);
        assert!(kept.get("account").is_none());
    }

    #[test]
    fn newest_node_first_like_the_mac() {
        let mut v = vec!["v9.12.0", "v20.1.0", "v18.20.4", "v20.11.1"];
        v.sort_by(|a, b| compare_versions(b, a));
        assert_eq!(v, ["v20.11.1", "v20.1.0", "v18.20.4", "v9.12.0"]);
    }
}

/// Reads only the tail of a validated Codex session file. The rollout format is
/// internal to Codex, so missing or unrecognized records leave the hooks in charge.
pub fn turn_result(path: &str, session_id: &str, turn_id: &str) -> Option<Value> {
    use std::io::{Seek, SeekFrom};

    if turn_id.is_empty() {
        return None;
    }
    let path = session_rollout(path, session_id)?;
    let mut file = std::fs::File::open(path).ok()?;
    let limit = 512 * 1024;
    let offset = file.metadata().ok()?.len().saturating_sub(limit);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut tail = Vec::new();
    file.take(limit).read_to_end(&mut tail).ok()?;
    completed_turn(&tail, turn_id)
}

fn session_rollout(hint: &str, session: &str) -> Option<std::path::PathBuf> {
    use std::path::{Path, PathBuf};

    let home = std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|base| PathBuf::from(base).join(".codex"))
    })?;
    let sessions = home.join("sessions");
    let root = sessions.canonicalize().ok()?;
    let hint = Path::new(hint);
    let hint = if (hint.starts_with(&sessions) || hint.starts_with(&root))
        && !hint.components().any(|part| part == std::path::Component::ParentDir)
    {
        hint
    } else {
        Path::new("")
    };
    find_rollout(&root, hint, session)
}

fn find_rollout(root: &std::path::Path, hint: &std::path::Path, session: &str) -> Option<std::path::PathBuf> {
    use chrono::Datelike;
    use std::path::Path;

    if session.len() != 36 || !session.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
    }) {
        return None;
    }
    let suffix = format!("-{session}.jsonl");
    let validate = |candidate: &Path| {
        let path = candidate.canonicalize().ok()?;
        let name = path.file_name()?.to_str()?;
        (path.starts_with(root) && name.starts_with("rollout-") && name.ends_with(&suffix)
            && path.is_file()).then_some(path)
    };
    if let Some(path) = validate(hint) {
        return Some(path);
    }

    // UUIDv7 carries the creation date. Codex names its folders in local
    // time, which can put the creation on either side of the UTC date.
    let ms = i64::from_str_radix(&format!("{}{}", &session[..8], &session[9..13]), 16).ok()?;
    let day = chrono::DateTime::from_timestamp_millis(ms)?.date_naive();
    for date in [Some(day), day.pred_opt(), day.succ_opt()].into_iter().flatten() {
        let dir = root.join(format!("{:04}/{:02}/{:02}", date.year(), date.month(), date.day()));
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(&suffix) {
                if let Some(path) = validate(&entry.path()) {
                    return Some(path);
                }
            }
        }
    }
    None
}

/// A null transcript identifies an in-memory thread in current Codex hooks.
/// Older hooks may omit the field entirely; in that case only skip a known
/// internal result shape, and only if there is no saved rollout for the ID.
pub fn ignore_hook(payload: &Value) -> bool {
    let event = payload["hook_event_name"].as_str().unwrap_or_default();
    let session = payload["session_id"].as_str().unwrap_or_default();
    let path = payload["transcript_path"].as_str().unwrap_or_default();
    if is_guardian(path, session) {
        return true;
    }
    if event == "PermissionRequest" || !path.is_empty() {
        return false;
    }
    let without_transcript = payload.get("transcript_path").is_some_and(|value| {
        value.is_null() || value.as_str() == Some("")
    });
    let suggestions = event == "Stop" && payload["last_assistant_message"]
        .as_str().is_some_and(is_suggestions_result);
    (without_transcript || suggestions) && session_rollout("", session).is_none()
}

fn is_suggestions_result(text: &str) -> bool {
    serde_json::from_str::<Value>(text).ok()
        .and_then(|value| value.as_object().map(|object| {
            object.len() == 1 && object.get("suggestions").is_some_and(Value::is_array)
        })).unwrap_or(false)
}

#[cfg(test)]
#[test]
fn codex_ignores_unpersisted_internal_alerts() {
    let stop = json!({
        "hook_event_name": "Stop",
        "session_id": "no-such-rollout",
        "last_assistant_message": "{\"suggestions\":[]}"
    });
    assert!(ignore_hook(&stop));
    let temporary = json!({
        "hook_event_name": "UserPromptSubmit", "session_id": "no-such-rollout",
        "transcript_path": null
    });
    assert!(ignore_hook(&temporary));
    let mut ordinary = stop;
    ordinary["last_assistant_message"] = json!("Finished the changes.");
    assert!(!ignore_hook(&ordinary));
    ordinary["hook_event_name"] = json!("PermissionRequest");
    ordinary["transcript_path"] = Value::Null;
    assert!(!ignore_hook(&ordinary));
    assert!(!is_suggestions_result(r#"{"suggestions": [], "answer": "Done"}"#));
}

/// Codex's guardian runs on its own internal thread. Its hooks must never
/// replace the conversation shown in the island.
pub fn is_guardian(hint: &str, session: &str) -> bool {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    static SESSIONS: Mutex<VecDeque<(String, bool)>> = Mutex::new(VecDeque::new());
    if let Some((_, guardian)) = SESSIONS.lock().unwrap().iter().find(|(id, _)| id == session) {
        return *guardian;
    }
    let Some(path) = session_rollout(hint, session) else { return false };
    let Ok(file) = std::fs::File::open(path) else { return false };
    let mut first = Vec::new();
    if BufReader::new(file.take(256 * 1024)).read_until(b'\n', &mut first).is_err() {
        return false;
    }
    let Some(guardian) = guardian_metadata(&first, session) else { return false };
    let mut remembered = SESSIONS.lock().unwrap();
    if remembered.len() >= 128 {
        remembered.pop_front();
    }
    remembered.push_back((session.to_owned(), guardian));
    guardian
}

fn guardian_metadata(line: &[u8], session: &str) -> Option<bool> {
    let record: Value = serde_json::from_slice(line).ok()?;
    if record["type"] != "session_meta" || record["payload"]["id"] != session {
        return None;
    }
    Some(record["payload"]["source"]["subagent"]["other"] == "guardian")
}

fn completed_turn(tail: &[u8], turn_id: &str) -> Option<Value> {
    for line in tail.split(|byte| *byte == b'\n').rev() {
        let Ok(record) = serde_json::from_slice::<Value>(line) else { continue };
        if record["type"] != "event_msg" {
            continue;
        }
        let event = &record["payload"];
        let Some(id) = event["turn_id"].as_str() else { continue };
        if event["root_turn_id"].as_str().is_some_and(|root| root != id) {
            continue;
        }
        match event["type"].as_str() {
            Some("task_started") => return None,
            Some("task_complete") if id == turn_id => {
                let message = event["last_agent_message"].as_str().unwrap_or("");
                return Some(json!({ "event": "Stop", "message": message.chars().take(2000).collect::<String>() }));
            }
            Some("turn_aborted") if id == turn_id => return Some(json!({ "event": "Interrupt" })),
            Some("task_complete" | "turn_aborted") => return None,
            _ => {}
        }
    }
    None
}

#[cfg(test)]
#[test]
fn rollout_only_confirms_the_latest_main_turn() {
    let current = br#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done"}}"#;
    assert_eq!(completed_turn(current, "t1").unwrap()["message"], "done");
    assert!(completed_turn(current, "t2").is_none());
    let resumed = [current.as_slice(), br#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"t2"}}"#.as_slice()].join(&b'\n');
    assert!(completed_turn(&resumed, "t1").is_none());
}

#[cfg(test)]
#[test]
fn codex_session_lookup_works_without_a_hook_path() {
    let root = std::env::temp_dir().join(format!("nubo-rollout-{}", std::process::id()));
    let dir = root.join("2026/11/23");
    std::fs::create_dir_all(&dir).unwrap();
    let id = "01a20ad3-3e27-7500-b4af-8cc40c405084";
    let file = dir.join(format!("rollout-test-{id}.jsonl"));
    let content = json!({ "type": "session_meta", "payload": { "id": id, "source": { "subagent": { "other": "guardian" } } } });
    std::fs::write(&file, content.to_string()).unwrap();
    let root = root.canonicalize().unwrap();
    let path = find_rollout(&root, std::path::Path::new(""), id).unwrap();
    assert_eq!(path, file.canonicalize().unwrap());
    assert_eq!(guardian_metadata(&std::fs::read(path).unwrap(), id), Some(true));
    std::fs::remove_file(file).unwrap();
}
