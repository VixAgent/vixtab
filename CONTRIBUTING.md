# Contributing

Thanks for helping! VixTab is a small Bun + TypeScript code base.

```bash
bun install
bun run typecheck
bun test test/                  # unit tests + `vixtab playground demo board` end to end
bun run vixtab <command>        # run the CLI from source
bun run diagrams                # re-draw docs/images after editing docs/diagrams/figures.ts
bun run build                   # dist/: standalone CLIs, one .vsix per platform, archives
```

- **Layout.** `src/core/` is shared; everything that differs between Linux and Windows goes behind the `Platform` interface in
  `src/platform/`. `extension/` is plain JavaScript (no build step). `skills/` are the Claude Code skills, embedded into the CLI
  and installed by `vixtab setup` / `vixtab skills`, for every project or per repository (the skills scope).
- **Never break the board format** without a migration: `tickets/README.md` rows and the `- **Status:**` line are parsed.
- **Claude Code internals** (`claude-vscode.editor.open`, the session registry, transcripts) change between versions. When you
  touch that code, write down the Claude Code version you tested with.
- Test on both operating systems when you change processes, paths, locks or the shell used for tests.
- Keep commits focused; describe the user-visible effect in the message.
