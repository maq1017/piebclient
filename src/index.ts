#!/usr/bin/env node
/**
 * piebclient — interactive Econet file server client via PiEconetBridge pipe
 *
 * Usage:
 *   piebclient -p <pipeBase> [-s [net.]<station>]
 *
 * Example:
 *   piebclient -p /tmp/econet -s 254
 *   piebclient -p /tmp/econet -s 0.254
 */

import { EconetPipe, formatDebugPacket } from './pipe';
import { EconetAddress } from './protocol';
import { runShell } from './shell';

function usage(code = 1): never {
  process.stderr.write(`
Usage: piebclient -p <pipeBase> [-s [net.]<stn>] [-d]

  -p <pipeBase>     Base path of the named pipes (e.g. /tmp/econet)
  -s [net.]<stn>    Default file server station (e.g. 254 or 1.254)
                    Can also be set per-session with "i am <stn> <user>"
  -d                Enable debug packet logging
  -h                This help text

`);
  process.exit(code);
}

function parseArgs(): { pipeBase: string; serverStation: EconetAddress; debug: boolean } {
  const argv = process.argv.slice(2);
  let pipeBase: string | undefined;
  let serverStation: EconetAddress = { network: 0, station: 254 };
  let debug = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '-p':
        pipeBase = argv[++i];
        break;
      case '-s': {
        const val = argv[++i];
        if (!val) usage();
        const parts = val.split('.');
        serverStation =
          parts.length === 2
            ? { network: parseInt(parts[0]!, 10), station: parseInt(parts[1]!, 10) }
            : { network: 0, station: parseInt(parts[0]!, 10) };
        break;
      }
      case '-d':
        debug = true;
        break;
      case '-h':
      case '--help':
        usage(0);
        break;
      default:
        process.stderr.write(`Unknown option: ${arg}\n`);
        usage();
    }
  }

  if (!pipeBase) {
    process.stderr.write('Error: -p <pipeBase> is required\n');
    usage();
  }

  return { pipeBase, serverStation, debug };
}

async function main(): Promise<void> {
  const { pipeBase, serverStation, debug } = parseArgs();

  const pipe = new EconetPipe();
  if (debug) {
    pipe.debugLog = (dir, pkt) => process.stderr.write(formatDebugPacket(dir, pkt) + '\n');
  }

  process.on('SIGINT',  () => { pipe.close(); process.exit(0); });
  process.on('SIGTERM', () => { pipe.close(); process.exit(0); });

  try {
    process.stderr.write(`Connecting to pipe: ${pipeBase}\n`);
    await pipe.connect(pipeBase);
    process.stderr.write('Connected.\n');
  } catch (e) {
    process.stderr.write(
      `Failed to open pipe: ${e instanceof Error ? e.message : String(e)}\n` +
      'Is PiEconetBridge running and the pipe path correct?\n',
    );
    process.exit(1);
  }

  try {
    await runShell(pipe, serverStation, debug);
  } finally {
    pipe.close();
  }
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
