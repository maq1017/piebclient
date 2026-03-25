/**
 * Econet Level 3 File Server protocol over the PiEconetBridge named pipe.
 *
 * Packet format sent to FS (port 0x99, ctrl 0x80, type ECONET_AUN_DATA):
 *   [0] replyPort  (0x90)
 *   [1] functionCode
 *   [2] userRoot handle
 *   [3] current dir handle
 *   [4] library handle
 *   [5+] payload
 *
 * Replies arrive from the FS on replyPort (0x90):
 *   [0] commandCode  (always 0x00)
 *   [1] resultCode   (0x00 = success)
 *   [2+] data
 */

import * as fs from 'fs';
import * as path from 'path';
import { AUNPacket, EconetPipe, ECONET_AUN_BCAST, ECONET_AUN_DATA, ECONET_AUN_IMM, sleep } from './pipe';

// ── Constants ────────────────────────────────────────────────────────────────

export const FS_PORT    = 0x99;
export const FS_CTRL    = 0x80;
export const REPLY_PORT = 0x90;
export const DATA_PORT  = 0x92;  // used for LOAD data
export const ACK_PORT   = 0x91;  // used for SAVE ack

const TIMEOUT_MS        = 10000;
const FSLIST_TIMEOUT_MS = 5000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface EconetAddress {
  network: number;
  station: number;
}

export interface DirectoryHandles {
  userRoot: number;
  current:  number;
  library:  number;
}

export interface FileInfo {
  id:          string;
  name:        string;
  loadAddress: string;
  execAddress: string;
  sizeBytes:   number;
  date:        string;
  access:      string;
}

