import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let isRestarting = false;
let codeLensProvider: vscode.Disposable | undefined;

// Symbol info from flat format (SymbolInformation)
interface SymbolInfo {
    name: string;
    kind: vscode.SymbolKind;
    location: {
        uri: string;
        range: {
            start: { line: number; character: number };
            end: { line: number; character: number };
        };
    };
}

class ElmReferencesCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        if (!client || document.languageId !== 'elm') {
            return [];
        }

        const config = vscode.workspace.getConfiguration('elm-lsp');
        if (!config.get<boolean>('codeLens.references', true)) {
            return [];
        }

        try {
            const response = await client.sendRequest('textDocument/documentSymbol', {
                textDocument: { uri: document.uri.toString() }
            });

            if (!response) return [];

            const codeLenses: vscode.CodeLens[] = [];

            // Handle flat format (SymbolInformation[])
            if (Array.isArray(response) && response.length > 0 && 'location' in response[0]) {
                const symbols = response as SymbolInfo[];
                for (const symbol of symbols) {
                    // Only show references for functions, types, and type aliases
                    if (symbol.kind === vscode.SymbolKind.Function ||
                        symbol.kind === vscode.SymbolKind.Class ||
                        symbol.kind === vscode.SymbolKind.Struct ||
                        symbol.kind === vscode.SymbolKind.Enum ||
                        symbol.kind === vscode.SymbolKind.Interface) {

                        const range = new vscode.Range(
                            symbol.location.range.start.line,
                            symbol.location.range.start.character,
                            symbol.location.range.end.line,
                            symbol.location.range.end.character
                        );

                        codeLenses.push(new vscode.CodeLens(range, undefined));
                    }
                }
            }

            return codeLenses;
        } catch (e) {
            outputChannel?.appendLine(`CodeLens error: ${e}`);
            return [];
        }
    }

    async resolveCodeLens(codeLens: vscode.CodeLens): Promise<vscode.CodeLens> {
        if (!client) {
            codeLens.command = { title: '', command: '' };
            return codeLens;
        }

        const document = vscode.window.activeTextEditor?.document;
        if (!document) {
            codeLens.command = { title: '', command: '' };
            return codeLens;
        }

        try {
            const references = await client.sendRequest('textDocument/references', {
                textDocument: { uri: document.uri.toString() },
                position: {
                    line: codeLens.range.start.line,
                    character: codeLens.range.start.character
                },
                context: { includeDeclaration: false }
            }) as vscode.Location[] | null;

            const count = references?.length ?? 0;
            const title = count === 1 ? '1 reference' : `${count} references`;

            codeLens.command = {
                title,
                command: count > 0 ? 'editor.action.findReferences' : '',
                arguments: count > 0 ? [
                    document.uri,
                    new vscode.Position(codeLens.range.start.line, codeLens.range.start.character)
                ] : undefined
            };
        } catch (e) {
            codeLens.command = { title: '', command: '' };
        }

        return codeLens;
    }
}

const codeLensProviderInstance = new ElmReferencesCodeLensProvider();

const GITHUB_REPO = 'CharlonTank/elm-lsp-rust';
const BINARY_NAME = process.platform === 'win32' ? 'elm_lsp.exe' : 'elm_lsp';

function getPlatformTarget(): string {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'darwin') {
        return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    } else if (platform === 'linux') {
        return 'linux-x64';
    } else if (platform === 'win32') {
        return 'win32-x64';
    }
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

async function findServerBinary(context: vscode.ExtensionContext): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('elm-lsp');
    const configPath = config.get<string>('server.path');
    if (configPath && fs.existsSync(configPath)) {
        return configPath;
    }

    const storagePath = context.globalStorageUri.fsPath;
    const downloadedBinary = path.join(storagePath, BINARY_NAME);
    if (fs.existsSync(downloadedBinary)) {
        return downloadedBinary;
    }

    const extensionPath = context.extensionPath;
    const devPaths = [
        path.join(extensionPath, '..', 'elm-lsp-rust', 'target', 'release', 'elm_lsp'),
        path.join(extensionPath, '..', 'elm-lsp-rust', 'target', 'debug', 'elm_lsp'),
    ];

    for (const devPath of devPaths) {
        if (fs.existsSync(devPath)) {
            return devPath;
        }
    }

    return undefined;
}

