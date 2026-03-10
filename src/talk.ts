/**
 * Econet Network Conferencer — port of ecoclient's talk command.
 * Based on & compatible with TALK v5.24 by J.G.Harston.
 *
 * Protocol uses port 0xB0 for messages, 0xB1 for server replies.
 * ctrl 0x80 for discovery, 0x81+ for channel messages.
 */

import { AUNPacket, EconetPipe, ECONET_AUN_BCAST, ECONET_AUN_DATA, formatDebugPacket } from './pipe';

// ── Constants ────────────────────────────────────────────────────────────────

const TALK_PORT          = 0xb0;
const TALK_REPLY_PORT    = 0xb1;
const TALK_CTRL_DISCOVER = 0x80;
const TALK_CHANNEL_DEFAULT = 0x81;

const PING_INTERVAL_MS = 500;
const MAX_PING_COUNT   = 5;
const POLL_INTERVAL_MS = 50;
const PROMPT           = '> ';

// ── Protocol send helpers ─────────────────────────────────────────────────────

function sendTalkFind(pipe: EconetPipe): void {
  pipe.send({
    dststn: 0xff, dstnet: 0xff,
    srcstn: 0,    srcnet: 0,
    aun_ttype: ECONET_AUN_BCAST,
    port: TALK_PORT,
    ctrl: TALK_CTRL_DISCOVER,
    data: Buffer.from('TALK    '),
  });
}

function sendTalkReply(pipe: EconetPipe, station: number, network: number): void {
  pipe.send({
    dststn: station, dstnet: network,
    srcstn: 0,       srcnet: 0,
    aun_ttype: ECONET_AUN_DATA,
    port: TALK_PORT,
    ctrl: TALK_CTRL_DISCOVER,
    data: Buffer.from('TALK_RPL'),
  });
}

function sendServerReply(pipe: EconetPipe, station: number, network: number, myName: string): void {
  const nameBytes = Buffer.from(myName.slice(0, 13));
  const data      = Buffer.alloc(12 + nameBytes.length);
  data[0] = 0x00;
  data[1] = TALK_PORT;
  data[2] = 0x52; // version 5.2
  Buffer.from('TALK    ').copy(data, 3);
  data[11] = nameBytes.length;
  nameBytes.copy(data, 12);
  pipe.send({
    dststn: station, dstnet: network,
    srcstn: 0,       srcnet: 0,
    aun_ttype: ECONET_AUN_DATA,
    port: TALK_REPLY_PORT,
    ctrl: TALK_CTRL_DISCOVER,
    data,
  });
}

function sendTalkMessage(
  pipe:    EconetPipe,
  station: number,
  network: number,
  flag:    string,
  myName:  string,
  message: string,
  channel: number,
): void {
  const parts: number[] = [flag.charCodeAt(0), 0x00];
  if (flag !== ';') {
    for (const ch of myName) parts.push(ch === ' ' ? 0x80 : ch.charCodeAt(0));
    parts.push(0x0d);
  }
  for (const ch of message) parts.push(ch.charCodeAt(0));
  parts.push(0x0d);
  pipe.send({
    dststn: station, dstnet: network,
    srcstn: 0,       srcnet: 0,
    aun_ttype: ECONET_AUN_DATA,
    port: TALK_PORT,
    ctrl: channel,
    data: Buffer.from(parts),
  });
}

// ── Protocol receive helpers ──────────────────────────────────────────────────

const isTalkPacket = (p: AUNPacket): boolean =>
  p.aun_ttype === ECONET_AUN_BCAST ||
  (p.aun_ttype === ECONET_AUN_DATA &&
    (p.port === TALK_PORT || p.port === TALK_REPLY_PORT));

