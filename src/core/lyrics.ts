// Synced lyrics for the Spotify pill (src-tauri/src/lyrics.rs fetches them from
// LRCLIB as LRC text). Off unless Settings → Spotify lyrics is on.
//
// This file holds the pure rules (parsing, which line is current) and the
// page's copy of the current track's lyrics.

import { Bridge } from "./bridge";
import { Spotify, isAd, spotifyPosition, type SpotifyTrack } from "./spotify";
import { State } from "./state";

/** How far ahead of the song the lines run, so they can be read before they are sung. */
export const LYRICS_LEAD_SECONDS = 1;

export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number;
  text: string;
}

/**
 * LRC text → lines in time order. `[mm:ss.xx] words`; a line may carry several
 * stamps (a repeated chorus); `[ar:…]`-style tags and blank lines are skipped.
 * An empty line of text is kept: it is the silence between verses.
 */
export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (stamps.length === 0) continue;
    const text = row.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      lines.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Index of the line being sung at `position` (seconds), or -1 before the first. */
export function lineIndexAt(lines: readonly LyricLine[], position: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= position) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The lines around `position` read `LYRICS_LEAD_SECONDS` early. */
export function lyricWindow(lines: readonly LyricLine[], position: number) {
  const i = lineIndexAt(lines, position + LYRICS_LEAD_SECONDS);
  return {
    index: i,
    previous: i > 0 ? lines[i - 1].text : "",
    current: i >= 0 ? lines[i].text : "",
    next: i + 1 < lines.length ? lines[i + 1].text : "",
  };
}

// ── The card's lyrics view (the speech-bubble button) ───────────────────────

const VIEW_KEY = "coucou.lyricsView";
let viewOn = (() => {
  try {
    return localStorage.getItem(VIEW_KEY) === "1";
  } catch {
    return false;
  }
})();

/**
 * "Back" from the lyrics view: the other pills show again, but the lyrics view
 * stays chosen — it comes back when the bubble is pressed or the Spotify card
 * is opened again. For this run only.
 */
let backed = false;

/** The Spotify card shows the lyrics beside the player (the bubble button). */
export function lyricsView(): boolean {
  return viewOn && !backed;
}

/** The lyrics view was left with Back and not yet returned to. */
export function lyricsBacked(): boolean {
  return viewOn && backed;
}

export function setLyricsBack(on: boolean) {
  if (backed === on) return;
  backed = on;
  State.notify();
}

export function setLyricsView(on: boolean) {
  viewOn = on;
  try {
    localStorage.setItem(VIEW_KEY, on ? "1" : "0");
  } catch {
    /* a nicety */
  }
  State.notify();
}

/** True while the lyrics for the current track are still being fetched. */
export function lyricsLoading(): boolean {
  const track = Spotify.state.track;
  return loaded != null && track != null && loaded.key === trackKey(track) && loaded.status === "loading";
}

// ── The page's copy ──────────────────────────────────────────────────────────

interface Loaded {
  key: string;
  status: "loading" | "ready" | "none";
  lines: LyricLine[];
}

let loaded: Loaded | null = null;
const cache = new Map<string, LyricLine[] | null>();
const CACHE_MAX = 40;

function trackKey(track: SpotifyTrack): string {
  return `${track.id}|${track.title}|${track.artist}`;
}

/** The lyrics are on: the speech-bubble button of the Spotify card is its switch. */
export function lyricsEnabled(): boolean {
  return viewOn;
}

/** The current track's lines, once they have arrived (and the feature is on). */
export function currentLyrics(): readonly LyricLine[] | null {
  const track = Spotify.state.track;
  if (!lyricsEnabled() || !track || isAd(track) || !loaded) return null;
  return loaded.key === trackKey(track) && loaded.status === "ready" ? loaded.lines : null;
}

/** The window of lines to show right now, or null when there is nothing to show. */
export function currentLyricWindow(nowMs: number = Date.now()) {
  const lines = currentLyrics();
  if (!lines) return null;
  return lyricWindow(lines, spotifyPosition(Spotify.state, nowMs));
}

/** Called whenever the player or the settings change: fetches the lyrics a new track needs. */
export function syncLyrics() {
  const track = Spotify.state.track;
  if (!lyricsEnabled() || !track || isAd(track) || !track.title) {
    if (loaded && !track) loaded = null;
    return;
  }
  const key = trackKey(track);
  if (loaded?.key === key) return;
  if (cache.has(key)) {
    const lines = cache.get(key) ?? null;
    loaded = { key, status: lines ? "ready" : "none", lines: lines ?? [] };
    State.notify();
    return;
  }
  loaded = { key, status: "loading", lines: [] };
  void Bridge.spotifyLyrics(track.title, track.artist, track.album, track.duration)
    .then((raw) => {
      const lines = raw ? parseLrc(raw) : [];
      const usable = lines.some((l) => l.text) ? lines : null;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, usable);
      if (loaded?.key === key) {
        loaded = { key, status: usable ? "ready" : "none", lines: usable ?? [] };
        State.notify();
      }
    })
    .catch(() => {
      // A failed request is not remembered: the next track change tries again.
      if (loaded?.key === key) loaded = { key, status: "none", lines: [] };
    });
}
