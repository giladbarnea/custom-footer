---
last_updated: 2026-11-06T23-44
---

<div align="center">

# Custom Footer

**Know how much context remains. See what each turn costs.**

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi)
[![npm](https://img.shields.io/npm/v/%40giladbarnea%2Fpi-custom-footer)](https://www.npmjs.com/package/@giladbarnea/pi-custom-footer)
[![license](https://img.shields.io/github/license/giladbarnea/custom-footer)](LICENSE)

</div>

A Pi footer that puts your session’s context, cache usage, cost, and loaded skills around the editor.

```sh
pi install npm:@giladbarnea/pi-custom-footer
```

Supports Pi 1.4.x and 1.5.x, the latest stable minor and its predecessor.

Above the editor, see your model, thinking level, session name and ID. Loaded skills get their own row, with token ages. Compaction and context edits remove skills whose loaded text is no longer present verbatim. Restoring that text restores the skill.

Below the editor, see:

- **Context remaining at a glance:** a color-graded gauge and used/window tokens.
- **Cost across the conversation:** cumulative cost and average cost per assistant turn.
- **Cache behavior:** session hit rate, latest hit or estimated miss, and reused/new token totals.
- **Where you are:** Git branch, dirty marker, directory, and other extensions’ status messages.

The layout follows your Pi theme. The header and the footer each take the fewest lines they can. To fit, they first drop labels, round readings, remove whitespace, and drop the branch icon. Only then does the footer hide facts: the reused/new split, the session hit rate, the token counts, and last the cost per turn.

Skills get one row for every eight terminal rows past the first six, with a minimum of one. A 21-row phone screen gets one row, a 27-row screen two, and a 34-row screen three. To fit, the row first drops token ages, then separators, then shortens long names in the middle (`caut…ctor`). Only then does it hide skills from the end, behind a `+N` count at the end of the last row.

**Resize without rescanning the conversation.** The header and footer share cached values. Session changes refresh them, including forks and compaction.

Skill age measures context-token growth since the first response after a skill load. A cache miss compares consecutive prompt sizes with reported reuse. Costs use the model’s reported pricing, including when you use a subscription.

## Development

```sh
npm ci
npm test
npm run check
```

Tests cover rendered values, skill tracking, cache reuse, session changes, forks, compaction, and native context edits. SDK tests use a local scripted provider, with no external model calls.
