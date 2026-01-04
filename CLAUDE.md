# vscode-elm-lsp

VS Code extension for Elm language support using elm-lsp-rust.

## IMPORTANT: After Every Update

**Always install the extension locally after making changes:**

```bash
npm run package && cursor --install-extension vscode-elm-lsp-*.vsix
```

## Development

```bash
npm install
npm run compile   # or: npm run watch
```

Press F5 in VS Code to launch Extension Development Host.

## Architecture

```
vscode-elm-lsp/
├── package.json              # Extension manifest
├── language-configuration.json  # Elm syntax config
├── src/
│   └── extension.ts          # Main entry point
├── tsconfig.json
└── out/                      # Compiled JS (generated)
```

## Binary Resolution

The extension finds the LSP binary in this order:
1. `elm-lsp.server.path` setting (user configured)
2. Downloaded binary in `globalStorageUri`
3. Sibling `elm-lsp-rust/target/release/elm_lsp` (dev mode)

## Key Dependencies

- `vscode-languageclient` - LSP client library
- `@types/vscode` - VS Code API types

## Commands

| Command | Description |
|---------|-------------|
| `elm-lsp.restartServer` | Restart the language server |
| `elm-lsp.moveFunction` | Move function to another module |
| `elm-lsp.generateErd` | Generate ER diagram from type |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `elm-lsp.server.path` | `""` | Custom path to elm_lsp binary |
| `elm-lsp.codeLens.references` | `true` | Show reference counts above definitions |

## Publishing

```bash
npm run package   # Creates .vsix file
npx vsce publish  # Publish to marketplace
```

## Testing

1. Build elm-lsp-rust: `cd ../elm-lsp-rust && cargo build --release`
2. Press F5 in VS Code
3. Open an Elm project in the Extension Development Host
4. Verify hover, go-to-definition, rename work
