// Asterisk Manager Interface (AMI) client: logs in over TCP, sends actions
// and receives their responses and events. AGI only runs on a call that is
// already up; AMI is what places the call (Originate) in the first place.

import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

/**
 * A message from Asterisk, a response to an action or an event, as
 * header → value. A header that appears more than once (e.g. `Output`) has
 * its values joined with a newline.
 */
export type AMIMessage = Record<string, string>;

/**
 * Headers of an action. An array sends the header once per value (e.g.
 * several `Variable` lines); `undefined` leaves the header out.
 */
export type AMIFields = Record<
  string,
  string | number | boolean | readonly string[] | undefined
>;

/**
 * Connection settings of an {@link AMIClient}
 */
export interface AMIClientOptions {
  /** Address of the Asterisk / FreePBX server */
  host: string;
  /** AMI port, 5038 by default */
  port?: number;
  /** Manager user (`manager.conf` / FreePBX "Asterisk Manager Users") */
  username: string;
  /** Password of the manager user */
  secret: string;
  /**
   * Milliseconds to wait for the connection, the login and every action's
   * response. 10 seconds by default.
   */
  timeout?: number;
}

/**
 * Why an originated call ended up the way it did: the `Reason` of
 * Asterisk's `OriginateResponse` event.
 */
export enum OriginateReason {
  /** The channel could not be created: unknown number, extension or technology */
  FAILED = 0,
  /** The far end hung up before answering */
  HANGUP = 1,
  /** It rang until the timeout without being answered */
  NO_ANSWER = 3,
  /** Answered */
  ANSWERED = 4,
  /** Busy */
  BUSY = 5,
  /** Congestion, or the destination is unreachable */
  CONGESTION = 8,
}

/**
 * What to call and what to connect it to once it answers: either a dialplan
 * application (`application` + `data`) or a dialplan location
 * (`context` + `exten` + `priority`).
 */
export interface OriginateOptions {
  /** Channel to dial, e.g. `PJSIP/1000` or `Local/905551112233@from-internal` */
  channel: string;
  /** Application to run on the answered call, e.g. `AGI` */
  application?: string;
  /** Argument of the application, e.g. `agi://10.0.0.20:4573` */
  data?: string;
  /** Dialplan context to continue in on answer */
  context?: string;
  /** Dialplan extension to continue in on answer */
  exten?: string;
  /** Dialplan priority to continue in on answer, 1 by default */
  priority?: number;
  /** Milliseconds to ring before giving up, 30 seconds by default */
  timeout?: number;
  /** Caller ID to present, e.g. `"Automation" <2120000000>` */
  callerId?: string;
  /** Channel variables to set on the new channel */
  variables?: Readonly<Record<string, string>>;
}

/**
 * Outcome of {@link AMIClient.originate}
 */
export interface OriginateResult {
  /** Whether the call was answered */
  answered: boolean;
  /** {@link OriginateReason} code Asterisk reported */
  reason: OriginateReason | number;
  /** Channel name Asterisk created, when it got that far */
  channel: string;
  /** Unique ID of that channel, when it got that far */
  uniqueid: string;
  /** The raw `OriginateResponse` event */
  event: AMIMessage;
}

/** @ignore */
interface IPending {
  resolve: (message: AMIMessage) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Extra time on top of the ring timeout for Asterisk to report the outcome. */
const ORIGINATE_GRACE_MS = 30_000;

/**
 * A connection to the Asterisk Manager Interface
 *
 * ```ts
 * const ami = new AMIClient({ host: '10.0.0.5', username: 'app', secret });
 * await ami.connect();
 * const result = await ami.originate({
 *   channel: 'Local/905551112233@from-internal',
 *   application: 'AGI',
 *   data: `agi://${ami.localAddress}:4573`,
 * });
 * await ami.close();
 * ```
 */
export class AMIClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly secret: string;
  private readonly timeout: number;
  private socket: Socket | null = null;
  private closed: Promise<void> = Promise.resolve();
  private buffer = '';
  private bannerSeen = false;
  private m_version = '';
  private nextActionId = 1;
  private readonly pendingActions = new Map<string, IPending>();
  private readonly pendingOriginates = new Map<string, IPending>();

  /**
   * Creates a client; nothing is sent until {@link connect}
   * @param options where and as whom to log in
   */
  constructor(options: AMIClientOptions) {
    super();
    this.setMaxListeners(10);

    this.host = options.host;
    this.port = options.port ?? 5038;
    this.username = options.username;
    this.secret = options.secret;
    this.timeout = options.timeout ?? 10_000;
  }

