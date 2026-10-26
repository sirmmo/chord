# Chord

An open-source browser inspired by [Arc](https://arc.net): a vertical sidebar with
Spaces, Favorites, Pinned and Today tabs, a command bar instead of a URL bar,
split view, auto-archiving, and built-in ad and tracker blocking.

A *chord* is the straight line between two points on an arc.

Website: https://sirmmo.github.io/chord/ · Downloads: https://github.com/sirmmo/chord/releases/latest

Chord is built on Electron, so pages render with Chromium exactly as in Arc, Chrome
or Brave. It is an early 0.1: usable, unpolished, and missing plenty. See the roadmap.

## Features

- **Sidebar** with the page's navigation controls, a URL pill, and the tab lists.
  `⌘S` hides it. Drag its right edge to resize.
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
  or use "Open in Split View" from a tab's or a link's context menu.
- **Shields**: ad and tracker blocking (EasyList and EasyPrivacy through the Ghostery
  engine). Toggle from the command bar.
- **Find in page** `⌘F`, tab sleep, mute, reopen closed tab `⌘⇧T`, per-site
  permission prompts, OAuth-style popups opened as tabs.

## Shortcuts

| Keys | Action |
| --- | --- |
| `⌘T` / `⌘L` | Command bar: new tab / edit current URL |
| `⌘W` · `⌘⇧T` | Close tab · reopen closed tab |
| `⌘S` | Toggle sidebar |
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
