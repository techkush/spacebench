# Contributing to Space Bench

Thanks for helping! Bug reports, ideas, examples, docs and code are all welcome.

## Reporting a bug
Open an issue with:
- what you did, what you expected and what happened (a screenshot helps);
- your system (macOS / Linux / Windows and version) and the Space Bench version (Settings → About);
- the circuit, Kirk file or sketch if you can share it.

## Working on the code
```sh
pnpm install
pnpm dev        # the app with hot reload (UI also at http://localhost:5173)
pnpm test       # please run before opening a pull request
```
- Keep pull requests focused: one change, with a test where it makes sense (`*.test.ts` next to the code).
- Match the style of the surrounding code (TypeScript + React in `apps/desktop/src`, Rust in `src-tauri` and
  `engine`). `pnpm --filter desktop lint` runs oxlint.
- New Kirk syntax: update the parser, the compiler, the generator (schematic → code) and
  `docs/kirk-language-spec.md` together.

## Third-party code and data
- Only add code or data from **permissively licensed** sources (MIT, BSD, Apache-2.0, ISC, public domain …) and
  record it in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with its licence and authors.
- **Never copy code from GPL, LGPL or AGPL projects** into the app. Tools under those licences may only be used as
  separate programs (like arduino-cli or QEMU).
- Material under share-alike licences (like the KiCad symbols, CC-BY-SA 4.0) stays in its own folder with its
  licence file.

## Licence of contributions
By contributing you agree that your contribution is released under the project's [MIT licence](LICENSE).

## Code of conduct
This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind.
