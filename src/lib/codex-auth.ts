import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig, type AccountConfig } from './config';

export type CodexDeviceFlowPublicState = {
  identity: string;
  state: 'pending' | 'authorized' | 'expired' | 'failed';
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  startedAt: string;
  message?: string;
};

/** Minimal child-process handle the manager relies on (adapted from Bun.Subprocess). */
export type CodexSpawnedProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exited: Promise<number>;
  kill: () => void;
};

export type CodexSpawnFn = (cmd: string[], env: NodeJS.ProcessEnv) => CodexSpawnedProcess;

type CodexDeviceFlowInternalState = CodexDeviceFlowPublicState & {
  process?: CodexSpawnedProcess;
  timer?: NodeJS.Timeout;
  output: string;
};

type AuthFile = {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

type CodexAuthOptions = {
  now?: () => Date;
  spawn?: CodexSpawnFn;
  expiresMs?: number;
  command?: string;
  accounts?: AccountConfig[];
};

/**
 * `@openai/codex` only ships a JS launcher; the executable lives in the platform
 * package. Probe the vendored paths that exist in the image instead of pinning a
 * single one, and fall back to whatever `codex` is on PATH (dev machines).
 */
const VENDORED_CODEX_BINS = [
  '/app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
  '/app/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex',
];

export function resolveCodexCommand(candidates = VENDORED_CODEX_BINS): string {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  return candidates.find((bin) => existsSync(bin)) ?? 'codex';
}

const DEFAULT_CODEX_COMMAND = resolveCodexCommand();
const DEFAULT_EXPIRES_MS = 15 * 60_000;
const DEVICE_URL_RE = /https:\/\/auth\.openai\.com\/codex\/device\b/;
const USER_CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/;

const defaultSpawn: CodexSpawnFn = (cmd, env) => {
  const child = spawn(cmd[0]!, cmd.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: () => child.kill(),
  };
};

export class CodexAuthManager {
  private flows = new Map<string, CodexDeviceFlowInternalState>();
  private now: () => Date;
  private spawnFn: CodexSpawnFn;
  private expiresMs: number;
  private command: string;
  private accounts: AccountConfig[];

  constructor(options: CodexAuthOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.expiresMs = options.expiresMs ?? DEFAULT_EXPIRES_MS;
    this.command = options.command ?? DEFAULT_CODEX_COMMAND;
    this.accounts = options.accounts ?? loadConfig().accounts;
  }

  start(identity: string): CodexDeviceFlowPublicState {
    const account = this.codexAccount(identity);
    const existing = this.flows.get(identity);
    if (existing && existing.state === 'pending') return this.publicState(existing, 'Login already in progress for this identity.');

    const started = this.now();
    const expiresAt = new Date(started.getTime() + this.expiresMs);
    const state: CodexDeviceFlowInternalState = {
      identity,
      state: 'pending',
      verificationUrl: null,
      userCode: null,
      expiresAt: expiresAt.toISOString(),
      startedAt: started.toISOString(),
      output: '',
    };
    this.flows.set(identity, state);
    // `codex login` logs out first, so a flow that never completes leaves the
    // identity with no tokens at all. Keep the old file to put back on failure.
    const previousAuth = snapshotCodexAuth(account);

    try {
      state.process = this.spawnFn(
        [this.command, 'login', '--device-auth'],
        { ...process.env, CODEX_HOME: codexHome(account) },
      );
      this.readProcessOutput(state);
      state.process.exited.then(async (code) => {
        if (state.state !== 'pending') return;
        if (await hasCodexTokens(account)) {
          this.finish(identity, 'authorized');
        } else if (code === 0) {
          state.message = 'Device code issued; waiting for authorization.';
        } else {
          state.state = 'failed';
          state.message = `Codex login process exited before authorization (code ${code}).`;
          if (await restoreCodexAuth(account, previousAuth)) state.message += ' Previous tokens restored.';
        }
      }).catch(async (error) => {
        if (state.state === 'pending') {
          state.state = 'failed';
          state.message = safeError(error);
          if (await restoreCodexAuth(account, previousAuth)) state.message += ' Previous tokens restored.';
        }
      });
      state.timer = setTimeout(() => {
        if (state.state === 'pending') {
          state.state = 'expired';
          state.message = 'Device authorization expired.';
          this.kill(state);
          void restoreCodexAuth(account, previousAuth).then((restored) => {
            if (restored) state.message = 'Device authorization expired. Previous tokens restored.';
          });
        }
      }, this.expiresMs + 1_000);
    } catch (error) {
      state.state = 'failed';
      state.message = safeError(error);
    }

    return this.publicState(state);
  }

  async status(identity: string): Promise<CodexDeviceFlowPublicState> {
    const account = this.codexAccount(identity);
    const state = this.flows.get(identity);
    if (state && state.state === 'pending' && await hasCodexTokens(account)) this.finish(identity, 'authorized');
    if (state) return this.publicState(state);
    return {
      identity,
      state: await hasCodexTokens(account) ? 'authorized' : 'failed',
      verificationUrl: null,
      userCode: null,
      expiresAt: null,
      startedAt: this.now().toISOString(),
      message: await hasCodexTokens(account) ? 'Already authorized.' : 'No login attempt is active for this identity.',
    };
  }

  clear(identity: string) {
    const state = this.flows.get(identity);
    if (state) this.kill(state);
    this.flows.delete(identity);
  }

  private codexAccount(identity: string) {
    const account = this.accounts.find((a) => a.provider === 'codex' && a.key === identity);
    if (!account) throw new Error('Unknown Codex identity.');
    return account;
  }

  private finish(identity: string, terminal: 'authorized' | 'expired' | 'failed') {
    const state = this.flows.get(identity);
    if (!state) return;
    state.state = terminal;
    state.message = terminal === 'authorized' ? 'Authorization complete.' : state.message;
    this.kill(state);
  }

  private kill(state: CodexDeviceFlowInternalState) {
    if (state.timer) clearTimeout(state.timer);
    try { state.process?.kill(); } catch {}
  }

  private publicState(state: CodexDeviceFlowInternalState, message = state.message): CodexDeviceFlowPublicState {
    return {
      identity: state.identity,
      state: state.state,
      verificationUrl: state.verificationUrl,
      userCode: state.userCode,
      expiresAt: state.expiresAt,
      startedAt: state.startedAt,
      ...(message ? { message } : {}),
    };
  }

  private readProcessOutput(state: CodexDeviceFlowInternalState) {
    const consume = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      stream.on('data', (chunk: Buffer | string) => {
        state.output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        state.output = stripAnsi(state.output.slice(-4096));
        const url = state.output.match(DEVICE_URL_RE)?.[0];
        const code = state.output.match(USER_CODE_RE)?.[1];
        if (url) state.verificationUrl = url;
        if (code) state.userCode = code;
      });
      stream.on('error', (error) => {
        if (state.state === 'pending') state.message = safeError(error);
      });
    };
    consume(state.process?.stdout ?? null);
    consume(state.process?.stderr ?? null);
  }
}

