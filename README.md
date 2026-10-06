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

Above the editor, see your model, thinking level, session name and ID. Loaded skills get their own row, with token ages.

Below the editor, see:

- **Context remaining at a glance:** a color-graded gauge and used/window tokens.
- **Cost across the conversation:** cumulative cost and average cost per assistant turn.
- **Cache behavior:** session hit rate, latest hit or estimated miss, and reused/new token totals.
- **Where you are:** Git branch, dirty marker, directory, and other extensions’ status messages.

The layout follows your Pi theme and condenses to two footer lines in narrow panes.

On terminals with 40 rows or fewer, skills get at most four rows. To fit, the row first drops token ages, then separators, then shortens long names in the middle (`caut…ctor`). Only then does it show three rows plus a hidden-skill count.

**Resize without rescanning the conversation.** The header and footer share cached values. Session changes refresh them, including forks and compaction.

Skill age measures context-token growth since the first response after a skill load. A cache miss compares consecutive prompt sizes with reported reuse. Costs use the model’s reported pricing, including when you use a subscription.

## Development

```sh
npm ci
npm test
npm run check
```

Tests cover rendered values, skill tracking, cache reuse, session changes, and forks. They make no model calls.
