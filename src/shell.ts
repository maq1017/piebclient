/**
 * Interactive shell for piebclient.
 * Mirrors the command surface of ~/code/ecoclient/src/command/interactive.ts
 * but sends packets directly through the PiEconetBridge named pipe.
 */

import * as readline from 'readline';
import * as fs       from 'fs';
import * as path     from 'path';

import { EconetPipe, sleep } from './pipe';
import { commandTalk } from './talk';
import {
  EconetAddress,
  DirectoryHandles,
  iAm,
  bye,
  dir,
  cdir,
  access,
  deleteObject,
  examineDir,
  readDirInfo,
  readObjectAccess,
  load,
  save,
  fslist,
  notify,
  saveInf,
  loadInf,
  InfMetadata,
} from './protocol';

// ── Help text ──────────────────────────────────────────────────────────────────

const HELP = `
Commands:
  i am [net.]<stn> <user> [pass]   Logon to file server (":" as pass to prompt)
  bye                              Logout from file server
  cat [dir]                        List directory contents
  dir [path]                       Change current directory
  get <path> [-r] [-f]             Download file(s) from file server
  put <path> [-r] [-f]             Upload file(s) to file server
  fslist                           List file servers on the network
  talk [name]                      Join the Econet Network Conferencer
  notify [net.]<stn> <message>     Send notification to a station
  cdir <dir>                       Create directory on file server
  access <path> <access>           Set file access permissions
  delete <path> [-r] [-f]          Delete file(s) from file server
  help                             Show this help
  exit                             Exit
`;

// ── Utilities ─────────────────────────────────────────────────────────────────

const parseFlags = (args: string[]) => ({
  recurse:    args.includes('-r') || args.includes('--recurse'),
  force:      args.includes('-f') || args.includes('--force'),
  positional: args.filter(a => !a.startsWith('-')),
});

const isAddress = (s: string) => /^\d+(\.\d+)?$/.test(s);

const parseAddress = (s: string): EconetAddress => {
  const parts = s.split('.');
  return parts.length === 2
    ? { network: parseInt(parts[0]!, 10), station: parseInt(parts[1]!, 10) }
    : { network: 0,                        station: parseInt(parts[0]!, 10) };
};

const addrStr = (a: EconetAddress) =>
  a.network > 0 ? `${a.network}.${a.station}` : `${a.station}`;

const VALID_NAME   = /^[a-zA-Z0-9!_-]{1,10}$/;
const LOAD_EXEC_FN = /^[a-zA-Z0-9!_-]{1,10},[0-9A-Fa-f]{8},[0-9A-Fa-f]{8}$/;

