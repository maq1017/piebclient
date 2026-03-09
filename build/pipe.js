"use strict";
/**
 * Low-level named pipe transport for PiEconetBridge.
 *
 * Mirrors the behaviour of econet-pipe.c / econet-gpio-consumer.h:
 *   pipebase.tobridge   — we write to this
 *   pipebase.frombridge — we read from this
 *
 * Pipe packet format:
 *   [len_lo, len_hi, ...AUN packet (len bytes)]
 *
 * AUN packet layout (all offsets within the AUN bytes, not the pipe frame):
 *   [0]  dststn
 *   [1]  dstnet
 *   [2]  srcstn
 *   [3]  srcnet
 *   [4]  aun_ttype
 *   [5]  port
 *   [6]  ctrl
 *   [7]  padding
 *   [8-11] seq (uint32 LE)
 *   [12+]  data
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
exports.sleep = exports.EconetPipe = exports.ECONET_AUN_IMMREP = exports.ECONET_AUN_IMM = exports.ECONET_AUN_NAK = exports.ECONET_AUN_ACK = exports.ECONET_AUN_DATA = exports.ECONET_AUN_BCAST = void 0;
exports.formatDebugPacket = formatDebugPacket;
const fs = __importStar(require("fs"));
exports.ECONET_AUN_BCAST = 0x01;
exports.ECONET_AUN_DATA = 0x02;
exports.ECONET_AUN_ACK = 0x03;
exports.ECONET_AUN_NAK = 0x04;
exports.ECONET_AUN_IMM = 0x05;
exports.ECONET_AUN_IMMREP = 0x06;
class EconetPipe {
    constructor() {
        this.readFd = -1;
        this.writeFd = -1;
        this.seq = 0x4000;
        this.recvBuf = Buffer.alloc(0);
        this.pktQueue = [];
        this.running = false;
    }
    // ── Connection ────────────────────────────────────────────────────────────
    async connect(pipeBase) {
        const fromPath = `${pipeBase}.frombridge`;
        const toPath = `${pipeBase}.tobridge`;
        // Open read end non-blocking (succeeds even if bridge write end not yet open)
        this.readFd = fs.openSync(fromPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        // Open write end (bridge must already have its read end open)
        this.writeFd = fs.openSync(toPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        this.running = true;
        this.scheduleReadPoll();
        // Send a bridge broadcast to wake the bridge so it opens its write end
        this.sendBridgeWake();
        // Give the bridge a moment to open the write side and respond
        await (0, exports.sleep)(200);
    }
    close() {
        this.running = false;
        if (this.readFd >= 0) {
            try {
                fs.closeSync(this.readFd);
            }
            catch ( /* ignore */_a) { /* ignore */ }
            this.readFd = -1;
        }
        if (this.writeFd >= 0) {
            try {
                fs.closeSync(this.writeFd);
            }
            catch ( /* ignore */_b) { /* ignore */ }
            this.writeFd = -1;
        }
    }
    // ── Sending ───────────────────────────────────────────────────────────────
    /** Send an AUN ACK for a received packet — uses the received packet's seq verbatim. */
    sendAck(dststn, dstnet, port, ctrl, seq) {
        const header = Buffer.from([dststn, dstnet, 0x00, 0x00, exports.ECONET_AUN_ACK, port, ctrl, 0x00]);
        const seqBuf = Buffer.alloc(4);
        seqBuf.writeUInt32LE(seq, 0);
        const aunPkt = Buffer.concat([header, seqBuf]);
        const lenBuf = Buffer.alloc(2);
        lenBuf[0] = aunPkt.length & 0xff;
        lenBuf[1] = (aunPkt.length >> 8) & 0xff;
        fs.writeSync(this.writeFd, Buffer.concat([lenBuf, aunPkt]));
        if (this.debugLog) {
            this.debugLog('TX', {
                dststn, dstnet, srcstn: 0, srcnet: 0,
                aun_ttype: exports.ECONET_AUN_ACK, port, ctrl, seq,
                data: Buffer.alloc(0),
            });
        }
    }
    send(pkt) {
        this.seq += 4;
        const seqBuf = Buffer.alloc(4);
        seqBuf.writeUInt32LE(this.seq, 0);
        const header = Buffer.from([
            pkt.dststn, pkt.dstnet,
            pkt.srcstn, pkt.srcnet,
            pkt.aun_ttype,
            pkt.port,
            pkt.ctrl,
            0x00, // padding
        ]);
        const aunPkt = Buffer.concat([header, seqBuf, pkt.data]);
        const lenBuf = Buffer.alloc(2);
        lenBuf[0] = aunPkt.length & 0xff;
        lenBuf[1] = (aunPkt.length >> 8) & 0xff;
        const pipePkt = Buffer.concat([lenBuf, aunPkt]);
        fs.writeSync(this.writeFd, pipePkt);
        if (this.debugLog)
            this.debugLog('TX', { ...pkt, seq: this.seq });
    }
    // ── Receiving ─────────────────────────────────────────────────────────────
    /**
     * Return (and remove) the first packet matching filter, or undefined if none.
     * Non-blocking equivalent of eventQueueShift.
     */
    shiftPacket(filter) {
        const idx = filter ? this.pktQueue.findIndex(filter) : 0;
        if (idx < 0)
            return undefined;
        return this.pktQueue.splice(idx, 1)[0];
    }
    /**
     * Wait for the next packet that matches filter, up to timeoutMs.
     * Packets that don't match are buffered and remain available for
     * subsequent calls.
     */
    waitForPacket(filter, timeoutMs) {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                const idx = this.pktQueue.findIndex(filter);
                if (idx >= 0) {
                    resolve(this.pktQueue.splice(idx, 1)[0]);
                    return;
                }
                if (Date.now() >= deadline) {
                    reject(new Error(`Timeout after ${timeoutMs}ms waiting for packet`));
                    return;
                }
                setTimeout(check, 10);
            };
            check();
        });
    }
    // ── Private helpers ───────────────────────────────────────────────────────
    /** Periodic read: drain the non-blocking FIFO into recvBuf, then parse. */
    scheduleReadPoll() {
        const poll = () => {
            if (!this.running)
                return;
            try {
                const buf = Buffer.alloc(65536);
                const n = fs.readSync(this.readFd, buf, 0, buf.length, null);
                if (n > 0) {
                    this.recvBuf = Buffer.concat([this.recvBuf, buf.subarray(0, n)]);
                    this.parseBuffer();
                }
            }
            catch (e) {
                const err = e;
                if (err.code !== 'EAGAIN' && err.code !== 'EWOULDBLOCK') {
                    process.stderr.write(`Pipe read error: ${err.message}\n`);
                }
            }
            setTimeout(poll, 5);
        };
        setTimeout(poll, 5);
    }
    /** Extract complete AUN packets from recvBuf into pktQueue. */
    parseBuffer() {
        while (this.recvBuf.length >= 2) {
            const len = this.recvBuf[0] + ((this.recvBuf[1] << 8) & 0xff00);
            if (len < 12) {
                // Corrupt framing — discard and resync
                this.recvBuf = this.recvBuf.subarray(1);
                continue;
            }
            if (this.recvBuf.length < 2 + len)
                break;
            const aunBytes = this.recvBuf.subarray(2, 2 + len);
            this.recvBuf = this.recvBuf.subarray(2 + len);
            const pkt = {
                dststn: aunBytes[0],
                dstnet: aunBytes[1],
                srcstn: aunBytes[2],
                srcnet: aunBytes[3],
                aun_ttype: aunBytes[4],
                port: aunBytes[5],
                ctrl: aunBytes[6],
                seq: aunBytes.readUInt32LE(8),
                data: Buffer.from(aunBytes.subarray(12)),
            };
            this.pktQueue.push(pkt);
            if (this.debugLog)
                this.debugLog('RX', pkt);
        }
    }
    /**
     * Send a bridge broadcast (port 0x9c, ctrl 0x82) with a local-network
     * query.  This wakes the bridge so it opens its write pipe towards us.
     */
    sendBridgeWake() {
        const data = Buffer.concat([
            Buffer.from('BRIDGE'),
            Buffer.from([0x9c, 0x00]),
        ]);
        this.send({
            dststn: 0xff, dstnet: 0xff,
            srcstn: 0x00, srcnet: 0x00,
            aun_ttype: exports.ECONET_AUN_BCAST,
            port: 0x9c,
            ctrl: 0x82,
            data,
        });
    }
}
exports.EconetPipe = EconetPipe;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
exports.sleep = sleep;
const fmtStn = (stn, net) => `${net.toString().padStart(3, '0')}.${stn.toString().padStart(3, '0')}`;
const fmtPayload = (buf) => {
    const hex = buf.toString('hex').replace(/../g, '$& ').trim();
    const ascii = buf.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
    return `${hex}  "${ascii}"`;
};
function formatDebugPacket(direction, pkt) {
    const type = pkt.aun_ttype === exports.ECONET_AUN_BCAST ? 'BCAST' :
        pkt.aun_ttype === exports.ECONET_AUN_DATA ? 'MSG  ' :
            `T${pkt.aun_ttype.toString(16).padStart(2, '0')}  `;
    const dst = fmtStn(pkt.dststn, pkt.dstnet);
    const src = fmtStn(pkt.srcstn, pkt.srcnet);
    const ctrl = pkt.ctrl.toString(16).padStart(2, '0');
    const port = pkt.port.toString(16).padStart(2, '0');
    return `[${direction} ${type} ${dst}<-${src} ctrl=${ctrl} port=${port}] ${fmtPayload(pkt.data)}`;
}
//# sourceMappingURL=pipe.js.map