export interface FileServerInfo {
  network: number;
  station: number;
  version: string;
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

/** Build the standard 5-byte FS request header + payload. */
function makeFsPayload(
  functionCode: number,
  handles: DirectoryHandles,
  payload: Buffer,
): Buffer {
  return Buffer.concat([
    Buffer.from([REPLY_PORT, functionCode, handles.userRoot, handles.current, handles.library]),
    payload,
  ]);
}

/** Send a DATA packet to the file server.
 * Drains any stale REPLY_PORT packets from previous commands before sending,
 * so a timed-out command's late-arriving reply can't be consumed by the next
 * command. */
function sendToFs(
  pipe: EconetPipe,
  server: EconetAddress,
  data: Buffer,
): void {
  const isStaleReply = fromFs(server, REPLY_PORT);
  while (pipe.shiftPacket(isStaleReply)) { /* discard */ }
  pipe.send({
    dststn:    server.station,
    dstnet:    server.network,
    srcstn:    0, srcnet: 0,
    aun_ttype: ECONET_AUN_DATA,
    port:      FS_PORT,
    ctrl:      FS_CTRL,
    data,
  });
}

/** Filter for a reply from the FS on a specific port.
 * Accepts srcnet=0 (local network) as equivalent to the server's specified
 * network, because BBC file servers often reply from network 0 regardless of
 * how they were addressed. */
function fromFs(server: EconetAddress, port: number) {
  return (p: AUNPacket) =>
    p.srcstn === server.station &&
    (p.srcnet === server.network || (server.network !== 0 && p.srcnet === 0)) &&
    p.port   === port;
}

/** Filter for a reply from the FS on either of two ports. */
function fromFsEitherPort(server: EconetAddress, portA: number, portB: number) {
  return (p: AUNPacket) =>
    p.srcstn === server.station &&
    p.srcnet === server.network &&
    (p.port === portA || p.port === portB);
}

/** Parse the common [cmdCode, resultCode, data] reply envelope. */
function parseReply(pkt: AUNPacket): { resultCode: number; data: Buffer } {
  if (pkt.data.length < 2) throw new Error('Malformed server response');
  return { resultCode: pkt.data[1]!, data: pkt.data.subarray(2) };
}

/** Throw if resultCode != 0. */
function checkOk(resultCode: number, data: Buffer): void {
  if (resultCode !== 0x00) {
    const msg = stripCr(data.toString('ascii'));
    throw new Error(msg || `Server error 0x${resultCode.toString(16)}`);
  }
}

function stripCr(s: string): string {
  return s.replace(/[\r\n\0]/g, '').trim();
}

// ── Protocol functions ────────────────────────────────────────────────────────

/**
 * Send a CLI command (I AM, BYE, DIR, CDIR, ACCESS, DELETE, PASS, PRIV).
 * Returns the raw response data after the result code.
 */
export async function executeCliCommand(
  pipe:    EconetPipe,
  server:  EconetAddress,
  command: string,
  handles: DirectoryHandles,
): Promise<Buffer> {
  const payload = makeFsPayload(0x00, handles, Buffer.from(`${command}\r`));
  sendToFs(pipe, server, payload);

  const pkt  = await pipe.waitForPacket(fromFs(server, REPLY_PORT), TIMEOUT_MS);
  const resp = parseReply(pkt);
  checkOk(resp.resultCode, resp.data);
  return resp.data;
}

/** *I AM — login.  Returns updated directory handles. */
export async function iAm(
  pipe:     EconetPipe,
  server:   EconetAddress,
  username: string,
  password: string,
): Promise<DirectoryHandles> {
  const cmd  = password ? `I AM ${username} ${password}` : `I AM ${username}`;
  const data = await executeCliCommand(pipe, server, cmd, { userRoot: 0, current: 0, library: 0 });

  if (data.length < 4) throw new Error('Malformed login response');
  return {
    current:  data[0]!,
    userRoot: data[1]!,
    library:  data[2]!,
  };
}

/** *BYE — logout. */
export async function bye(
  pipe:    EconetPipe,
  server:  EconetAddress,
  handles: DirectoryHandles,
): Promise<void> {
  await executeCliCommand(pipe, server, 'BYE', handles);
}

/** *DIR — change current directory.  Returns the new current-dir handle. */
export async function dir(
  pipe:    EconetPipe,
  server:  EconetAddress,
  dirPath: string,
  handles: DirectoryHandles,
): Promise<number> {
  const data = await executeCliCommand(pipe, server, `DIR ${dirPath}`, handles);
  if (data.length < 1) throw new Error('Malformed DIR response');
  return data[0]!;
}

/** *CDIR — create a directory. */
export async function cdir(
  pipe:    EconetPipe,
  server:  EconetAddress,
  dirName: string,
  handles: DirectoryHandles,
): Promise<void> {
  await executeCliCommand(pipe, server, `CDIR ${dirName}`, handles);
}

/** *ACCESS — set file/dir access permissions. */
export async function access(
  pipe:         EconetPipe,
  server:       EconetAddress,
  filePath:     string,
  accessString: string,
  handles:      DirectoryHandles,
): Promise<void> {
  await executeCliCommand(pipe, server, `ACCESS ${filePath} ${accessString}`, handles);
}

/** *DELETE — delete a file or directory. */
export async function deleteObject(
  pipe:     EconetPipe,
  server:   EconetAddress,
  filePath: string,
  handles:  DirectoryHandles,
): Promise<void> {
  await executeCliCommand(pipe, server, `DELETE ${filePath}`, handles);
}

// ── Examine (CAT) ─────────────────────────────────────────────────────────────

/** Read directory listing (FS function 0x03, ARG 0x01 = all info human-readable). */
export async function examineDir(
  pipe:    EconetPipe,
  server:  EconetAddress,
  dirPath: string,
  handles: DirectoryHandles,
): Promise<FileInfo[]> {
  const results: FileInfo[] = [];
  let startIndex = 0;
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    const header  = Buffer.from([0x01, startIndex, 0x0b]); // ARG=1, start, 11 entries
    const payload = makeFsPayload(0x03, handles, Buffer.concat([header, Buffer.from(`${dirPath}\r`)]));
    sendToFs(pipe, server, payload);

    const pkt  = await pipe.waitForPacket(fromFs(server, REPLY_PORT), TIMEOUT_MS);
    const resp = parseReply(pkt);
    checkOk(resp.resultCode, resp.data);

    if (resp.data.length < 2) throw new Error('Malformed examine response');
    const numEntries = resp.data[0]!;
    if (numEntries === 0) break;

    const fileData = resp.data.subarray(2).toString('ascii');
    const entries  = fileData
      .split('\0')
      .filter(f => f.length > 0 && !(f.length === 1 && f.charCodeAt(0) === 0x80))
      .map(f => {
        const parts = f.split(/\s+/);
        return {
          name:        parts[0] ?? '',
          loadAddress: parts[1] ?? '',
          execAddress: parts[2] ?? '',
          sizeBytes:   parseInt(parts[3] ?? '0', 16),
          access:      parts[4] ?? '',
          date:        parts[5] ?? '',
          id:          parts[6] ?? '',
        };
      });

    results.push(...entries);
    startIndex += numEntries;
  }