function isValidName(n: string)       { return VALID_NAME.test(n);   }
function isLoadExecName(n: string)    { return LOAD_EXEC_FN.test(n); }
function isWildcard(n: string)        { return n.includes('*') || n.includes('?'); }
function wildcardMatch(name: string, pat: string): boolean {
  const re = new RegExp(`^${pat.toLowerCase().replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(name.toLowerCase());
}

// ── Interactive shell ─────────────────────────────────────────────────────────

export async function runShell(
  pipe:          EconetPipe,
  initialServer: EconetAddress,
  debug          = false,
): Promise<void> {
  let server  = initialServer;
  let handles: DirectoryHandles = { userRoot: 0, current: 0, library: 0 };

  console.log('Type "help" for commands, "exit" to quit.');

  return new Promise<void>(resolve => {
    let closing           = false;
    let passwordResolve: ((s: string) => void) | null = null;

    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
      prompt: 'econet> ',
    });

    // ── Visible line input ───────────────────────────────────────────────────
    const readLine = (prompt: string): Promise<string> =>
      new Promise(res => {
        passwordResolve = res;
        process.stdout.write(prompt);
        rl.resume();
      });

    // ── Password input (mutes echo) ──────────────────────────────────────────
    const readPassword = (prompt: string): Promise<string> =>
      new Promise(res => {
        const origWrite = process.stdout.write.bind(process.stdout);
        let muted = false;
        (process.stdout as NodeJS.WriteStream & { write: typeof process.stdout.write }).write =
          function (chunk: unknown, encOrCb?: unknown, cb?: unknown) {
            if (!muted) return origWrite(chunk as string, encOrCb as BufferEncoding, cb as () => void);
            const callback = typeof encOrCb === 'function' ? encOrCb : cb;
            if (typeof callback === 'function') callback();
            return true;
          };
        origWrite(prompt);
        muted = true;
        passwordResolve = (pw: string) => {
          muted = false;
          process.stdout.write = origWrite as typeof process.stdout.write;
          origWrite('\n');
          res(pw);
        };
        rl.resume();
      });

    rl.prompt();

    // ── Command dispatcher ────────────────────────────────────────────────────
    const processLine = async (line: string) => {
      const tokens = line.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return;

      let cmd  = tokens[0]!.toLowerCase();
      let args = tokens.slice(1);

      // "i am" → "i-am"
      if (cmd === 'i' && args[0]?.toLowerCase() === 'am') {
        cmd  = 'i-am';
        args = args.slice(1);
      }

      try {
        switch (cmd) {

          // ── I AM ───────────────────────────────────────────────────────────
          case 'i-am': {
            if (args.length < 1) throw new Error('Usage: i am [net.]<stn> <user> [pass]');
            let username: string;
            let password: string;
            if (args.length >= 2 && isAddress(args[0]!)) {
              server   = parseAddress(args[0]!);
              username = args[1]!;
              password = args[2] === ':' ? await readPassword('Password: ') : (args[2] ?? '');
            } else {
              username = args[0]!;
              password = args[1] === ':' ? await readPassword('Password: ') : (args[1] ?? '');
            }
            handles = await iAm(pipe, server, username, password);
            console.log(`Logged in to ${addrStr(server)} as ${username}`);
            break;
          }

          // ── BYE ───────────────────────────────────────────────────────────
          case 'bye': {
            await bye(pipe, server, handles);
            handles = { userRoot: 0, current: 0, library: 0 };
            console.log('Logged out');
            break;
          }

          // ── CAT ───────────────────────────────────────────────────────────
          case 'cat': {
            const dirPath = args[0] ?? '';
            // Sequential — both wait on REPLY_PORT; concurrent would race.
            const dirInfo = await readDirInfo(pipe, server, dirPath, handles);
            const files   = await examineDir(pipe, server, dirPath, handles);
            console.log(`[${dirInfo.dirName} (${dirInfo.cycleNum}) - ${dirInfo.isOwner ? 'Owner' : 'Public'}]`);
            for (const f of files) {
              console.log(
                `${f.name.padEnd(10)} ${f.loadAddress.padEnd(8)} ${f.execAddress.padEnd(8)}` +
                `  ${f.sizeBytes.toString(10).padStart(8)} ${f.access.padEnd(10)} ${f.date} ${f.id}`,
              );
            }
            break;
          }

          // ── DIR ───────────────────────────────────────────────────────────
          case 'dir': {
            const newHandle = await dir(pipe, server, args[0] ?? '', handles);
            handles = { ...handles, current: newHandle };
            break;
          }

          // ── GET ───────────────────────────────────────────────────────────
          case 'get': {
            const { recurse, force, positional } = parseFlags(args);
            if (positional.length < 1) throw new Error('Usage: get <path> [-r] [-f]');
            await commandGet(pipe, server, handles, positional[0]!, recurse, force);
            break;
          }

          // ── PUT ───────────────────────────────────────────────────────────
          case 'put': {
            const { recurse, force, positional } = parseFlags(args);
            if (positional.length < 1) throw new Error('Usage: put <path> [-r] [-f]');
            await commandPut(pipe, server, handles, positional[0]!, recurse, force);
            break;
          }

          // ── FSLIST ────────────────────────────────────────────────────────
          case 'fslist': {
            process.stdout.write('Scanning for file servers...\n');
            const servers = await fslist(pipe);
            if (servers.length === 0) {
              console.log('No file servers found');
            } else {
              for (const s of servers) {
                const addr = s.network > 0 ? `${s.network}.${s.station}` : `${s.station}`;
                console.log(`${addr.padEnd(8)} ${s.version}`);
              }
            }
            break;
          }

          // ── TALK ──────────────────────────────────────────────────────────
          case 'talk': {
            const name = (args[0] ?? await readLine('Your name: ')).trim();
            if (!name) throw new Error('Name is required.');
            rl.pause();
            await commandTalk(pipe, name, debug);
            rl.resume();
            break;
          }

          // ── NOTIFY ────────────────────────────────────────────────────────
          case 'notify': {
            if (args.length < 2) throw new Error('Usage: notify [net.]<stn> <message>');
            const dest    = parseAddress(args[0]!);
            const message = args.slice(1).join(' ');
            await notify(pipe, dest, message);
            console.log(`Notified ${addrStr(dest)}`);
            break;
          }

          // ── CDIR ──────────────────────────────────────────────────────────
          case 'cdir': {
            if (args.length < 1) throw new Error('Usage: cdir <dir>');
            await cdir(pipe, server, args[0]!, handles);
            console.log(`Created directory ${args[0]}`);
            break;
          }

          // ── ACCESS ────────────────────────────────────────────────────────
          case 'access': {
            if (args.length < 2) throw new Error('Usage: access <path> <accessString>');
            await access(pipe, server, args[0]!, args[1]!, handles);
            console.log(`Access set on ${args[0]}`);
            break;
          }

          // ── DELETE ────────────────────────────────────────────────────────
          case 'delete': {
            const { recurse, force, positional } = parseFlags(args);
            if (positional.length < 1) throw new Error('Usage: delete <path> [-r] [-f]');
            await commandDelete(pipe, server, handles, positional[0]!, recurse, force);
            break;
          }

          // ── HELP / EXIT ───────────────────────────────────────────────────
          case 'help':
            console.log(HELP);
            break;

          case 'exit':
          case 'quit':
            closing = true;
            rl.close();
            return;

          default:
            console.error(`Unknown command: ${cmd}. Type "help" for available commands.`);
        }
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
      }
    };

    rl.on('line', async (line: string) => {
      if (passwordResolve) {
        const res = passwordResolve;
        passwordResolve = null;
        rl.pause(); // keep readline quiet while the async command runs
        res(line);
        return;
      }
      rl.pause();
      await processLine(line);
      if (!closing) {
        rl.resume();
        rl.prompt();
      }
    });

    rl.on('close', () => {
      console.log('');
      resolve();
    });
  });
}

// ── GET implementation ────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

async function commandGet(
  pipe:     EconetPipe,
  server:   EconetAddress,
  handles:  DirectoryHandles,
  remotePath: string,
  recurse:  boolean,
  force:    boolean,
): Promise<void> {
  const parsed = splitPath(remotePath);
  if (!parsed.base || isWildcard(parsed.base)) {
    await getMultiple(pipe, server, handles, parsed.dir ?? '', parsed.base ?? '*', recurse, force);
    return;
  }

  const info = await readObjectAccess(pipe, server, remotePath, handles);
  if (!info.fileExists) throw new Error(`Not found: ${remotePath}`);

  if (info.isDir) {
    if (!recurse) throw new Error(`'${remotePath}' is a directory — use -r to recurse`);
    const localDir = parsed.base;
    if (!force && fs.existsSync(localDir)) {
      console.log(`Skipping existing directory: ${localDir} (use -f to overwrite)`);
      return;
    }
    if (!fs.existsSync(localDir)) fs.mkdirSync(localDir);
    const orig = process.cwd();
    process.chdir(localDir);
    await getMultiple(pipe, server, handles, remotePath, '*', recurse, force);
    process.chdir(orig);
  } else {
    await getSingleWithRetry(pipe, server, handles, remotePath, force);
  }
}

async function getMultiple(
  pipe:    EconetPipe,
  server:  EconetAddress,
  handles: DirectoryHandles,
  dirPath: string,
  pattern: string,
  recurse: boolean,
  force:   boolean,
): Promise<void> {
  const all   = await examineDir(pipe, server, dirPath, handles);
  const match = all.filter(f => wildcardMatch(f.name, pattern));

  for (const f of match.filter(f => !f.access.includes('D'))) {
    const full = dirPath ? `${dirPath}.${f.name}` : f.name;
    await getSingleWithRetry(pipe, server, handles, full, force);
  }

  for (const f of match.filter(f => f.access.includes('D'))) {
    const full = dirPath ? `${dirPath}.${f.name}` : f.name;
    if (!recurse) { console.log(`Skipping dir: ${full} (use -r to recurse)`); continue; }
    console.log(`Getting dir: ${full}`);
    if (!force && fs.existsSync(f.name)) {
      console.log(`Directory already exists: ${f.name} (use -f to overwrite)`);
    } else {
      if (!fs.existsSync(f.name)) fs.mkdirSync(f.name);
      const orig = process.cwd();
      process.chdir(f.name);
      await getMultiple(pipe, server, handles, full, '*', recurse, force);
      process.chdir(orig);
    }
  }
}

async function getSingleWithRetry(
  pipe:       EconetPipe,
  server:     EconetAddress,
  handles:    DirectoryHandles,
  remotePath: string,
  force:      boolean,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const label = attempt === 0 ? '' : ` (retry ${attempt})`;
    console.log(`Getting: ${remotePath}${label}`);
    try {
      const result = await load(pipe, server, remotePath, handles);
      const localName = splitPath(result.actualFilename).base ?? result.actualFilename;

      if (!force && fs.existsSync(localName)) {
        console.log(`Skipping existing file: ${localName} (use -f to overwrite)`);
        return;
      }
      fs.writeFileSync(localName, result.data);
      saveInf(localName, {
        originalFilename: localName,
        loadAddr:         result.loadAddr,
        execAddr:         result.execAddr,
      });
      console.log(`Saved: ${localName} (${result.size} bytes)`);
      return;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      if (attempt === MAX_RETRIES) console.error(`Giving up on: ${remotePath}`);
    }
  }
}

// ── PUT implementation ────────────────────────────────────────────────────────

async function commandPut(
  pipe:      EconetPipe,
  server:    EconetAddress,
  handles:   DirectoryHandles,
  localPath: string,
  recurse:   boolean,
  force:     boolean,
): Promise<void> {
  const parsed = path.parse(path.normalize(localPath));

  if (isWildcard(parsed.name)) {
    await putMultiple(pipe, server, handles, parsed.dir || '.', parsed.name, '', recurse, force);
    return;
  }

  if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localPath}`);

  if (fs.lstatSync(localPath).isFile()) {
    await putSingleWithRetry(pipe, server, handles, localPath, '', force);
  } else if (fs.lstatSync(localPath).isDirectory()) {
    if (!recurse) throw new Error(`'${localPath}' is a directory — use -r to recurse`);
    if (!isValidName(parsed.base)) throw new Error(`'${parsed.base}' is not a valid Econet filename`);

    const info = await readObjectAccess(pipe, server, parsed.base, handles);
    if (!info.fileExists) {
      await cdir(pipe, server, parsed.base, handles);
    }
    await putMultiple(pipe, server, handles, localPath, '*', parsed.base, recurse, force);
  } else {
    throw new Error(`Not a file or directory: ${localPath}`);
  }
}

