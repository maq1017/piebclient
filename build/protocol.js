"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACK_PORT = exports.DATA_PORT = exports.REPLY_PORT = exports.FS_CTRL = exports.FS_PORT = void 0;
exports.executeCliCommand = executeCliCommand;
exports.iAm = iAm;
exports.bye = bye;
exports.dir = dir;
exports.cdir = cdir;
exports.access = access;
exports.deleteObject = deleteObject;
exports.examineDir = examineDir;
exports.readDirInfo = readDirInfo;
exports.readObjectAccess = readObjectAccess;
exports.load = load;
exports.save = save;
exports.fslist = fslist;
exports.notify = notify;
exports.saveInf = saveInf;
exports.loadInf = loadInf;
const fs = __importStar(require("fs"));
const pipe_1 = require("./pipe");
// ── Constants ────────────────────────────────────────────────────────────────
exports.FS_PORT = 0x99;
exports.FS_CTRL = 0x80;
exports.REPLY_PORT = 0x90;
exports.DATA_PORT = 0x92; // used for LOAD data
exports.ACK_PORT = 0x91; // used for SAVE ack
const TIMEOUT_MS = 20000;
const FSLIST_TIMEOUT_MS = 5000;
// ── Low-level helpers ─────────────────────────────────────────────────────────
/** Build the standard 5-byte FS request header + payload. */
function makeFsPayload(functionCode, handles, payload) {
    return Buffer.concat([
        Buffer.from([exports.REPLY_PORT, functionCode, handles.userRoot, handles.current, handles.library]),
        payload,
    ]);
}
/** Send a DATA packet to the file server. */
function sendToFs(pipe, server, data) {
    pipe.send({
        dststn: server.station,
        dstnet: server.network,
        srcstn: 0, srcnet: 0,
        aun_ttype: pipe_1.ECONET_AUN_DATA,
        port: exports.FS_PORT,
        ctrl: exports.FS_CTRL,
        data,
    });
}
/** Filter for a reply from the FS on a specific port. */
function fromFs(server, port) {
    return (p) => p.srcstn === server.station &&
        p.srcnet === server.network &&
        p.port === port;
}
/** Filter for a reply from the FS on either of two ports. */
function fromFsEitherPort(server, portA, portB) {
    return (p) => p.srcstn === server.station &&
        p.srcnet === server.network &&
        (p.port === portA || p.port === portB);
}
/** Parse the common [cmdCode, resultCode, data] reply envelope. */
function parseReply(pkt) {
    if (pkt.data.length < 2)
        throw new Error('Malformed server response');
    return { resultCode: pkt.data[1], data: pkt.data.subarray(2) };
}
/** Throw if resultCode != 0. */
function checkOk(resultCode, data) {
    if (resultCode !== 0x00) {
        const msg = stripCr(data.toString('ascii'));
        throw new Error(msg || `Server error 0x${resultCode.toString(16)}`);
    }
}
function stripCr(s) {
    return s.replace(/[\r\n\0]/g, '').trim();
}
// ── Protocol functions ────────────────────────────────────────────────────────
/**
 * Send a CLI command (I AM, BYE, DIR, CDIR, ACCESS, DELETE, PASS, PRIV).
 * Returns the raw response data after the result code.
 */