function parseTalkMessage(data: Buffer): { flag: string; senderName: string; message: string } | undefined {
  if (data.length < 2) return undefined;
  const flag   = String.fromCharCode(data[0]!);
  let offset   = 2;
  let senderName = '';
  while (offset < data.length && data[offset] !== 0x0d) {
    const byte = data[offset++]!;
    senderName += byte === 0x80 ? ' ' : byte >= 32 ? String.fromCharCode(byte) : '';
  }
  if (offset < data.length) offset++;
  let message = '';
  while (offset < data.length && data[offset] !== 0x0d) {
    const byte = data[offset++]!;
    if (byte >= 32 || byte === 0x0a) message += String.fromCharCode(byte);
  }
  return { flag, senderName, message };
}

function parseServerReply(data: Buffer): string | undefined {
  if (data.length < 12)                                        return undefined;
  if (data[0] !== 0x00 || data[1] !== TALK_PORT)              return undefined;
  if (!data.subarray(3, 11).equals(Buffer.from('TALK    ')))   return undefined;
  const nameLen = data[11]!;
  if (nameLen === 0 || nameLen > 13 || data.length < 12 + nameLen) return undefined;
  return data.subarray(12, 12 + nameLen).toString('ascii');
}

// ── Talk session (command) ────────────────────────────────────────────────────

type TalkUser = { station: number; network: number; name: string };

const HELP = `Commands (prefix with *):
  *A <[net.]stn>  Add a station to the default list
  *B <num>        Rebroadcast enquiry (0 = reset to default)
  *C <num>        Change channel number
  *H              This help
  *I <[net.]stn>  Ignore a station (0 to clear)
  *O <[net.]stn>  Listen only to a station (0 to clear)
  *Q              Quit
  *R <index>      Remove user from default list (use *U to see indices)
  *U              List users on default

Sending messages:
  <message>              Sends to all stations on the default list
  :<name> <message>      Sends directly to a named user`;

