// A stand-in for Asterisk's manager port: it accepts the AMIClient over
// loopback TCP, greets it the way Asterisk does, hands every action the
// client writes to the test and lets the test answer with responses and
// events.

import { afterEach, expect } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import { AMIClient } from '@monobilisim/typescript-agi';
import { HOST } from './asterisk';

export const BANNER = 'Asterisk Call Manager/9.0.0';
export const USERNAME = 'otomasyon';
export const SECRET = 's3cret';

/** One action as the client wrote it. */
export interface ReceivedAction {
  /** Every `Name: value` line, in order. */
  lines: string[];
  /** The first value of a header. */
  get(name: string): string | undefined;
}

export class FakeAMI {
  /** Every action the client has sent, in order. */
  readonly received: ReceivedAction[] = [];
  private readonly unread: ReceivedAction[] = [];
  private waiting: ((action: ReceivedAction) => void) | null = null;
  private client: Socket | null = null;
  private buffer = '';

  private constructor(
    private readonly server: Server,
    readonly port: number
  ) {
    server.on('connection', (socket: Socket) => {
      this.client = socket;
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => this.read(chunk));
      socket.write(`${BANNER}\r\n`);
    });
  }

  static start(): Promise<FakeAMI> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, HOST, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(new FakeAMI(server, port));
      });
    });
  }

  /** Writes one message block: `Name: value` lines and a blank line. */
  send(headers: Readonly<Record<string, string>>): void {
    this.sendLines(
      Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
    );
  }

  /** Writes one message block from raw lines, e.g. a repeated header. */
  sendLines(lines: readonly string[]): void {
    this.client?.write(`${lines.join('\r\n')}\r\n\r\n`);
  }

  /** Answers an action with its ActionID. */
  respond(
    action: ReceivedAction,
    headers: Readonly<Record<string, string>>
  ): void {
    this.send({ ...headers, ActionID: action.get('ActionID') ?? '' });
  }

  /** Waits for the next action the client sends. */
  nextAction(): Promise<ReceivedAction> {
    const action = this.unread.shift();
    if (action) return Promise.resolve(action);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Asserts the next action's name and returns it. */
  async expectAction(name: string): Promise<ReceivedAction> {
    const action = await this.nextAction();
    expect(action.get('Action')).toBe(name);
    return action;
  }

  /** Answers the Login the way Asterisk does for good credentials. */
  async acceptLogin(): Promise<ReceivedAction> {
    const login = await this.expectAction('Login');
    this.respond(login, {
      Response: 'Success',
      Message: 'Authentication accepted',
    });
    return login;
  }

  /** Drops the client's connection, as when Asterisk restarts. */
  dropClient(): void {
    this.client?.destroy();
  }

  stop(): Promise<void> {
    this.client?.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf('\r\n\r\n');
    while (end !== -1) {
      const lines = this.buffer.slice(0, end).split('\r\n');
      this.buffer = this.buffer.slice(end + 4);
      const action: ReceivedAction = {
        lines,
        get: (name) =>
          lines
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2),
      };
      this.received.push(action);
      const waiting = this.waiting;
      this.waiting = null;
      if (waiting) {
        waiting(action);
      } else {
        this.unread.push(action);
      }
      end = this.buffer.indexOf('\r\n\r\n');
    }
  }
}

/**
 * Starts a fake AMI per test and logs a client in against it; both are torn
 * down after each test.
 */
export function useFakeAmi() {
  const started: { ami: FakeAMI; client: AMIClient }[] = [];

  afterEach(async () => {
    for (const { ami, client } of started.splice(0)) {
      client.removeAllListeners('error');
      if (client.connected) {
        const closing = client.close();
        const logoff = await ami.nextAction();
        ami.respond(logoff, { Response: 'Goodbye' });
        await closing;
      }
      await ami.stop();
    }
  });

  return {
    /** A fake AMI and a client for it, not yet connected. */
    async create(timeout?: number) {
      const ami = await FakeAMI.start();
      const client = new AMIClient({
        host: HOST,
        port: ami.port,
        username: USERNAME,
        secret: SECRET,
        timeout,
      });
      started.push({ ami, client });
      return { ami, client };
    },
    /** A fake AMI and a client already logged in to it. */
    async connected(timeout?: number) {
      const { ami, client } = await this.create(timeout);
      const connecting = client.connect();
      await ami.acceptLogin();
      await connecting;
      return { ami, client };
    },
  };
}
