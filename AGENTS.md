---
last_updated: 2026-11-14T15-30
---

# custom-footer

## Core principle: every width and height is a first-class view

Design every widget, and the gaps between widgets, starting from the tightest view. That view is a zoomed-in phone over SSH with the keyboard covering half the screen, where every line and every character counts. Then keep the same care at each size up to a wide desktop that has room for everything. Tight multiplexer panes sit in between and matter just as much.

This standard is a product requirement, not polish. A change that works at one size and gets worse at another is a regression.

- **Rank before you shrink.** Details and whole facts share one ranking. When space runs out, the least important item goes first, whether it is a detail or a whole fact. The footer's order is the pace bar with its words "resets in", then labels, then shorter readings (the last message's cache share, then the rounded cost), then whitespace, then the branch icon. After that, whole facts hide: the subscription mark, a stale quota reading's age, the burn rate with its reset time, the reused/new split, the last message's plain hit or miss, the token counts, the session hit rate, the word "target", the cache time, and the cost per turn. Then a detected cache miss drops its cause. The cause outranks those facts because it shows only on the turn that missed. A miss keeps its cost to the end. Last of all, the target rate hides, and only where it alone would add a line, as on a phone with the keyboard up. The header and the skill row follow the same rule. The ladders in `index.ts` (`HEADER_LADDER`, `FOOTER_LADDER`, `skillLayouts`) encode the order, and their comments say why. When a ladder changes, update its comment, this list and the README together.
- **Height counts too.** The skill rows scale with terminal height. The calibration comes from a real phone screen. Do not take height from other widgets.
- **New or changed facts.** Give each one its forms, place each step in the ladder by importance, and state the ranking in the code.
- **Prove it at several sizes.** `tests/layout.mjs` asserts exact lines at narrow and wide widths. `tests/skills.mjs` covers skill rows at different terminal heights. Extend them for every visible change, down to phone sizes of about 40 columns and 21 rows.

## Mirrored Pi logic

The cache-miss numbers mirror Pi's `detectMiss` in `dist/core/cache-stats.js`, which Pi does not export. `tests/miss-parity.mjs` checks them against Pi's real code. If it fails after a Pi update, re-sync the mirror in `index.ts`.

The cache expiry uses Pi's exported warming policy (`evaluateCacheWarming`, `getCacheWarmingDelayMs`, `CACHE_WARMING_MAX_IDLE_AGE_MS`, `getPromptCacheTtlMs`) and Pi's own `cacheWarming` default through `SettingsManager`. Two pieces mirror Pi: the lifetime lookup on `model.promptCache`, used only where pi-ai does not export `getPromptCacheTtlMs` (before Pi 1.5.1), and the idle horizon, the last refresh of `CacheWarmer` inside its idle limit. `tests/expiry.mjs` pins both with Pi's numbers and fails loudly when they change.