async function downloadBinary(context: vscode.ExtensionContext): Promise<string> {
    const storagePath = context.globalStorageUri.fsPath;
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    const target = getPlatformTarget();
    const binaryPath = path.join(storagePath, BINARY_NAME);

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Elm LSP',
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Fetching latest release...' });

        const releaseInfo = await fetchLatestRelease();
        const assetName = `elm_lsp-${target}${process.platform === 'win32' ? '.exe' : ''}`;
        const asset = releaseInfo.assets.find((a: { name: string }) => a.name === assetName);

        if (!asset) {
            throw new Error(`No binary found for ${target}. Available: ${releaseInfo.assets.map((a: { name: string }) => a.name).join(', ')}`);
        }

        progress.report({ message: `Downloading ${releaseInfo.tag_name}...` });

        await downloadFile(asset.browser_download_url, binaryPath);

        if (process.platform !== 'win32') {
            fs.chmodSync(binaryPath, 0o755);
        }

        return binaryPath;
    });
}

async function fetchLatestRelease(): Promise<{ tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/releases/latest`,
            headers: { 'User-Agent': 'vscode-elm-lsp' }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('Failed to parse release info'));
                }
            });
        }).on('error', reject);
    });
}

async function downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);

        const request = (url: string) => {
            https.get(url, { headers: { 'User-Agent': 'vscode-elm-lsp' } }, (res) => {
                if (res.statusCode === 302 || res.statusCode === 301) {
                    request(res.headers.location!);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`Download failed: ${res.statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => { });
                reject(err);
            });
        };

        request(url);
    });
}