  /**
   * Event that is emitted for every AMI event Asterisk sends (the manager
   * user's read permissions decide which ones arrive)
   * @param event
   * @param listener
   */
  public on(event: 'event', listener: (message: AMIMessage) => void): this;

  /**
   * Event that is emitted when the connection is closed, by either side
   * @param event
   * @param listener
   */
  public on(event: 'close', listener: () => void): this;

  /**
   * Event that is emitted when the connection encounters an error after it
   * was established. Errors are only emitted while there is a listener; the
   * connection closes afterwards either way.
   * @param event
   * @param listener
   */
  public on(event: 'error', listener: (error: Error) => void): this;

  public on(event: any, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  /**
   * Version from Asterisk's greeting, e.g. `Asterisk Call Manager/9.0.0`
   */
  public get version(): string {
    return this.m_version;
  }

  /**
   * Whether the connection is open
   */
  public get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  /**
   * This machine's address as Asterisk sees it, i.e. the address Asterisk
   * can connect back to (for `agi://…`). Empty when not connected.
   */
  public get localAddress(): string {
    return this.socket?.localAddress ?? '';
  }

  /**
   * Opens the connection and logs in. Rejects when the server cannot be
   * reached, does not answer in time or refuses the credentials.
   */
  public async connect(): Promise<void> {
    if (this.socket) {
      throw new Error('AMI client is already connected');
    }

    const socket = await this.openSocket();
    this.socket = socket;
    this.buffer = '';
    this.bannerSeen = false;
    this.closed = new Promise((resolve) =>
      socket.once('close', () => {
        this.handleClose();
        resolve();
      })
    );
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.read(chunk));
    socket.on('error', (error) => {
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });

    try {
      await this.action('Login', {
        Username: this.username,
        Secret: this.secret,
      });
    } catch (error) {
      socket.destroy();
      await this.closed;
      throw new Error(`AMI login failed: ${(error as Error).message}`);
    }
  }

  /**
   * Sends an action and resolves with its response. Rejects when Asterisk
   * answers `Response: Error` (with its `Message`), on timeout and when the
   * connection closes first.
   * @param action action name, e.g. `Ping`, `Hangup`, `QueueStatus`
   * @param fields headers of the action, without `Action` and `ActionID`
   */
  public action(action: string, fields: AMIFields = {}): Promise<AMIMessage> {
    return this.sendAction(action, fields, this.newActionId());
  }

  /**
   * Places a call and resolves once Asterisk reports how it went: answered
   * (and handed to the application / dialplan), busy, unanswered, failed.
   * Resolves rather than rejects for those outcomes; check
   * {@link OriginateResult.answered}. Rejects when Asterisk refuses the
   * action itself (e.g. missing `originate` permission) or never reports.
   *
   * The manager user needs write permission `originate` and read permission
   * `call` (the outcome arrives as a call event). Asterisk also requires
   * write permission `system` to originate into applications such as `AGI`
   * or `System`; use `context` / `exten` to avoid that.
   * @param options what to call and what to connect it to
   */
  public async originate(options: OriginateOptions): Promise<OriginateResult> {
    const toApplication = options.application !== undefined;
    const toDialplan =
      options.context !== undefined && options.exten !== undefined;
    if (toApplication === toDialplan) {
      throw new Error(
        'Originate needs either application, or context and exten'
      );
    }

    const ringTimeout = options.timeout ?? 30_000;
    const fields: AMIFields = {
      Channel: options.channel,
      Application: options.application,
      Data: options.data,
      Context: options.context,
      Exten: options.exten,
      Priority: toDialplan ? (options.priority ?? 1) : undefined,
      Timeout: ringTimeout,
      CallerID: options.callerId,
      Variable: Object.entries(options.variables ?? {}).map(
        ([name, value]) => `${name}=${value}`
      ),
      Async: true,
    };

    const actionId = this.newActionId();
    const outcome = this.waitFor(
      this.pendingOriginates,
      actionId,
      ringTimeout + ORIGINATE_GRACE_MS,
      'Timed out waiting for the originate outcome'
    );
    outcome.catch(() => {});

    try {
      await this.sendAction('Originate', fields, actionId);
    } catch (error) {
      this.settle(this.pendingOriginates, actionId);
      throw error;
    }

    const event = await outcome;
    const reason = Number(event.Reason ?? OriginateReason.FAILED);
    return {
      answered: event.Response === 'Success',
      reason,
      channel: event.Channel ?? '',
      uniqueid: event.Uniqueid ?? '',
      event,
    };
  }

