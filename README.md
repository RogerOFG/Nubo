# Nubo

A small **island at the top of your screen** for Windows: it shows your Claude
Code sessions (and other coding agents), lets you approve their permissions,
and holds music, lyrics, quick texts, tasks and notes.

> **Nubo is a fork of [Coucou](https://github.com/Louis-CFM/coucou) by Louis
> Raillé** (MIT License). Most of the code is his work. See
> [NOTICE.md](NOTICE.md) for the attribution and for what this repository does
> not include.

## What this fork adds

- **Spotify lyrics**, synced from [LRCLIB](https://lrclib.net): one line in the
  compact island (a second ahead, easing in and out) and a lyrics view in the
  Spotify card. A speech-bubble button turns them on and off. With no lyrics,
  sound bars that follow Spotify's loudness.
- **Quick texts**: cards that copy a text to the clipboard with one click.
- **Tasks and notes**, with a time to be reminded at (once, or every day).
- **Terminal for new sessions**: Windows Terminal, PowerShell, CMD or Warp
  (Warp is best effort).
- **Swipe sideways** with two fingers to move between the tabs, round the ends.
- Claude Desktop can be the main tool; the slimmer compact island; the plan
  gauge in the middle; updates that look at **this** repository's releases.

## Install

Download the installer from the [Releases](https://github.com/RogerOFG/Nubo/releases)
page. It is **not code-signed**, so Windows shows "Windows protected your PC":
choose *More info* → *Run anyway*. If **Smart App Control** is on, Windows
blocks unsigned installers with no way round it.

## Build

You need Node.js, Rust (MSVC) and the Visual Studio *C++ build tools*.

```powershell
npm install
npm run tauri dev                      # run it
npm run tauri build -- --bundles nsis  # make the installer
```

## Updates

The app asks `https://api.github.com/repos/RogerOFG/Nubo/releases` for tags
named `windows-vX.Y.Z` with the installer attached as
`Nubo-Windows-X.Y.Z-setup.exe` (the names `npm run pack` produces). Nothing
else leaves your machine for this.

## Privacy

No telemetry and no account. Lyrics ask `lrclib.net` for the song's title and
artist, only after you turn lyrics on. Quick texts, tasks and notes stay on
your computer.

## License

MIT, as the original: see [LICENSE](LICENSE). The original's name, Mochi, icon
and sounds are **not** under it and are not included.