async function startLanguageClient(context: vscode.ExtensionContext, serverPath: string): Promise<void> {
    const serverOptions: ServerOptions = {
        run: { command: serverPath, transport: TransportKind.stdio },
        debug: { command: serverPath, transport: TransportKind.stdio }
    };

    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Elm LSP');
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'elm' }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.elm')
        },
        outputChannel,
        errorHandler: {
            error: (error, message, count) => {
                outputChannel?.appendLine(`LSP Error: ${error.message}`);
                return { action: 1 }; // Continue
            },
            closed: () => {
                outputChannel?.appendLine('LSP connection closed unexpectedly');
                return { action: 2 }; // DoNotRestart - let user manually restart
            }
        }
    };

    client = new LanguageClient(
        'elm-lsp',
        'Elm Language Server',
        serverOptions,
        clientOptions
    );

    await client.start();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    let serverPath = await findServerBinary(context);

    if (!serverPath) {
        const choice = await vscode.window.showInformationMessage(
            'Elm LSP binary not found. Download from GitHub?',
            'Download',
            'Configure Path'
        );

        if (choice === 'Download') {
            try {
                serverPath = await downloadBinary(context);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to download: ${e}`);
                return;
            }
        } else if (choice === 'Configure Path') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'elm-lsp.server.path');
            return;
        } else {
            return;
        }
    }

    try {
        await startLanguageClient(context, serverPath);
        vscode.window.showInformationMessage('Elm LSP started');

        // Register CodeLens provider for references
        codeLensProvider = vscode.languages.registerCodeLensProvider(
            { language: 'elm', scheme: 'file' },
            codeLensProviderInstance
        );
        context.subscriptions.push(codeLensProvider);

        // Refresh CodeLens when documents change
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(() => {
                codeLensProviderInstance.refresh();
            })
        );
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to start Elm LSP: ${e}`);
        return;
    }

    // Handle Elm file renames/moves - update module declarations and imports
    context.subscriptions.push(
        vscode.workspace.onWillRenameFiles((event) => {
            const elmFiles = event.files.filter(
                f => f.oldUri.fsPath.endsWith('.elm') && f.newUri.fsPath.endsWith('.elm')
            );

            if (elmFiles.length === 0 || !client) return;

            event.waitUntil((async () => {
                const workspaceEdit = new vscode.WorkspaceEdit();

                for (const file of elmFiles) {
                    const oldDir = path.dirname(file.oldUri.fsPath);
                    const newDir = path.dirname(file.newUri.fsPath);
                    const newName = path.basename(file.newUri.fsPath);

                    try {
                        let result: any;

                        if (oldDir === newDir) {
                            // Same directory = rename
                            result = await client!.sendRequest('workspace/executeCommand', {
                                command: 'elm.renameFile',
                                arguments: [file.oldUri.toString(), newName]
                            });
                        } else {
                            // Different directory = move
                            const workspaceFolder = vscode.workspace.getWorkspaceFolder(file.oldUri);
                            const relativePath = workspaceFolder
                                ? path.relative(workspaceFolder.uri.fsPath, file.newUri.fsPath)
                                : file.newUri.fsPath;

                            result = await client!.sendRequest('workspace/executeCommand', {
                                command: 'elm.moveFile',
                                arguments: [file.oldUri.toString(), relativePath]
                            });
                        }

                        if (result?.success && result?.changes) {
                            for (const [uriStr, edits] of Object.entries(result.changes)) {
                                const uri = vscode.Uri.parse(uriStr);
                                for (const edit of edits as any[]) {
                                    const range = new vscode.Range(
                                        edit.range.start.line,
                                        edit.range.start.character,
                                        edit.range.end.line,
                                        edit.range.end.character
                                    );
                                    workspaceEdit.replace(uri, range, edit.newText);
                                }
                            }
                        }

                        if (result?.success) {
                            outputChannel?.appendLine(
                                `Elm: ${result.oldModuleName} → ${result.newModuleName} (${result.filesUpdated} files updated)`
                            );
                        } else if (result?.error) {
                            vscode.window.showWarningMessage(`Elm move/rename: ${result.error}`);
                        }
                    } catch (e) {
                        outputChannel?.appendLine(`Elm file rename error: ${e}`);
                    }
                }

                return workspaceEdit;
            })());
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('elm-lsp.restartServer', async () => {
            if (isRestarting) {
                vscode.window.showWarningMessage('Elm LSP is already restarting...');
                return;
            }
            isRestarting = true;
            try {
                if (client) {
                    await client.stop();
                }
                const newPath = await findServerBinary(context);
                if (newPath) {
                    await startLanguageClient(context, newPath);
                    vscode.window.showInformationMessage('Elm LSP restarted');
                }
            } finally {
                isRestarting = false;
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('elm-lsp.moveFunction', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'elm') {
                vscode.window.showWarningMessage('Open an Elm file first');
                return;
            }

            const targetModule = await vscode.window.showInputBox({
                prompt: 'Target module path (e.g., src/Utils/Helpers.elm)',
                placeHolder: 'src/Module.elm'
            });

            if (!targetModule || !client) return;

            const position = editor.selection.active;
            try {
                await client.sendRequest('workspace/executeCommand', {
                    command: 'elm.moveFunction',
                    arguments: [
                        editor.document.uri.toString(),
                        position.line,
                        position.character,
                        targetModule
                    ]
                });
            } catch (e) {
                vscode.window.showErrorMessage(`Move failed: ${e}`);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('elm-lsp.generateErd', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'elm') {
                vscode.window.showWarningMessage('Open an Elm file first');
                return;
            }

            const typeName = await vscode.window.showInputBox({
                prompt: 'Type name to generate ERD for',
                placeHolder: 'Model'
            });

            if (!typeName || !client) return;

            try {
                const result = await client.sendRequest('workspace/executeCommand', {
                    command: 'elm.generateErd',
                    arguments: [
                        editor.document.uri.toString(),
                        typeName
                    ]
                });

                const doc = await vscode.workspace.openTextDocument({
                    content: result as string,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc);
            } catch (e) {
                vscode.window.showErrorMessage(`ERD generation failed: ${e}`);
            }
        })
    );
}

export async function deactivate(): Promise<void> {
    if (client) {
        await client.stop();
    }
}
