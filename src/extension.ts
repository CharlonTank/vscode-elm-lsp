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
    } catch (e) {
        vscode.window.showErrorMessage(`Failed to start Elm LSP: ${e}`);
        return;
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('elm-lsp.restartServer', async () => {
            if (client) {
                await client.stop();
            }
            const newPath = await findServerBinary(context);
            if (newPath) {
                await startLanguageClient(context, newPath);
                vscode.window.showInformationMessage('Elm LSP restarted');
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