export async function commandTalk(pipe: EconetPipe, myName: string, debug = false): Promise<void> {
  const users: TalkUser[] = [];
  let channel   = TALK_CHANNEL_DEFAULT;
  let pingCount = MAX_PING_COUNT;
  let lastPingMs = 0;
  let focusOn:  { station: number; network: number } | null = null;  // *O
  let focusNot: { station: number; network: number } | null = null;  // *I

  // Save raw mode state so we can restore it exactly on exit (readline sets raw=true)
  const wasRaw = process.stdin.isTTY && (process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw === true;

  const findUser = (stn: number, net: number) =>
    users.findIndex(u => u.station === stn && u.network === net);

  const addUser = (stn: number, net: number, name?: string): number => {
    const idx = findUser(stn, net);
    if (idx >= 0) { if (name) users[idx]!.name = name; return idx; }
    const newIdx = users.length;
    users.push({ station: stn, network: net, name: name ?? fmtStn(stn, net) });
    return newIdx;
  };

  const fmtStn = (stn: number, net: number) => net > 0 ? `${net}.${stn}` : `${stn}`;

  const parseStn = (arg: string): { station: number; network: number } | null => {
    const parts = arg.split('.');
    let stn: number, net: number;
    if (parts.length === 2) { net = parseInt(parts[0]!); stn = parseInt(parts[1]!); }
    else                    { net = 0; stn = parseInt(arg); }
    if (isNaN(stn) || stn < 0) return null;
    return { station: stn, network: net };
  };

  // ── Split-screen terminal UI ─────────────────────────────────────────────
  let inputBuffer = '';
  let cursorPos   = 0;
  const tRows = () => process.stdout.rows || 24;

  const setupTerminal = () => {
    const r = tRows();
    process.stdout.write(`\x1b[1;${r - 1}r`);
    process.stdout.write(`\x1b[${r};1H\x1b[K${PROMPT}`);
  };

  const restoreTerminal = () => {
    process.stdout.write('\x1b[r');
    const r = tRows();
    process.stdout.write(`\x1b[${r};1H\x1b[K\n`);
  };

  const redrawInput = () => {
    const r   = tRows();
    const col = PROMPT.length + cursorPos + 1;
    process.stdout.write(`\x1b[${r};1H\x1b[K${PROMPT}${inputBuffer}\x1b[${r};${col}H`);
  };

  const displayMessage = (msg: string) => {
    const r = tRows();
    process.stdout.write(`\x1b[${r - 1};1H\n${msg}\x1b[K`);
    redrawInput();
  };

  // In talk mode, route debug output through the scroll-region UI
  const prevDebugLog = pipe.debugLog;
  if (debug) pipe.debugLog = (dir, pkt) => displayMessage(formatDebugPacket(dir, pkt));

  process.stdout.write('\nEconet Network Conferencer\n');
  process.stdout.write(`Channel: ${channel ^ 0x80}\n`);
  process.stdout.write(`Your name: ${myName}\n`);
  process.stdout.write('Type *H for help\n');

  setupTerminal();

  lastPingMs = Date.now() - PING_INTERVAL_MS;

  return new Promise<void>(resolve => {
    let closing = false;
    let currentPoll: Promise<void> = Promise.resolve();
    let pollInterval: ReturnType<typeof setInterval>;

    // Save and remove any existing stdin 'data' listeners (e.g. readline) so
    // they don't receive our raw keystrokes and fire shell commands.
    const savedDataListeners = process.stdin.rawListeners('data') as ((...args: unknown[]) => void)[];
    process.stdin.removeAllListeners('data');

    const cleanup = () => {
      closing = true;
      clearInterval(pollInterval);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      for (const listener of savedDataListeners) process.stdin.on('data', listener);
      process.stdout.removeAllListeners('resize');
      pipe.debugLog = prevDebugLog;
      restoreTerminal();
      void currentPoll.then(resolve);
    };

    const sendToAll = (flag: string, message: string): void => {
      for (const user of users) {
        try {
          sendTalkMessage(pipe, user.station, user.network, flag, myName, message, channel);
        } catch { /* ignore */ }
      }
      lastPingMs = Date.now();
    };

    const processCommand = async (input: string) => {
      const trimmed = input.trim();
      if (trimmed.length === 0) return;

      if (trimmed[0] === '*') {
        const cmd = trimmed[1]?.toUpperCase();
        const arg = trimmed.slice(2).trim();
        switch (cmd) {
          case 'A': {
            const a = parseStn(arg);
            if (a && a.station > 0) {
              addUser(a.station, a.network);
              displayMessage(`Added station ${fmtStn(a.station, a.network)}`);
            } else {
              displayMessage('Usage: *A <[net.]station>');
            }
            break;
          }
          case 'B': {
            const n = parseInt(arg);
            pingCount = (!isNaN(n) && n > 0) ? n : MAX_PING_COUNT;
            lastPingMs = Date.now() - PING_INTERVAL_MS;
            displayMessage(`Rebroadcasting (${pingCount} enquiries)`);
            break;
          }
          case 'I': {
            if (arg === '0' || arg === '') {
              focusNot = null;
              displayMessage('No longer ignoring any station.');
            } else {
              const s = parseStn(arg);
              if (s && s.station > 0) {
                focusNot = s;
                displayMessage(`Ignoring station ${fmtStn(s.station, s.network)}`);
              } else {
                displayMessage('Usage: *I <[net.]station>  (0 to clear)');
              }
            }
            break;
          }
          case 'O': {
            if (arg === '0' || arg === '') {
              focusOn = null;
              displayMessage('Listening to all stations.');
            } else {
              const s = parseStn(arg);
              if (s && s.station > 0) {
                focusOn = s;
                displayMessage(`Listening only to station ${fmtStn(s.station, s.network)}`);
              } else {
                displayMessage('Usage: *O <[net.]station>  (0 to clear)');
              }
            }
            break;
          }
          case 'C': {
            const ch = parseInt(arg);
            if (!isNaN(ch) && ch > 0) {
              sendToAll('>', 'Changing channel');
              channel = (ch | 0x80) & 0xff;
              sendToAll('>', 'Has arrived');
              displayMessage(`Channel changed to ${channel ^ 0x80}`);
            } else {
              displayMessage('Usage: *C <channel>');
            }
            break;
          }
          case 'H':
            for (const line of HELP.split('\n')) displayMessage(line);
            break;
          case 'Q':
            sendToAll('>', 'Logging off');
            displayMessage('Logging off...');
            cleanup();
            break;
          case 'R': {
            const idx = parseInt(arg);
            if (!isNaN(idx) && idx >= 0 && idx < users.length) {
              displayMessage(`Removed ${users[idx]!.name}`);
              users.splice(idx, 1);
            } else {
              displayMessage('Usage: *R <index>  (use *U to list users)');
            }
            break;
          }
          case 'U':
            if (users.length === 0) {
              displayMessage('Nobody on the default list yet.');
            } else {
              displayMessage('People on default:');
              users.forEach((u, i) => displayMessage(`  ${i}: ${u.name} (${fmtStn(u.station, u.network)})`));
            }
            break;
          default:
            displayMessage('Unknown command. Type *H for help.');
        }
        return;
      }

      // Direct message: :name message
      if (trimmed[0] === ':') {
        const space = trimmed.indexOf(' ', 1);
        if (space < 0) { displayMessage('Usage: :<name> <message>'); return; }
        const targetName = trimmed.slice(1, space);
        const message    = trimmed.slice(space + 1);
        let target = users.find(u => u.name.toLowerCase() === targetName.toLowerCase());
        if (!target) {
          const parts = targetName.split('.');
          let stn: number, net: number;
          if (parts.length === 2) { net = parseInt(parts[0]!); stn = parseInt(parts[1]!); }
          else                    { net = 0; stn = parseInt(targetName); }
          if (!isNaN(stn)) target = { station: stn, network: net, name: targetName };
        }
        if (target) {
          try { sendTalkMessage(pipe, target.station, target.network, ']', myName, message, channel); }
          catch (e) { displayMessage(`[${targetName}: ${e instanceof Error ? e.message : String(e)}]`); }
        } else {
          displayMessage(`User not found: ${targetName}`);
        }
        return;
      }

      // Broadcast to all
      if (users.length === 0) { displayMessage('Nobody has responded yet.'); return; }
      sendToAll(':', trimmed);
    };

    const handlePacket = async (pkt: AUNPacket) => {
      if (pkt.aun_ttype === ECONET_AUN_BCAST) {
        const { srcstn, srcnet, data } = pkt;

        // ServerFind (8 spaces)
        if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('        '))) {
          try { sendServerReply(pipe, srcstn, srcnet, myName); } catch { /* ignore */ }
          return;
        }
        // TalkFind ("TALK    ")
        if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('TALK    '))) {
          try { sendTalkReply(pipe, srcstn, srcnet); } catch { /* ignore */ }
          return;
        }
        // TalkReply ("TALK_RPL") as broadcast
        if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('TALK_RPL'))) {
          const wasNew = findUser(srcstn, srcnet) < 0;
          addUser(srcstn, srcnet);
          if (wasNew) {
            displayMessage(`[Station ${fmtStn(srcstn, srcnet)} acknowledged]`);
            try { sendTalkMessage(pipe, srcstn, srcnet, '>', myName, 'Logging on', channel); } catch { /* ignore */ }
          }
        }

      } else if (pkt.aun_ttype === ECONET_AUN_DATA) {
        const { srcstn, srcnet, ctrl, port, data } = pkt;

        // ServerReply (port TALK_REPLY_PORT, ctrl TALK_CTRL_DISCOVER)
        if (port === TALK_REPLY_PORT && ctrl === TALK_CTRL_DISCOVER) {
          const name = parseServerReply(data);
          if (name) {
            const wasNew = findUser(srcstn, srcnet) < 0;
            addUser(srcstn, srcnet, name);
            if (wasNew) {
              displayMessage(`[Station ${fmtStn(srcstn, srcnet)} (${name}) joined]`);
              try { sendTalkMessage(pipe, srcstn, srcnet, '>', myName, 'Logging on', channel); } catch { /* ignore */ }
            }
          }
          return;
        }

        if (port !== TALK_PORT) return;

        if (ctrl === TALK_CTRL_DISCOVER) {
          // TalkReply as unicast
          if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('TALK_RPL'))) {
            const wasNew = findUser(srcstn, srcnet) < 0;
            addUser(srcstn, srcnet);
            if (wasNew) {
              displayMessage(`[Station ${fmtStn(srcstn, srcnet)} acknowledged]`);
              try { sendTalkMessage(pipe, srcstn, srcnet, '>', myName, 'Logging on', channel); } catch { /* ignore */ }
            }
          } else if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from('TALK    '))) {
            // TalkFind received as unicast — reply
            try { sendTalkReply(pipe, srcstn, srcnet); } catch { /* ignore */ }
          }
          return;
        }

        // Talk message on channel
        if (ctrl === channel) {
          const parsed = parseTalkMessage(data);
          if (parsed) {
            const { flag, senderName, message } = parsed;
            if (senderName) addUser(srcstn, srcnet, senderName);
            // *I: ignore station
            if (focusNot && focusNot.station === srcstn && focusNot.network === srcnet) {
              try { sendTalkMessage(pipe, srcstn, srcnet, '-', myName, 'Not listening', channel); } catch { /* ignore */ }
              return;
            }
            // *O: listen only to one station
            if (focusOn && !(focusOn.station === srcstn && focusOn.network === srcnet)) return;
            const prefix = senderName ? `${senderName}${flag} ` : '';
            displayMessage(`${prefix}${message}`);
          }
        }
      }
    };

    // Poll loop — drain queued packets, send periodic presence broadcasts
    pollInterval = setInterval(() => {
      currentPoll = currentPoll.then(async () => {
        if (closing) return;
        let pkt: AUNPacket | undefined;
        while ((pkt = pipe.shiftPacket(isTalkPacket)) !== undefined) {
          await handlePacket(pkt);
        }
        if (!closing) {
          const now = Date.now();
          if (pingCount > 0 && now - lastPingMs >= PING_INTERVAL_MS) {
            try { sendTalkFind(pipe); lastPingMs = now; pingCount--; } catch { /* ignore */ }
          }
        }
      }).catch(() => {});
    }, POLL_INTERVAL_MS);

    // Raw key input
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = async (key: string) => {
      if (closing) return;
      if (key === '\r' || key === '\n') {
        const line = inputBuffer;
        inputBuffer = ''; cursorPos = 0;
        displayMessage(`${PROMPT}${line}`);
        await processCommand(line);
        if (!closing) redrawInput();
      } else if (key === '\x7f' || key === '\b') {
        if (cursorPos > 0) {
          inputBuffer = inputBuffer.slice(0, cursorPos - 1) + inputBuffer.slice(cursorPos);
          cursorPos--;
          redrawInput();
        }
      } else if (key === '\x1b[D') {
        if (cursorPos > 0) { cursorPos--; redrawInput(); }
      } else if (key === '\x1b[C') {
        if (cursorPos < inputBuffer.length) { cursorPos++; redrawInput(); }
      } else if (key === '\x1b[H' || key === '\x01') {
        cursorPos = 0; redrawInput();
      } else if (key === '\x1b[F' || key === '\x05') {
        cursorPos = inputBuffer.length; redrawInput();
      } else if (key === '\x03' || key === '\x04') {
        sendToAll('>', 'Logging off');
        cleanup();
      } else if (key.length === 1 && key >= ' ') {
        inputBuffer = inputBuffer.slice(0, cursorPos) + key + inputBuffer.slice(cursorPos);
        cursorPos++;
        redrawInput();
      }
    };

    process.stdin.on('data', onData);
    process.stdout.on('resize', () => { setupTerminal(); redrawInput(); });
    redrawInput();
  });
}
