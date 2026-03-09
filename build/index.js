#!/usr/bin/env node
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const pipe_1 = require("./pipe");
const shell_1 = require("./shell");
function usage(code = 1) {
    process.stderr.write(`
Usage: piebclient -p <pipeBase> [-s [net.]<stn>] [-d]

  -p <pipeBase>     Base path of the named pipes (e.g. /tmp/econet)
                    Opens <pipeBase>.tobridge and <pipeBase>.frombridge
  -s [net.]<stn>    Default file server station (e.g. 254 or 1.254)
                    Can also be set per-session with "i am <stn> <user>"
  -d                Enable debug packet logging
  -h                This help text

`);
    process.exit(code);
}
function parseArgs() {
    const argv = process.argv.slice(2);
    let pipeBase;
    let serverStation = { network: 0, station: 254 };
    let debug = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '-p':
                pipeBase = argv[++i];
                break;
            case '-s': {
                const val = argv[++i];
                if (!val)
                    usage();
                const parts = val.split('.');
                serverStation =
                    parts.length === 2
                        ? { network: parseInt(parts[0], 10), station: parseInt(parts[1], 10) }
                        : { network: 0, station: parseInt(parts[0], 10) };
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
async function main() {
    const { pipeBase, serverStation, debug } = parseArgs();
    const pipe = new pipe_1.EconetPipe();
    if (debug) {
        pipe.debugLog = (dir, pkt) => process.stderr.write((0, pipe_1.formatDebugPacket)(dir, pkt) + '\n');
    }
    process.on('SIGINT', () => { pipe.close(); process.exit(0); });
    process.on('SIGTERM', () => { pipe.close(); process.exit(0); });
    try {
        process.stderr.write(`Connecting to pipe: ${pipeBase}.{tobridge,frombridge} …\n`);
        await pipe.connect(pipeBase);
        process.stderr.write('Connected.\n');
    }
    catch (e) {
        process.stderr.write(`Failed to open pipe: ${e instanceof Error ? e.message : String(e)}\n` +
            'Is PiEconetBridge running and the pipe path correct?\n');
        process.exit(1);
    }
    try {
        await (0, shell_1.runShell)(pipe, serverStation, debug);
    }
    finally {
        pipe.close();
    }
}
main().catch(e => {
    process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map