# Elm LSP for VS Code

Elm language support powered by [elm-lsp-rust](https://github.com/CharlonTank/elm-lsp-rust).

## Features

- **Hover**: Type information and documentation
- **Go to Definition**: Jump to symbol definitions
- **Find References**: Find all usages across your project
- **Rename**: Safe rename for functions, types, variants, and fields
- **Code Actions**: Quick fixes and refactorings
- **Diagnostics**: Compiler errors via elm/lamdera make
- **Completion**: Code completion with `.` trigger
- **Document Symbols**: Outline view of current file
- **Workspace Symbols**: Search symbols across project

### Special Commands

- **Move Function**: Move a function to another module (updates all imports)
- **Generate ERD**: Create entity-relationship diagrams from types

## Installation

### From VS Code Marketplace

Coming soon.

### From Source (Development)

1. Clone the repository:
   ```bash
   git clone https://github.com/CharlonTank/elm-lsp-rust
   cd elm-lsp-rust
   ```

2. Build the LSP server:
   ```bash
   cargo build --release
   ```

3. Open the `vscode-elm-lsp` folder in VS Code:
   ```bash
   cd ../vscode-elm-lsp
   npm install
   code .
   ```

4. Press `F5` to launch the Extension Development Host

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `elm-lsp.server.path` | Path to elm_lsp binary | Auto-detect |
| `elm-lsp.trace.server` | Trace level for debugging | `off` |

## Requirements

- Elm 0.19.x installed
- An `elm.json` file in your workspace

## License

MIT