async function putMultiple(
  pipe:       EconetPipe,
  server:     EconetAddress,
  handles:    DirectoryHandles,
  localDir:   string,
  pattern:    string,
  remotePath: string,
  recurse:    boolean,
  force:      boolean,
): Promise<void> {
  const entries = fs.readdirSync(localDir, { withFileTypes: true });

  for (const entry of entries.filter(e => e.isFile() && wildcardMatch(e.name, pattern))) {
    if (path.extname(entry.name).toLowerCase() === '.inf') continue;
    await putSingleWithRetry(pipe, server, handles, path.join(localDir, entry.name), remotePath, force);
  }

  for (const entry of entries.filter(e => e.isDirectory() && wildcardMatch(e.name, pattern))) {
    if (!recurse) { console.log(`Skipping dir: ${entry.name} (use -r to recurse)`); continue; }
    if (!isValidName(entry.name)) { console.log(`Skipping: '${entry.name}' is not a valid Econet name`); continue; }

    const remoteSubPath = remotePath ? `${remotePath}.${entry.name}` : entry.name;
    const info = await readObjectAccess(pipe, server, remoteSubPath, handles);
    if (!info.fileExists) {
      await cdir(pipe, server, remoteSubPath, handles);
    }
    await putMultiple(pipe, server, handles, path.join(localDir, entry.name), '*', remoteSubPath, recurse, force);
  }
}