export const codexAuthManager = new CodexAuthManager();

export function codexHome(account: AccountConfig) {
  if (account.codex_home) return account.codex_home;
  const profile = account.key.startsWith('codex-') ? account.key.slice('codex-'.length) : account.key;
  return `/codex-profiles/${profile}`;
}

export function codexAuthPath(account: AccountConfig) {
  return `${codexHome(account)}/auth.json`;
}

export async function readCodexAuth(account: AccountConfig): Promise<AuthFile | null> {
  try {
    return JSON.parse(await readFile(codexAuthPath(account), 'utf8')) as AuthFile;
  } catch {
    return null;
  }
}

export async function readCodexAccessToken(account: AccountConfig): Promise<string | null> {
  const data = await readCodexAuth(account);
  return data?.tokens?.access_token ?? null;
}

export async function hasCodexTokens(account: AccountConfig): Promise<boolean> {
  const data = await readCodexAuth(account);
  return Boolean(data?.tokens?.access_token && data?.tokens?.refresh_token);
}

/** Read auth.json verbatim so a failed login can be rolled back. */
export function snapshotCodexAuth(account: AccountConfig): string | null {
  try {
    return readFileSync(codexAuthPath(account), 'utf8');
  } catch {
    return null;
  }
}

/** Put a snapshot back, but only if the login left the identity token-less. */
export async function restoreCodexAuth(account: AccountConfig, snapshot: string | null): Promise<boolean> {
  if (!snapshot) return false;
  if (await hasCodexTokens(account)) return false;
  try {
    await writeFile(codexAuthPath(account), snapshot, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export async function refreshCodexAuth(account: AccountConfig, command = DEFAULT_CODEX_COMMAND): Promise<boolean> {
  try {
    const proc = defaultSpawn(
      [command, 'login', 'status'],
      { ...process.env, CODEX_HOME: codexHome(account) },
    );
    const timeout = setTimeout(() => { try { proc.kill(); } catch {} }, 10_000);
    const code = await proc.exited.finally(() => clearTimeout(timeout));
    return code === 0 && await hasCodexTokens(account);
  } catch {
    return false;
  }
}

export function redactCodexSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCodexSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
    if (/token|secret|cookie|authorization|device_code/i.test(key)) return [key, '[redacted]'];
    return [key, redactCodexSecrets(nested)];
  }));
}

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function safeError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const message = stripAnsi(error.message).replace(/[A-Z0-9]{4}-[A-Z0-9]{4,6}/g, '[redacted-code]');
  if (!message.includes('ENOENT')) return message;
  return `${message} — Codex CLI binary is missing from the image; rebuild it (see DEPLOYMENT.md) or set CODEX_BIN.`;
}