  return results;
}

/** Read directory header info (FS objectInfo function 0x12, ARG 0x06). */
export async function readDirInfo(
  pipe:    EconetPipe,
  server:  EconetAddress,
  dirPath: string,
  handles: DirectoryHandles,
): Promise<{ dirName: string; isOwner: boolean; cycleNum: number }> {
  const payload = makeFsPayload(
    0x12, handles,
    Buffer.concat([Buffer.from([0x06]), Buffer.from(`${dirPath}\r`)]),
  );
  sendToFs(pipe, server, payload);

  const pkt  = await pipe.waitForPacket(fromFs(server, REPLY_PORT), TIMEOUT_MS);
  const resp = parseReply(pkt);
  checkOk(resp.resultCode, resp.data);

  if (resp.data.length < 15) throw new Error('Malformed dir-info response');
  return {
    dirName:  resp.data.subarray(3, 13).toString('ascii').replace(/\0/g, '').trim(),
    isOwner:  resp.data[13] === 0,
    cycleNum: resp.data[14]!,
  };
}

/** Read object access byte (FS objectInfo function 0x12, ARG 0x04). */
export async function readObjectAccess(
  pipe:     EconetPipe,
  server:   EconetAddress,
  objPath:  string,
  handles:  DirectoryHandles,
): Promise<{ fileExists: boolean; access: string | null; isDir: boolean }> {
  const payload = makeFsPayload(
    0x12, handles,
    Buffer.concat([Buffer.from([0x04]), Buffer.from(`${objPath}\r`)]),
  );
  sendToFs(pipe, server, payload);

  const pkt  = await pipe.waitForPacket(fromFs(server, REPLY_PORT), TIMEOUT_MS);
  const resp = parseReply(pkt);
  checkOk(resp.resultCode, resp.data);

  if (resp.data.length === 0 || resp.data[0] === 0) {
    return { fileExists: false, access: null, isDir: false };
  }
  if (resp.data.length < 2) throw new Error('Malformed object-info response');
  const ab    = resp.data[1]!;
  const isDir = (ab & 0x20) !== 0;
  return { fileExists: true, access: accessByteToString(ab), isDir };
}

function accessByteToString(b: number): string {
  return [
    (b & 0x20) ? 'D' : '',
    (b & 0x10) ? 'L' : '',
    (b & 0x08) ? 'W' : '',
    (b & 0x04) ? 'R' : '',
    '/',
    (b & 0x02) ? 'W' : '',
    (b & 0x01) ? 'R' : '',
  ].join('');
}

// ── LOAD (get) ────────────────────────────────────────────────────────────────

export interface LoadResult {
  loadAddr:       number;
  execAddr:       number;
  size:           number;
  actualFilename: string;
  data:           Buffer;
}

/**
 * FS function 0x02: LOAD a file.
 * The server sends:
 *   1. A metadata reply on REPLY_PORT (0x90)
 *   2. One or more data blocks on DATA_PORT (0x92)
 *   3. A final status reply on REPLY_PORT (0x90)
 */
