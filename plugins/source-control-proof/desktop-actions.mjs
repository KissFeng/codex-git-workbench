import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, win32 } from 'node:path';
import { promisify } from 'node:util';
import { checkoutRoot } from './git-status.mjs';
import { safePath } from './repo-path.mjs';

const runDesktop = promisify(execFile);
const pickerTimeout = 55000;
const applePicker = [
  'on run argv',
  'try',
  'set initialFolder to POSIX file (item 1 of argv) as alias',
  'set selectedFolder to choose folder with prompt (item 2 of argv) default location initialFolder',
  'return POSIX path of selectedFolder',
  'on error messageText number errorNumber',
  'if errorNumber is -128 then return ""',
  'error messageText number errorNumber',
  'end try',
  'end run',
];
const windowsPicker = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  $dialog.Description = $env:CODEX_GIT_WORKBENCH_PROMPT
  $dialog.SelectedPath = $env:CODEX_GIT_WORKBENCH_TARGET
  $dialog.ShowNewFolderButton = $false
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine($dialog.SelectedPath)
  }
} finally { $dialog.Dispose() }`;

function runPowerShell(run, script, target, timeout, prompt = '') {
  const program = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8;\n" + script;
  return run(program, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout, windowsHide: true,
    env: { ...process.env, CODEX_GIT_WORKBENCH_TARGET: target, CODEX_GIT_WORKBENCH_PROMPT: prompt },
  });
}

export async function pickCheckout({ repoPath, path, language }, { platform = process.platform, run = runDesktop } = {}) {
  if (path !== undefined) return { checkout: await checkoutRoot(path) };
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Folder picker is unavailable.');
  const start = isAbsolute(repoPath || '') && (await stat(repoPath).catch(() => null))?.isDirectory() ? repoPath : homedir();
  const prompt = language === 'zh-CN' ? '选择 Git 工作副本文件夹' : 'Choose a Git working copy folder';
  let stdout;
  try {
    ({ stdout } = platform === 'darwin'
      ? await run('/usr/bin/osascript', [...applePicker.flatMap(line => ['-e', line]), '--', start, prompt], { encoding: 'utf8', timeout: pickerTimeout })
      : await runPowerShell(run, windowsPicker, start, pickerTimeout, prompt));
  } catch {
    throw new Error('Folder picker is unavailable.');
  }
  const selected = stdout.replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
  return { checkout: selected ? await checkoutRoot(selected) : null };
}

export async function openCheckoutItem({ repoPath, path, action }, { platform = process.platform, run = runDesktop } = {}) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Opening files on this desktop is unavailable.');
  if (!['open', 'folder'].includes(action)) throw new Error('Invalid action.');
  if (platform === 'win32' && path.includes(':')) throw new Error('Invalid repository-relative file path.');
  const root = await checkoutRoot(repoPath);
  const target = safePath(root, path);
  const entry = action === 'folder' ? dirname(target) : target;
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(entry).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new Error(action === 'folder' ? 'The folder no longer exists.' : 'The file no longer exists.');
    }
    throw error;
  });
  if (canonical !== canonicalRoot || action !== 'folder') safePath(canonicalRoot, relative(canonicalRoot, canonical));
  const info = await stat(canonical);
  if (action === 'folder' ? !info.isDirectory() : !info.isFile()) throw new Error('The requested file or folder is unavailable.');
  try {
    if (platform === 'darwin') await run('/usr/bin/open', [canonical], { timeout: 10000 });
    else await runPowerShell(run, 'Invoke-Item -LiteralPath $env:CODEX_GIT_WORKBENCH_TARGET', canonical, 10000);
  } catch {
    throw new Error(action === 'folder' ? 'Could not open the folder.' : 'Could not open the file.');
  }
  return { opened: true };
}