async function executeCliCommand(pipe, server, command, handles) {
    const payload = makeFsPayload(0x00, handles, Buffer.from(`${command}\r`));
    sendToFs(pipe, server, payload);
    const pkt = await pipe.waitForPacket(fromFs(server, exports.REPLY_PORT), TIMEOUT_MS);
    const resp = parseReply(pkt);
    checkOk(resp.resultCode, resp.data);
    return resp.data;
}
/** *I AM — login.  Returns updated directory handles. */
async function iAm(pipe, server, username, password) {
    const cmd = password ? `I AM ${username} ${password}` : `I AM ${username}`;
    const data = await executeCliCommand(pipe, server, cmd, { userRoot: 0, current: 0, library: 0 });
    if (data.length < 4)
        throw new Error('Malformed login response');
    return {
        current: data[0],
        userRoot: data[1],
        library: data[2],
    };
}
/** *BYE — logout. */
async function bye(pipe, server, handles) {
    await executeCliCommand(pipe, server, 'BYE', handles);
}
/** *DIR — change current directory.  Returns the new current-dir handle. */
async function dir(pipe, server, dirPath, handles) {
    const data = await executeCliCommand(pipe, server, `DIR ${dirPath}`, handles);
    if (data.length < 1)
        throw new Error('Malformed DIR response');
    return data[0];
}
/** *CDIR — create a directory. */
async function cdir(pipe, server, dirName, handles) {
    await executeCliCommand(pipe, server, `CDIR ${dirName}`, handles);
}
/** *ACCESS — set file/dir access permissions. */
async function access(pipe, server, filePath, accessString, handles) {
    await executeCliCommand(pipe, server, `ACCESS ${filePath} ${accessString}`, handles);
}
/** *DELETE — delete a file or directory. */
async function deleteObject(pipe, server, filePath, handles) {
    await executeCliCommand(pipe, server, `DELETE ${filePath}`, handles);
}
// ── Examine (CAT) ─────────────────────────────────────────────────────────────
/** Read directory listing (FS function 0x03, ARG 0x01 = all info human-readable). */
async function examineDir(pipe, server, dirPath, handles) {
    const results = [];
    let startIndex = 0;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const header = Buffer.from([0x01, startIndex, 0x0b]); // ARG=1, start, 11 entries
        const payload = makeFsPayload(0x03, handles, Buffer.concat([header, Buffer.from(`${dirPath}\r`)]));
        sendToFs(pipe, server, payload);
        const pkt = await pipe.waitForPacket(fromFs(server, exports.REPLY_PORT), TIMEOUT_MS);
        const resp = parseReply(pkt);
        checkOk(resp.resultCode, resp.data);
        if (resp.data.length < 2)
            throw new Error('Malformed examine response');
        const numEntries = resp.data[0];
        if (numEntries === 0)
            break;
        const fileData = resp.data.subarray(2).toString('ascii');
        const entries = fileData
            .split('\0')
            .filter(f => f.length > 0 && !(f.length === 1 && f.charCodeAt(0) === 0x80))
            .map(f => {
            var _a, _b, _c, _d, _e, _f, _g;
            const parts = f.split(/\s+/);
            return {
                name: (_a = parts[0]) !== null && _a !== void 0 ? _a : '',
                loadAddress: (_b = parts[1]) !== null && _b !== void 0 ? _b : '',
                execAddress: (_c = parts[2]) !== null && _c !== void 0 ? _c : '',
                sizeBytes: parseInt((_d = parts[3]) !== null && _d !== void 0 ? _d : '0', 16),
                access: (_e = parts[4]) !== null && _e !== void 0 ? _e : '',
                date: (_f = parts[5]) !== null && _f !== void 0 ? _f : '',
                id: (_g = parts[6]) !== null && _g !== void 0 ? _g : '',
            };
        });
        results.push(...entries);
        startIndex += numEntries;
    }
    return results;
}
/** Read directory header info (FS objectInfo function 0x12, ARG 0x06). */
async function readDirInfo(pipe, server, dirPath, handles) {
    const payload = makeFsPayload(0x12, handles, Buffer.concat([Buffer.from([0x06]), Buffer.from(`${dirPath}\r`)]));
    sendToFs(pipe, server, payload);
    const pkt = await pipe.waitForPacket(fromFs(server, exports.REPLY_PORT), TIMEOUT_MS);
    const resp = parseReply(pkt);
    checkOk(resp.resultCode, resp.data);
    if (resp.data.length < 15)
        throw new Error('Malformed dir-info response');
    return {
        dirName: resp.data.subarray(3, 13).toString('ascii').replace(/\0/g, '').trim(),
        isOwner: resp.data[13] === 0,
        cycleNum: resp.data[14],
    };
}
/** Read object access byte (FS objectInfo function 0x12, ARG 0x04). */
async function readObjectAccess(pipe, server, objPath, handles) {
    const payload = makeFsPayload(0x12, handles, Buffer.concat([Buffer.from([0x04]), Buffer.from(`${objPath}\r`)]));
    sendToFs(pipe, server, payload);
    const pkt = await pipe.waitForPacket(fromFs(server, exports.REPLY_PORT), TIMEOUT_MS);
    const resp = parseReply(pkt);
    checkOk(resp.resultCode, resp.data);
    if (resp.data.length === 0 || resp.data[0] === 0) {
        return { fileExists: false, access: null, isDir: false };
    }
    if (resp.data.length < 2)
        throw new Error('Malformed object-info response');
    const ab = resp.data[1];
    const isDir = (ab & 0x20) !== 0;
    return { fileExists: true, access: accessByteToString(ab), isDir };
}
function accessByteToString(b) {
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
/**
 * FS function 0x02: LOAD a file.
 * The server sends:
 *   1. A metadata reply on REPLY_PORT (0x90)
 *   2. One or more data blocks on DATA_PORT (0x92)
 *   3. A final status reply on REPLY_PORT (0x90)
 */
async function load(pipe, server, filename, handles) {
    // For LOAD the handle-byte-2 slot carries the data port, not userRoot
    const txData = Buffer.concat([
        Buffer.from([exports.REPLY_PORT, 0x02, exports.DATA_PORT, handles.current, handles.library]),
        Buffer.from(`${filename}\r`),
    ]);
    sendToFs(pipe, server, txData);
    // First packet: metadata on REPLY_PORT
    const metaPkt = await pipe.waitForPacket(fromFsEitherPort(server, exports.REPLY_PORT, exports.DATA_PORT), TIMEOUT_MS);
    const metaResp = parseReply(metaPkt);
    checkOk(metaResp.resultCode, metaResp.data);
    const d = metaResp.data;
    if (d.length < 14)
        throw new Error('Malformed LOAD metadata response');
    const loadAddr = d.readUInt32LE(0);
    const execAddr = d.readUInt32LE(4);
    const size = d[8] + (d[9] << 8) + (d[10] << 16);
    const fnBytes = d.subarray(14, 26);
    const actualFilename = parseAsciiZ(fnBytes) || filename;
    // Receive data blocks until we have all the bytes, then read final status
    let fileData = Buffer.alloc(0);
    while (true) {
        const pkt = await pipe.waitForPacket(fromFsEitherPort(server, exports.REPLY_PORT, exports.DATA_PORT), TIMEOUT_MS);
        if (pkt.port === exports.DATA_PORT) {
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
function parseAsciiZ(buf) {
    let end = 0;
    while (end < buf.length) {
        const c = buf[end];
        if (c === 0 || c === 0x0d || c >= 128)
            break;
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
async function save(pipe, server, fileData, remoteName, loadAddr, execAddr, handles) {
    const bufLA = Buffer.alloc(4);
    bufLA.writeUInt32LE(loadAddr, 0);
    const bufEA = Buffer.alloc(4);
    bufEA.writeUInt32LE(execAddr, 0);
    const bufSZ = Buffer.from([
        fileData.length & 0xff,
        (fileData.length >> 8) & 0xff,
        (fileData.length >> 16) & 0xff,
    ]);
    // For SAVE the handle-byte-2 slot carries the ack port, not userRoot
    const txData = Buffer.concat([
        Buffer.from([exports.REPLY_PORT, 0x01, exports.ACK_PORT, handles.current, handles.library]),
        bufLA, bufEA, bufSZ,
        Buffer.from(`${remoteName}\r`),
    ]);
    sendToFs(pipe, server, txData);
    // Receive save setup reply: [dataPort (1), blockSize (2 LE)]
    const setupPkt = await pipe.waitForPacket(fromFs(server, exports.REPLY_PORT), TIMEOUT_MS);
    const setupResp = parseReply(setupPkt);
    checkOk(setupResp.resultCode, setupResp.data);
    if (setupResp.data.length < 3)
        throw new Error('Malformed SAVE setup response');
    const dataPort = setupResp.data[0];
    const blockSize = setupResp.data.readUInt16LE(1);
    let offset = 0;
    const fileSize = fileData.length;
    while (offset < fileSize) {
        const chunk = fileData.subarray(offset, offset + blockSize);
        offset += chunk.length;
        pipe.send({
            dststn: server.station, dstnet: server.network,
            srcstn: 0, srcnet: 0,
            aun_ttype: pipe_1.ECONET_AUN_DATA,
            port: dataPort,
            ctrl: exports.FS_CTRL,
            data: chunk,
        });
        const pct = Math.round(100 * offset / fileSize);
        process.stdout.write(`\rSaving ${offset}/${fileSize} bytes [${pct}%]`);
        // Wait for ack between blocks (not after last block)
        if (offset < fileSize) {
            await pipe.waitForPacket(fromFs(server, exports.ACK_PORT), TIMEOUT_MS);
        }
    }
    process.stdout.write('\r');
    // Final status
    const finalPkt = await pipe.waitForPacket(fromFs(server, exports.REPLY_PORT), TIMEOUT_MS);
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
async function fslist(pipe) {
    pipe.send({
        dststn: 0xff, dstnet: 0xff,
        srcstn: 0, srcnet: 0,
        aun_ttype: pipe_1.ECONET_AUN_BCAST,
        port: exports.FS_PORT,
        ctrl: exports.FS_CTRL,
        data: Buffer.from([exports.REPLY_PORT, 0x19, 0x00, 0x00, 0x00]),
    });
    const servers = [];
    const deadline = Date.now() + FSLIST_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                break;
            const pkt = await pipe.waitForPacket(p => p.port === exports.REPLY_PORT, Math.min(remaining, 500));
            const versionStr = stripCr(pkt.data.subarray(2).toString('ascii'));
            servers.push({ network: pkt.srcnet, station: pkt.srcstn, version: versionStr });
        }
        catch (_a) {
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
async function notify(pipe, dest, message) {
    for (const char of message) {
        pipe.send({
            dststn: dest.station,
            dstnet: dest.network,
            srcstn: 0, srcnet: 0,
            aun_ttype: pipe_1.ECONET_AUN_IMM,
            port: 0x00,
            ctrl: 0x85,
            data: Buffer.from([char.charCodeAt(0)]),
        });
        await (0, pipe_1.sleep)(20); // allow bridge to complete physical handshake per character
    }
}
function saveInf(localFilename, meta) {
    const line = `${meta.originalFilename.padEnd(10)} ` +
        `${meta.loadAddr.toString(16).toUpperCase().padStart(8, '0')} ` +
        `${meta.execAddr.toString(16).toUpperCase().padStart(8, '0')}\n`;
    fs.writeFileSync(`${localFilename}.inf`, line);
}
function loadInf(localFilename) {
    var _a, _b, _c, _d, _e;
    const infPath = `${localFilename}.inf`;
    if (!fs.existsSync(infPath))
        return undefined;
    const parts = (_b = (_a = fs.readFileSync(infPath, 'utf-8').split('\n')[0]) === null || _a === void 0 ? void 0 : _a.split(/\s+/)) !== null && _b !== void 0 ? _b : [];
    if (parts.length < 3)
        return undefined;
    const la = parseInt((_c = parts[1]) !== null && _c !== void 0 ? _c : '', 16);
    const ea = parseInt((_d = parts[2]) !== null && _d !== void 0 ? _d : '', 16);
    if (isNaN(la) || isNaN(ea))
        return undefined;
    return { originalFilename: (_e = parts[0]) !== null && _e !== void 0 ? _e : '', loadAddr: la, execAddr: ea };
}
//# sourceMappingURL=protocol.js.map