export async function load(
  pipe:     EconetPipe,
  server:   EconetAddress,
  filename: string,
  handles:  DirectoryHandles,
): Promise<LoadResult> {
  // For LOAD the handle-byte-2 slot carries the data port, not userRoot
  const txData = Buffer.concat([
    Buffer.from([REPLY_PORT, 0x02, DATA_PORT, handles.current, handles.library]),
    Buffer.from(`${filename}\r`),
  ]);
  sendToFs(pipe, server, txData);

  // First packet: metadata on REPLY_PORT
  const metaPkt  = await pipe.waitForPacket(fromFsEitherPort(server, REPLY_PORT, DATA_PORT), TIMEOUT_MS);
  // ACK the metadata — this triggers the FS to dequeue and send the first data block
  pipe.sendAck(server.station, server.network, metaPkt.port, metaPkt.ctrl, metaPkt.seq);
  const metaResp = parseReply(metaPkt);
  checkOk(metaResp.resultCode, metaResp.data);

  const d = metaResp.data;
  if (d.length < 14) throw new Error('Malformed LOAD metadata response');

  const loadAddr = d.readUInt32LE(0);
  const execAddr = d.readUInt32LE(4);
  const size     = d[8]! + (d[9]! << 8) + (d[10]! << 16);
  const fnBytes  = d.subarray(14, 26);
  const actualFilename = parseAsciiZ(fnBytes) || filename;

  // Receive data blocks until we have all the bytes, then read final status.
  // After each packet, send an ACK to trigger the FS to dequeue the next block.
  let fileData = Buffer.alloc(0);
  while (true) {
    const pkt = await pipe.waitForPacket(
      fromFsEitherPort(server, REPLY_PORT, DATA_PORT),
      TIMEOUT_MS,
    );
    // ACK every packet to keep the FS load queue moving
    pipe.sendAck(server.station, server.network, pkt.port, pkt.ctrl, pkt.seq);

    if (pkt.port === DATA_PORT) {
      fileData = Buffer.concat([fileData, pkt.data]);
      const pct = size > 0 ? Math.round(100 * fileData.length / size) : 100;
      process.stdout.write(`\rLoading ${fileData.length}/${size} bytes [${pct}%]`);
      continue;
    }

    // REPLY_PORT — final status
    process.stdout.write('\r');
    const finalResp = parseReply(pkt);
    checkOk(finalResp.resultCode, finalResp.data);

    if (fileData.length !== size) {
      throw new Error(`Size mismatch: expected ${size} bytes, received ${fileData.length}`);
    }
    break;
  }

  return { loadAddr, execAddr, size, actualFilename, data: fileData };
}

function parseAsciiZ(buf: Buffer): string {
  let end = 0;
  while (end < buf.length) {
    const c = buf[end]!;
    if (c === 0 || c === 0x0d || c >= 128) break;
    end++;
  }
  return buf.subarray(0, end).toString('ascii').trim();
}

// ── SAVE (put) ────────────────────────────────────────────────────────────────

/**
 * FS function 0x01: SAVE a file.
 * Sequence:
 *   1. Send save request → server replies with data port + block size
 *   2. Stream file data in blocks to data port; wait for ack between blocks
 *   3. Server sends final status on REPLY_PORT
 */
export async function save(
  pipe:       EconetPipe,
  server:     EconetAddress,
  fileData:   Buffer,
  remoteName: string,
  loadAddr:   number,
  execAddr:   number,
  handles:    DirectoryHandles,
): Promise<void> {
  const bufLA = Buffer.alloc(4); bufLA.writeUInt32LE(loadAddr, 0);
  const bufEA = Buffer.alloc(4); bufEA.writeUInt32LE(execAddr, 0);
  const bufSZ = Buffer.from([
    fileData.length & 0xff,
    (fileData.length >> 8) & 0xff,
    (fileData.length >> 16) & 0xff,
  ]);

  // For SAVE the handle-byte-2 slot carries the ack port, not userRoot
  const txData = Buffer.concat([
    Buffer.from([REPLY_PORT, 0x01, ACK_PORT, handles.current, handles.library]),
    bufLA, bufEA, bufSZ,
    Buffer.from(`${remoteName}\r`),
  ]);
  sendToFs(pipe, server, txData);

  // Receive save setup reply: [dataPort (1), blockSize (2 LE)]
  const setupPkt  = await pipe.waitForPacket(fromFs(server, REPLY_PORT), TIMEOUT_MS);
  const setupResp = parseReply(setupPkt);
  checkOk(setupResp.resultCode, setupResp.data);

  if (setupResp.data.length < 3) throw new Error('Malformed SAVE setup response');
  const dataPort  = setupResp.data[0]!;
  const blockSize = setupResp.data.readUInt16LE(1);

  let offset     = 0;
  const fileSize = fileData.length;

  while (offset < fileSize) {
    const chunk = fileData.subarray(offset, offset + blockSize);
    offset += chunk.length;

    pipe.send({
      dststn:    server.station, dstnet: server.network,
      srcstn:    0, srcnet: 0,
      aun_ttype: ECONET_AUN_DATA,
      port:      dataPort,
      ctrl:      FS_CTRL,
      data:      chunk,
    });

    const pct = Math.round(100 * offset / fileSize);
    process.stdout.write(`\rSaving ${offset}/${fileSize} bytes [${pct}%]`);

    // Wait for ack between blocks (not after last block)
    if (offset < fileSize) {
      await pipe.waitForPacket(fromFs(server, ACK_PORT), TIMEOUT_MS);
    }
  }
  process.stdout.write('\r');

  // Final status
  const finalPkt  = await pipe.waitForPacket(fromFs(server, REPLY_PORT), TIMEOUT_MS);
  const finalResp = parseReply(finalPkt);
  checkOk(finalResp.resultCode, finalResp.data);
}

