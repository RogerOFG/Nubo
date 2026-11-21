// Synced lyrics for the Spotify pill, from LRCLIB (https://lrclib.net): a free,
// keyless, community-made database of timestamped lyrics (LRC format).
//
// Only the track's title, artist, album and length leave the machine, and only
// when Settings → Spotify lyrics is on (the page never calls this otherwise).
// The answer is the raw LRC text; src/core/lyrics.ts parses it and keeps it
// per track.

use std::time::Duration;

use reqwest::Url;
use serde_json::Value;

/// Ceiling for LRCLIB's answer: lyrics are a few kilobytes.
const LIMIT: usize = 512 * 1024;

fn http() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Nubo-Windows/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()
}

async fn get_json(client: &reqwest::Client, url: Url) -> Option<Value> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = crate::net::read_capped(response, LIMIT).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn synced(v: &Value) -> Option<String> {
    let text = v.get("syncedLyrics")?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The track's synced lyrics (raw LRC), or None when LRCLIB has none.
///
/// First the exact lookup (title + artist + album + length), then a search by
/// title and artist, taking the first result that has synced lyrics and whose
/// length is within a few seconds of the track's.
pub async fn fetch(title: &str, artist: &str, album: &str, duration: f64) -> Option<String> {
    let title = title.trim();
    if title.is_empty() {
        return None;
    }
    let client = http()?;

    let mut get = Url::parse("https://lrclib.net/api/get").ok()?;
    {
        let mut q = get.query_pairs_mut();
        q.append_pair("track_name", title);
        q.append_pair("artist_name", artist.trim());
        if !album.trim().is_empty() {
            q.append_pair("album_name", album.trim());
        }
        if duration > 0.0 {
            q.append_pair("duration", &(duration.round() as i64).to_string());
        }
    }
    if let Some(found) = get_json(&client, get).await.as_ref().and_then(synced) {
        return Some(found);
    }

    let mut search = Url::parse("https://lrclib.net/api/search").ok()?;
    {
        let mut q = search.query_pairs_mut();
        q.append_pair("track_name", title);
        q.append_pair("artist_name", artist.trim());
    }
    let results = get_json(&client, search).await?;
    results
        .as_array()?
        .iter()
        .filter(|r| {
            let d = r.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
            duration <= 0.0 || d <= 0.0 || (d - duration).abs() <= 5.0
        })
        .find_map(synced)
}

/// The synced lyrics (raw LRC) of a track, for the Spotify pill.
#[tauri::command]
pub async fn spotify_lyrics(title: String, artist: String, album: String, duration: f64) -> Option<String> {
    fetch(&title, &artist, &album, duration).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_non_empty_synced_lyrics_count() {
        assert_eq!(synced(&json!({ "syncedLyrics": " [00:01.00] Hi \n" })).as_deref(), Some("[00:01.00] Hi"));
        assert_eq!(synced(&json!({ "syncedLyrics": "  " })), None);
        assert_eq!(synced(&json!({ "syncedLyrics": null, "plainLyrics": "Hi" })), None);
        assert_eq!(synced(&json!({})), None);
    }
}
