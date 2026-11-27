// A stand-in for Asterisk's side of a FastAGI connection: it connects to the
// AGIServer over loopback TCP, sends the agi_* environment block, then reads
// every command line the library writes and answers it the way Asterisk does.

import { afterAll, afterEach, beforeAll, expect } from 'bun:test';
import { connect, createServer, type Socket } from 'node:net';
import { AGIServer, type Channel } from '@monobilisim/typescript-agi';

export const HOST = '127.0.0.1';

/** The environment block Asterisk sends when a call enters AGI(agi://…). */
export const AGI_ENV: Readonly<Record<string, string>> = {
  agi_network: 'yes',
  agi_network_script: 'ivr',
  agi_request: 'ivr',
  agi_channel: 'PJSIP/1000-00000001',
  agi_language: 'tr',
  agi_type: 'PJSIP',
  agi_uniqueid: '1700000000.42',
  agi_version: '20.5.0',
  agi_callerid: '1000',
  agi_calleridname: 'Ali',
  agi_callingpres: '0',
  agi_callingani2: '0',
  agi_callington: '0',
  agi_callingtns: '0',
  agi_dnid: '4000',
  agi_rdnis: 'unknown',
  agi_context: 'from-internal',
  agi_extension: '4000',
  agi_priority: '1',
  agi_enhanced: '0.0',
  agi_accountcode: 'sales',
  agi_threadid: '139689736754944',
};

export function environmentBlock(env: Readonly<Record<string, string>>) {
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}: ${value}\n`)
      .join('') + '\n'
  );
}

/** Finds a free loopback port by letting the OS pick one. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

export async function startServer(): Promise<{
  server: AGIServer;
  port: number;
}> {
  const port = await freePort();
  const server = new AGIServer(port, HOST);
  const listening = new Promise<void>((resolve) =>
    server.on('listening', () => resolve())
  );
  await server.start();
  await listening;
  return { server, port };
}

export class FakeAsterisk {
  /** Every command line the library has sent, in order. */
  readonly received: string[] = [];
  /** Resolves once the connection is closed, by either side. */
  readonly closed: Promise<void>;
  private readonly unread: string[] = [];
  private waiting: ((line: string) => void) | null = null;
  private buffer = '';

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.received.push(line);
        const waiting = this.waiting;
        this.waiting = null;
        if (waiting) {
          waiting(line);
        } else {
          this.unread.push(line);
        }
        newline = this.buffer.indexOf('\n');
      }
    });
    this.closed = new Promise((resolve) =>
      socket.once('close', () => resolve())
    );
  }

  static connect(port: number): Promise<FakeAsterisk> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, HOST, () =>
        resolve(new FakeAsterisk(socket))
      );
      socket.once('error', reject);
    });
  }

  get isClosed(): boolean {
    return this.socket.destroyed;
  }

  write(data: string): void {
    this.socket.write(data);
  }

  reply(line: string): void {
    this.write(`${line}\n`);
  }

  /** Waits for the next command line the library sends. */
  nextCommand(): Promise<string> {
    const line = this.unread.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Asserts the next command line and answers it. */
  async expectCommand(command: string, reply: string): Promise<void> {
    expect(await this.nextCommand()).toBe(command);
    this.reply(reply);
  }

  /** What Asterisk writes when the caller hangs up during network AGI. */
  hangup(): void {
    this.reply('HANGUP');
  }

  async close(): Promise<void> {
    this.socket.destroy();
    await this.closed;
  }
}

/** Connects a fake Asterisk and waits for the server to hand out the channel. */
export async function placeCall(
  server: AGIServer,
  port: number,
  env: Readonly<Record<string, string>> = AGI_ENV
): Promise<{ channel: Channel; asterisk: FakeAsterisk }> {
  const ready = new Promise<Channel>((resolve) =>
    server.once('channel', resolve)
  );
  const asterisk = await FakeAsterisk.connect(port);
  asterisk.write(environmentBlock(env));
  return { channel: await ready, asterisk };
}

/**
 * Starts one AGIServer for the test file, hangs up every call after each
 * test and stops the server at the end.
 */
export function useAgiServer() {
  let started: { server: AGIServer; port: number } | undefined;
  const open: FakeAsterisk[] = [];

  beforeAll(async () => {
    started = await startServer();
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((asterisk) => asterisk.close()));
  });

  afterAll(async () => {
    await started?.server.stop();
  });

  return {
    get server(): AGIServer {
      if (!started) throw new Error('AGI server not started');
      return started.server;
    },
    get port(): number {
      if (!started) throw new Error('AGI server not started');
      return started.port;
    },
    async call(env: Readonly<Record<string, string>> = AGI_ENV) {
      const call = await placeCall(this.server, this.port, env);
      open.push(call.asterisk);
      return call;
    },
  };
}

/** Keeps an expected rejection from being reported as unhandled meanwhile. */
export function pending<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}