// ── FSLIST ────────────────────────────────────────────────────────────────────

/**
 * Broadcast FS version query (function 0x19) and collect replies for 5 seconds.
 *
 * Broadcast packet (from econet-fslist.c):
 *   dststn=0xff dstnet=0xff  port=0x99  ctrl=0x80
 *   data = [0x90, 0x19, 0x00, 0x00, 0x00]
 *          (replyPort=0x90, funcCode=0x19, handles 0/0/0)
 */
export async function fslist(pipe: EconetPipe): Promise<FileServerInfo[]> {
  pipe.send({
    dststn:    0xff, dstnet: 0xff,
    srcstn:    0,    srcnet: 0,
    aun_ttype: ECONET_AUN_BCAST,
    port:      FS_PORT,
    ctrl:      FS_CTRL,
    data:      Buffer.from([REPLY_PORT, 0x19, 0x00, 0x00, 0x00]),
  });

  const servers: FileServerInfo[] = [];
  const deadline = Date.now() + FSLIST_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const pkt = await pipe.waitForPacket(
        p => p.port === REPLY_PORT,
        Math.min(remaining, 500),
      );
      const versionStr = stripCr(pkt.data.subarray(2).toString('ascii'));
      servers.push({ network: pkt.srcnet, station: pkt.srcstn, version: versionStr });
    } catch {
      // timeout on this 500ms slice — keep looping until overall deadline
    }
  }

  return servers;
}

// ── NOTIFY (talk) ─────────────────────────────────────────────────────────────

/**
 * Send a *NOTIFY-style message to a station by sending each character as an
 * AUN immediate operation (ctrl=0x85, port=0x00).
 * The bridge translates each IMM packet into a physical Econet immediate frame.
 */
export async function notify(
  pipe:    EconetPipe,
  dest:    EconetAddress,
  message: string,
): Promise<void> {
  for (const char of message) {
    pipe.send({
      dststn:    dest.station,
      dstnet:    dest.network,
      srcstn:    0, srcnet: 0,
      aun_ttype: ECONET_AUN_IMM,
      port:      0x00,
      ctrl:      0x85,
      data:      Buffer.from([char.charCodeAt(0)]),
    });
    await sleep(20); // allow bridge to complete physical handshake per character
  }
}

// ── Metadata (.inf files) ─────────────────────────────────────────────────────

export interface InfMetadata {
  originalFilename: string;
  loadAddr:         number;
  execAddr:         number;
}

export function saveInf(localFilename: string, meta: InfMetadata): void {
  const line =
    `${meta.originalFilename.padEnd(10)} ` +
    `${meta.loadAddr.toString(16).toUpperCase().padStart(8, '0')} ` +
    `${meta.execAddr.toString(16).toUpperCase().padStart(8, '0')}\n`;
  fs.writeFileSync(`${localFilename}.inf`, line);
}

export function loadInf(localFilename: string): InfMetadata | undefined {
  const infPath = `${localFilename}.inf`;
  if (!fs.existsSync(infPath)) return undefined;
  const parts = fs.readFileSync(infPath, 'utf-8').split('\n')[0]?.split(/\s+/) ?? [];
  if (parts.length < 3) return undefined;
  const la = parseInt(parts[1] ?? '', 16);
  const ea = parseInt(parts[2] ?? '', 16);
  if (isNaN(la) || isNaN(ea)) return undefined;
  return { originalFilename: parts[0] ?? '', loadAddr: la, execAddr: ea };
}
