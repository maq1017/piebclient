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

import * as fs from 'fs';

export const ECONET_AUN_BCAST  = 0x01;
export const ECONET_AUN_DATA   = 0x02;
export const ECONET_AUN_ACK    = 0x03;
export const ECONET_AUN_NAK    = 0x04;
export const ECONET_AUN_IMM    = 0x05;
export const ECONET_AUN_IMMREP = 0x06;

export interface AUNPacket {
  dststn:    number;
  dstnet:    number;
  srcstn:    number;
  srcnet:    number;
  aun_ttype: number;
  port:      number;
  ctrl:      number;
  seq:       number;
  data:      Buffer;
}

export class EconetPipe {
  private readFd  = -1;
  private writeFd = -1;
  private seq     = 0x4000;

  private recvBuf: Buffer   = Buffer.alloc(0);
  private pktQueue: AUNPacket[] = [];
  private running  = false;

  /** Optional debug callback — set to enable packet logging. */
  debugLog?: (direction: 'TX' | 'RX', pkt: AUNPacket) => void;

  // ── Connection ────────────────────────────────────────────────────────────

  async connect(pipeBase: string): Promise<void> {
    const fromPath = `${pipeBase}.frombridge`;
    const toPath   = `${pipeBase}.tobridge`;

    // Open read end non-blocking (succeeds even if bridge write end not yet open)
    this.readFd = fs.openSync(fromPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);

    // Open write end (bridge must already have its read end open)
    this.writeFd = fs.openSync(toPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);

    this.running = true;
    this.scheduleReadPoll();

    // Send a bridge broadcast to wake the bridge so it opens its write end
    this.sendBridgeWake();

    // Give the bridge a moment to open the write side and respond
    await sleep(200);
  }

  close(): void {
    this.running = false;
    if (this.readFd  >= 0) { try { fs.closeSync(this.readFd);  } catch { /* ignore */ } this.readFd  = -1; }
    if (this.writeFd >= 0) { try { fs.closeSync(this.writeFd); } catch { /* ignore */ } this.writeFd = -1; }
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /** Send an AUN ACK for a received packet — uses the received packet's seq verbatim. */
  sendAck(dststn: number, dstnet: number, port: number, ctrl: number, seq: number): void {
    const header = Buffer.from([dststn, dstnet, 0x00, 0x00, ECONET_AUN_ACK, port, ctrl, 0x00]);
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeUInt32LE(seq, 0);
    const aunPkt   = Buffer.concat([header, seqBuf]);
    const lenBuf   = Buffer.alloc(2);
    lenBuf[0] = aunPkt.length & 0xff;
    lenBuf[1] = (aunPkt.length >> 8) & 0xff;
    fs.writeSync(this.writeFd, Buffer.concat([lenBuf, aunPkt]));
    if (this.debugLog) {
      this.debugLog('TX', {
        dststn, dstnet, srcstn: 0, srcnet: 0,
        aun_ttype: ECONET_AUN_ACK, port, ctrl, seq,
        data: Buffer.alloc(0),
      });
    }
  }

  send(pkt: Omit<AUNPacket, 'seq'>): void {
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
    if (this.debugLog) this.debugLog('TX', { ...pkt, seq: this.seq });
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  /**
   * Return (and remove) the first packet matching filter, or undefined if none.
   * Non-blocking equivalent of eventQueueShift.
   */
  shiftPacket(filter?: (p: AUNPacket) => boolean): AUNPacket | undefined {
    const idx = filter ? this.pktQueue.findIndex(filter) : 0;
    if (idx < 0) return undefined;
    return this.pktQueue.splice(idx, 1)[0];
  }

  /**
   * Wait for the next packet that matches filter, up to timeoutMs.
   * Packets that don't match are buffered and remain available for
   * subsequent calls.
   */
  waitForPacket(
    filter: (p: AUNPacket) => boolean,
    timeoutMs: number,
  ): Promise<AUNPacket> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const idx = this.pktQueue.findIndex(filter);
        if (idx >= 0) {
          resolve(this.pktQueue.splice(idx, 1)[0] as AUNPacket);
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
  private scheduleReadPoll(): void {
    const poll = () => {
      if (!this.running) return;
      try {
        const buf = Buffer.alloc(65536);
        const n   = fs.readSync(this.readFd, buf, 0, buf.length, null);
        if (n > 0) {
          this.recvBuf = Buffer.concat([this.recvBuf, buf.subarray(0, n)]);
          this.parseBuffer();
        }
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'EAGAIN' && err.code !== 'EWOULDBLOCK') {
          process.stderr.write(`Pipe read error: ${err.message}\n`);
        }
      }
      setTimeout(poll, 5);
    };
    setTimeout(poll, 5);
  }

  /** Extract complete AUN packets from recvBuf into pktQueue. */
  private parseBuffer(): void {
    while (this.recvBuf.length >= 2) {
      const len = this.recvBuf[0]! + ((this.recvBuf[1]! << 8) & 0xff00);
      if (len < 12) {
        // Corrupt framing — discard and resync
        this.recvBuf = this.recvBuf.subarray(1);
        continue;
      }
      if (this.recvBuf.length < 2 + len) break;

      const aunBytes = this.recvBuf.subarray(2, 2 + len);
      this.recvBuf   = this.recvBuf.subarray(2 + len);

      const pkt: AUNPacket = {
        dststn:    aunBytes[0]!,
        dstnet:    aunBytes[1]!,
        srcstn:    aunBytes[2]!,
        srcnet:    aunBytes[3]!,
        aun_ttype: aunBytes[4]!,
        port:      aunBytes[5]!,
        ctrl:      aunBytes[6]!,
        seq:       aunBytes.readUInt32LE(8),
        data:      Buffer.from(aunBytes.subarray(12)),
      };
      this.pktQueue.push(pkt);
      if (this.debugLog) this.debugLog('RX', pkt);
    }
  }

  /**
   * Send a bridge broadcast (port 0x9c, ctrl 0x82) with a local-network
   * query.  This wakes the bridge so it opens its write pipe towards us.
   */
  private sendBridgeWake(): void {
    const data = Buffer.concat([
      Buffer.from('BRIDGE'),
      Buffer.from([0x9c, 0x00]),
    ]);
    this.send({
      dststn:    0xff, dstnet: 0xff,
      srcstn:    0x00, srcnet: 0x00,
      aun_ttype: ECONET_AUN_BCAST,
      port:      0x9c,
      ctrl:      0x82,
      data,
    });
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const fmtStn     = (stn: number, net: number) =>
  `${net.toString().padStart(3, '0')}.${stn.toString().padStart(3, '0')}`;
const fmtPayload = (buf: Buffer) => {
  const hex   = buf.toString('hex').replace(/../g, '$& ').trim();
  const ascii = buf.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
  return `${hex}  "${ascii}"`;
};

export function formatDebugPacket(direction: 'TX' | 'RX', pkt: AUNPacket): string {
  const type =
    pkt.aun_ttype === ECONET_AUN_BCAST ? 'BCAST' :
    pkt.aun_ttype === ECONET_AUN_DATA  ? 'MSG  ' :
    `T${pkt.aun_ttype.toString(16).padStart(2, '0')}  `;
  const dst  = fmtStn(pkt.dststn, pkt.dstnet);
  const src  = fmtStn(pkt.srcstn, pkt.srcnet);
  const ctrl = pkt.ctrl.toString(16).padStart(2, '0');
  const port = pkt.port.toString(16).padStart(2, '0');
  return `[${direction} ${type} ${dst}<-${src} ctrl=${ctrl} port=${port}] ${fmtPayload(pkt.data)}`;
}