async function putSingleWithRetry(
  pipe:       EconetPipe,
  server:     EconetAddress,
  handles:    DirectoryHandles,
  localPath:  string,
  remotePath: string,
  force:      boolean,
): Promise<void> {
  const base = path.basename(localPath);
  if (!isValidName(base) && !isLoadExecName(base)) {
    console.log(`Skipping: '${base}' is not a valid Econet filename`);
    return;
  }

  const meta        = inferMeta(localPath);
  const remoteBase  = meta?.originalFilename ?? base;
  const remoteFull  = remotePath ? `${remotePath}.${remoteBase}` : remoteBase;

  if (!force) {
    const info = await readObjectAccess(pipe, server, remoteFull, handles);
    if (info.fileExists) {
      console.log(`Skipping existing: ${remoteFull} (use -f to overwrite)`);
      return;
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const label = attempt === 0 ? '' : ` (retry ${attempt})`;
    console.log(`Putting: ${localPath} → ${remoteFull}${label}`);
    try {
      const fileData = fs.readFileSync(localPath);
      await save(
        pipe, server,
        fileData,
        remoteFull,
        meta?.loadAddr ?? 0xffffffff,
        meta?.execAddr ?? 0xffffffff,
        handles,
      );
      console.log(`Saved: ${remoteFull} (${fileData.length} bytes)`);
      return;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      if (attempt === MAX_RETRIES) console.error(`Giving up on: ${localPath}`);
    }
  }
}

/** Read metadata from a .inf sidecar or extract load/exec from the filename. */
function inferMeta(localPath: string): InfMetadata | undefined {
  const base = path.basename(localPath);
  if (isLoadExecName(base)) {
    const parts = base.split(',');
    return {
      originalFilename: parts[0]!,
      loadAddr:         parseInt(parts[1]!, 16),
      execAddr:         parseInt(parts[2]!, 16),
    };
  }
  return loadInf(localPath);
}

// ── DELETE implementation ─────────────────────────────────────────────────────

async function commandDelete(
  pipe:       EconetPipe,
  server:     EconetAddress,
  handles:    DirectoryHandles,
  remotePath: string,
  recurse:    boolean,
  force:      boolean,
): Promise<void> {
  const parsed = splitPath(remotePath);
  if (!parsed.base || isWildcard(parsed.base)) {
    await deleteMultiple(pipe, server, handles, parsed.dir ?? '', parsed.base ?? '*', recurse, force);
    return;
  }

  const info = await readObjectAccess(pipe, server, remotePath, handles);
  if (!info.fileExists) throw new Error(`Not found: ${remotePath}`);

  if (info.isDir && !recurse) {
    throw new Error(`'${remotePath}' is a directory — use -r to recurse`);
  }

  if (info.isDir) {
    await deleteMultiple(pipe, server, handles, remotePath, '*', recurse, force);
  }
  console.log(`Deleting: ${remotePath}`);
  await deleteObject(pipe, server, remotePath, handles);
}

async function deleteMultiple(
  pipe:    EconetPipe,
  server:  EconetAddress,
  handles: DirectoryHandles,
  dirPath: string,
  pattern: string,
  recurse: boolean,
  force:   boolean,
): Promise<void> {
  const all   = await examineDir(pipe, server, dirPath, handles);
  const match = all.filter(f => wildcardMatch(f.name, pattern));

  for (const f of match.filter(f => !f.access.includes('D'))) {
    const full = dirPath ? `${dirPath}.${f.name}` : f.name;
    console.log(`Deleting: ${full}`);
    await deleteObject(pipe, server, full, handles);
  }

  for (const f of match.filter(f => f.access.includes('D'))) {
    const full = dirPath ? `${dirPath}.${f.name}` : f.name;
    if (!recurse) { console.log(`Skipping dir: ${full} (use -r to recurse)`); continue; }
    await deleteMultiple(pipe, server, handles, full, '*', recurse, force);
    console.log(`Deleting dir: ${full}`);
    await deleteObject(pipe, server, full, handles);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Split an Econet path like "$.foo.bar" into dir="$.foo" base="bar". */
function splitPath(p: string): { dir: string | undefined; base: string | undefined } {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return { dir: undefined, base: p };
  return { dir: p.slice(0, dot) || undefined, base: p.slice(dot + 1) };
}