  /**
   * Logs off and closes the connection; does nothing when not connected
   */
  public async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;

    try {
      await this.action('Logoff');
    } catch {
      // Closing anyway.
    }
    socket.destroy();
    await this.closed;
  }

  private openSocket(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.port, this.host);
      const fail = (error: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `Timed out connecting to AMI at ${this.host}:${this.port}`
            )
          ),
        this.timeout
      );
      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        resolve(socket);
      });
    });
  }

  private newActionId(): string {
    return String(this.nextActionId++);
  }

  private sendAction(
    action: string,
    fields: AMIFields,
    actionId: string
  ): Promise<AMIMessage> {
    let payload: string;
    try {
      payload = serialize(action, fields, actionId);
    } catch (error) {
      return Promise.reject(error);
    }

    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('AMI client is not connected'));
    }

    const response = this.waitFor(
      this.pendingActions,
      actionId,
      this.timeout,
      `Timed out waiting for the response to ${action}`
    );
    socket.write(payload);
    return response;
  }

  private waitFor(
    pending: Map<string, IPending>,
    actionId: string,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<AMIMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(pending, actionId, new Error(timeoutMessage)),
        timeoutMs
      );
      pending.set(actionId, { resolve, reject, timer });
    });
  }

  /** Resolves (message) or rejects (error) a pending entry and forgets it. */
  private settle(
    pending: Map<string, IPending>,
    actionId: string,
    outcome?: AMIMessage | Error
  ): void {
    const entry = pending.get(actionId);
    if (!entry) return;
    pending.delete(actionId);
    clearTimeout(entry.timer);
    if (outcome instanceof Error) {
      entry.reject(outcome);
    } else if (outcome) {
      entry.resolve(outcome);
    } else {
      entry.reject(new Error('Cancelled'));
    }
  }

  private read(chunk: string): void {
    this.buffer += chunk;

    if (!this.bannerSeen) {
      // The greeting is a single line, not a blank-line terminated block.
      const end = this.buffer.indexOf('\r\n');
      if (end === -1) return;
      this.m_version = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.bannerSeen = true;
    }

    let end = this.buffer.indexOf('\r\n\r\n');
    while (end !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 4);
      this.dispatch(parse(block));
      end = this.buffer.indexOf('\r\n\r\n');
    }
  }

  private dispatch(message: AMIMessage): void {
    const actionId = message.ActionID;

    // Events can carry a Response header too (OriginateResponse does), so
    // they are told apart by Event first.
    if (message.Event !== undefined) {
      if (message.Event === 'OriginateResponse' && actionId !== undefined) {
        this.settle(this.pendingOriginates, actionId, message);
      }
      this.emit('event', message);
      return;
    }

    if (message.Response !== undefined && actionId !== undefined) {
      this.settle(
        this.pendingActions,
        actionId,
        message.Response === 'Error'
          ? new Error(message.Message || 'Action failed')
          : message
      );
    }
  }

  private handleClose(): void {
    const error = new Error('AMI connection closed');
    for (const actionId of [...this.pendingActions.keys()]) {
      this.settle(this.pendingActions, actionId, error);
    }
    for (const actionId of [...this.pendingOriginates.keys()]) {
      this.settle(this.pendingOriginates, actionId, error);
    }
    this.socket = null;
    this.emit('close');
  }
}

/** @ignore */
function serialize(
  action: string,
  fields: AMIFields,
  actionId: string
): string {
  const lines = [header('Action', action), header('ActionID', actionId)];

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'action' || lower === 'actionid') {
      throw new Error(`${name} is set by the client`);
    }
    const values: readonly string[] =
      typeof value === 'object' ? value : [String(value)];
    for (const single of values) {
      lines.push(header(name, single));
    }
  }

  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * One `Name: value` line. A line break would end the header early and let the
 * value smuggle in headers or whole actions of its own, so it is refused.
 * @ignore
 */
function header(name: string, value: string): string {
  if (
    name === '' ||
    name.includes(':') ||
    hasLineBreak(name) ||
    hasLineBreak(value)
  ) {
    throw new Error(`Invalid AMI header: ${JSON.stringify(name)}`);
  }
  return `${name}: ${value}`;
}

/** @ignore */
function hasLineBreak(text: string): boolean {
  return text.includes('\r') || text.includes('\n');
}

/** @ignore */
function parse(block: string): AMIMessage {
  const message: AMIMessage = {};
  for (const line of block.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();
    message[name] =
      message[name] === undefined ? value : `${message[name]}\n${value}`;
  }
  return message;
}
