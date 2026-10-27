# Chord

An open-source browser inspired by [Arc](https://arc.net): a vertical sidebar with
Spaces, Favorites, Pinned and Today tabs, a command bar instead of a URL bar,
split view, auto-archiving, and built-in ad and tracker blocking.

A *chord* is the straight line between two points on an arc.

Website: https://ingmmo.com/chord/ · Downloads: https://github.com/sirmmo/chord/releases/latest

Chord is built on Electron, so pages render with Chromium exactly as in Arc, Chrome
or Brave. It is an early 0.1: usable, unpolished, and missing plenty. See the roadmap.

## Features

- **Sidebar** with the page's navigation controls, a URL pill, and the tab lists.
  Collapse it with the button in its corner or `⌘S`; while collapsed, hovering the
  left edge peeks it. Drag its right edge to resize.
- **Spaces**: each has its own colour, icon, pinned and today tabs. `⌘⌥←/→` or
  `Ctrl+1…9` switch, `⌘⇧N` creates one. Right-click a space for icon, colour, rename
  or delete.
- **Favorites**: a grid at the top shared by all spaces.
- **Pinned tabs** never close: closing one puts it to sleep and resets it to the page
  it was pinned at. `⌘D` pins or unpins.
- **Today tabs** are ephemeral and get archived after 12 hours of inactivity
  (configurable from the command bar). Archived tabs are searchable from the
  command bar.
- **Command bar** (`⌘T` for a new tab, `⌘L` to edit the current URL): URLs, search,
  open tabs, archived tabs, and commands. `⌘↩` forces a new tab.
- **Split view**: `⌘⇧D` adds the next tab beside the current one (up to four),
  tiled any way you like: pick a layout from Tabs → Split Layout, cycle with `⌘⌥L`,
  or write your own in Settings → Layouts (`50/50 | 100` is two panes on top and one
  across the bottom; `2:50/50 | 1:100` makes the top row twice as tall). Drag the gap
  between two panes to adjust the layout live. Each space remembers its layout.
  or use "Open in Split View" from a tab's or a link's context menu.
- **Smart pages**: what a tab gives away is shown from every space, and you can act on it.
  - Players (YouTube Music, Spotify, Amazon Music, anything with a Media Session or a
    plain audio/video element): one now-playing card per player above the spaces strip,
    playing ones first, and a pill in the title bar for the top one, with play/pause,
    previous and next.
  - Calls (Meet, Zoom, Jitsi, anything using the microphone or camera): a card with the
    call duration, mute, camera and leave, and a pulsing chip in the title bar.
  - Timers and progress read from the title (`24:59 - Pomofocus`, `Uploading 45%`): a
    chip in the title bar that jumps to the tab.
  - Unread counts from the title (`(3) Inbox`, `[2] Slack`) and notifications the page
    fires: a badge on the tab, a total on each space's dot, a bell in the title bar.
  Toggle in Settings → General.
- **Keep running in the menu bar / tray**: with Settings → "Closing the window", the
  window hides instead of closing, music and calls go on, and the tray menu offers
  show, play/pause, next, mute, leave, downloads and quit.
- **Downloads** (`⌘⇧J`): files go straight to your Downloads folder (or ask every time,
  from Settings). The title bar shows a progress ring and a count while anything is in
  flight, a row above the player shows the current file, and the `chord://downloads`
  page lists everything with pause, resume, cancel, retry, open and show-in-folder.
- **Shields**: ad and tracker blocking (EasyList and EasyPrivacy through the Ghostery
  engine). Toggle from the command bar.
- **Find in page** `⌘F`, tab sleep, mute, reopen closed tab `⌘⇧T`, per-site
  permission prompts, OAuth-style popups opened as tabs.
- **Settings panel** (`⌘,`) with three pages: General (address bar, archiving,
  search engine, default browser, export and import), Appearance, and Add-ins.
- **Address bar**: an optional editable URL field across the top of the page,
  toggled with `⌘⇧L`, from Settings, or from the View menu. Type a URL or a search
  and press Enter.
- **Add-ins**: built-in Shields, plus unpacked Chrome extensions. Pick the folder
  that contains an extension's `manifest.json`; each one can be switched on and off
  or removed. Electron runs content scripts, storage and most page-level APIs, but
  does not show toolbar popups.
- **Appearance**: light, dark or system theme, any colour per space (presets
  or a colour picker), tint strength, a separate accent colour, colour or monochrome
  icons with their own colour, and the UI font. Appearance travels with the exported
  configuration.
- **Export and import** the whole setup, or a single space, as a JSON file
  (File menu, space context menu, or the command bar). See below.

## Configuration files

*File → Export Configuration…* writes everything you set up to a JSON file: spaces with
their pinned and today tabs, favorites, and settings. Right-click a space for
*Export Space…*. *File → Import Configuration…* reads such a file and asks whether to
**merge** (spaces with the same name receive the tabs they are missing, other spaces
are created, settings are untouched) or **replace** (spaces, favorites and settings
are rebuilt from the file; your current tabs are moved to the archive, nothing is
lost). Imported tabs stay asleep until you click them.

The format has no internal ids, so it is easy to write by hand. Tabs can be plain
URL strings or objects with `url`, `title` and `favicon`:

```json
{
  "format": "chord-config",
  "version": 1,
  "favorites": ["https://mail.example.com", { "url": "https://calendar.example.com", "title": "Calendar" }],
  "spaces": [
    {
      "name": "Work",
      "color": "#ff6b6b",
      "icon": "💼",
      "pinned": [{ "url": "https://github.com/sirmmo/chord", "title": "Chord" }],
      "today": ["https://news.ycombinator.com"]
    }
  ],
  "settings": {
    "searchEngine": "duckduckgo",
    "archiveAfterHours": 24,
    "shields": true,
    "theme": { "mode": "dark", "tint": 40, "accent": "#ffb347", "iconStyle": "mono", "iconColor": null, "font": "rounded" }
  }
}
```

## Shortcuts

| Keys | Action |
| --- | --- |
| `⌘T` / `⌘L` | Command bar: new tab / edit current URL |
| `⌘W` · `⌘⇧T` | Close tab · reopen closed tab |
| `⌘S` | Collapse / expand sidebar (hover the left edge to peek) |
| `⌘,` · `⌘⇧L` | Settings · show or hide the address bar |
| `⌘D` | Pin / unpin tab |
| `⌘⇧D` · `⌘⌥W` | Add to split view · remove from split view |
| `Ctrl+Tab` · `Ctrl+⇧Tab` | Next / previous tab |
| `⌘1…8` · `⌘9` | Jump to tab · last tab |
| `⌘⌥←/→` · `Ctrl+1…9` | Previous / next space · jump to space |
| `⌘⇧N` | New space |
| `⌘[` · `⌘]` · `⌘R` | Back · forward · reload |
| `⌘F` · `⌘⇧C` | Find in page · copy URL |

On Windows and Linux use `Ctrl` for `⌘` and `Alt` for `⌥`.

## Install

Installers for macOS (Apple Silicon and Intel), Windows and Linux are attached to each
[release](https://github.com/sirmmo/chord/releases/latest). They are not signed or
notarised yet: on macOS run `xattr -cr /Applications/Chord.app` once if the app refuses
to open; on Windows choose "More info → Run anyway" in SmartScreen.

Windows comes in two flavours: `Chord-<version>-win-x64-setup.exe` installs per user, and
`Chord-<version>-win-x64-portable.exe` runs from wherever you put it and keeps profile,
cookies and settings in a `ChordData` folder next to the executable, so it can live on a
USB stick. Quit with `Ctrl+Q` or the window's close button; Chord never stays running in
the background.

## Coming from Arc, Chrome or Brave

File → Import from Another Browser… (also in the command bar and in Settings → General)
looks for Arc, Chrome, Brave, Edge and Chromium in their usual folders and imports from
the one you pick, or from any file you choose:

- **Arc**: spaces with their names, emoji and colours, pinned and today tabs, and the
  favorites bar, read from `StorableSidebar.json`. Folders are flattened; archived Arc
  tabs are not imported.
- **Chrome, Brave, Edge, Chromium**: the profile's `Bookmarks` file. Bookmarks become
  pinned tabs; each folder in the bookmarks bar becomes a space, loose bookmarks go to a
  "Chrome Bookmarks" space, and "Other bookmarks" gets a space of its own. Pick a
  `Bookmarks` file from another profile folder with Choose File….

You then choose Merge (add what is missing) or Replace, exactly as for a Chord
configuration file.

## Something slow or broken?

Help → Copy Diagnostics puts a text report on the clipboard (and in `diagnostics.txt` in
the profile folder): versions, whether the build is signed or translated by Rosetta, GPU
status, main-process event-loop stalls, recent page-load timings and the focused page's
navigation timing. Paste it into a GitHub issue.

## Run it from source

Requires Node 22 or newer.

```sh
npm install
npm start          # builds and launches
npm run watch      # rebuild on change (run `npx electron .` in another terminal)
npm test           # model unit tests
npm run typecheck
npm run dist:mac   # .dmg for Apple Silicon and Intel in release/
```

The Electron binary is downloaded by a postinstall script; `package.json` already
approves it for npm 11's install-script policy.

## Continuous integration and releases

`.github/workflows/build.yml` type-checks, tests and packages Chord for macOS, Windows
and Linux on every push and pull request. Pushing a tag such as `v0.1.0` also creates a
GitHub release with the installers attached. `.github/workflows/pages.yml` publishes
the `docs/` folder to GitHub Pages.

## How it is built

```
src/shared/   types, the pure state reducer (model.ts), URL and layout helpers — no Electron
src/main/     Electron main process
  controller  owns the state, applies actions, broadcasts to the UI, runs commands
  tabs        one WebContentsView per awake tab, reconciled from the state
  overlay     transparent view that hosts the command bar and the find bar
  menu        application menu and the three context menus
  session     partition, user agent, permission prompts, Shields
src/preload/  the contextBridge API (window.chord)
src/renderer/ sidebar page (the window's own page) and the overlay page
test/         node:test suite for the model
```

Everything that changes state goes through `reduce(state, action)`. The main process
then *reconciles* the native views with the new state: it creates views for tabs that
should be awake, destroys the rest, lays out the visible panes, and persists the state.
That keeps the UI, the views and the saved session consistent by construction.

State lives in `~/Library/Application Support/Chord/state.json` (or the platform
equivalent). Browsing data uses the `persist:chord` session partition.

## Roadmap

- Hover to peek the sidebar when it is hidden; "Little Arc" style popup windows.
- Multiple windows; tab search across windows.
- Chrome extensions (Electron supports a subset of the extension API).
- Import bookmarks and history from Chrome, Brave, Arc, Firefox.
- Boosts (per-site CSS and JS), Easels, media picture-in-picture controls.
- Downloads panel, history view, password manager integration.
- Icons, auto-update, signed and notarised builds.

## License

MIT
