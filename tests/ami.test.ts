// AMIClient against a fake manager port: login, actions, events, originate.

import { describe, expect, test } from 'bun:test';
import {
  AMIClient,
  OriginateReason,
  type AMIMessage,
} from '@monobilisim/typescript-agi';
import { HOST, freePort, pending } from './support/asterisk';
import { BANNER, SECRET, USERNAME, useFakeAmi } from './support/ami';

const fake = useFakeAmi();

describe('connect', () => {
  test('logs in with the credentials and reads the greeting', async () => {
    const { ami, client } = await fake.create();

    const connecting = client.connect();
    const login = await ami.acceptLogin();
    await connecting;

    expect(login.get('Username')).toBe(USERNAME);
    expect(login.get('Secret')).toBe(SECRET);
    expect(client.connected).toBe(true);
    expect(client.version).toBe(BANNER);
    expect(client.localAddress).toBe(HOST);
  });

  test('rejects and closes when the credentials are refused', async () => {
    const { ami, client } = await fake.create();

    const connecting = pending(client.connect());
    const login = await ami.expectAction('Login');
    ami.respond(login, { Response: 'Error', Message: 'Authentication failed' });

    await expect(connecting).rejects.toThrow(
      'AMI login failed: Authentication failed'
    );
    expect(client.connected).toBe(false);
  });

  test('rejects when nothing listens on the port', async () => {
    const client = new AMIClient({
      host: HOST,
      port: await freePort(),
      username: USERNAME,
      secret: SECRET,
    });

    await expect(client.connect()).rejects.toThrow();
    expect(client.connected).toBe(false);
  });

  test('refuses to connect twice', async () => {
    const { client } = await fake.connected();

    await expect(client.connect()).rejects.toThrow(
      'AMI client is already connected'
    );
  });
});

describe('action', () => {
  test('sends the headers and resolves with the response', async () => {
    const { ami, client } = await fake.connected();

    const reply = client.action('Hangup', {
      Channel: 'PJSIP/1000-00000001',
      Cause: 16,
      Variable: ['A=1', 'B=2'],
      Skipped: undefined,
    });
    const sent = await ami.expectAction('Hangup');
    ami.respond(sent, { Response: 'Success', Message: 'Channel Hungup' });

    expect(sent.lines).toEqual([
      'Action: Hangup',
      `ActionID: ${sent.get('ActionID')}`,
      'Channel: PJSIP/1000-00000001',
      'Cause: 16',
      'Variable: A=1',
      'Variable: B=2',
    ]);
    expect((await reply).Message).toBe('Channel Hungup');
  });

  test('joins a header that appears more than once', async () => {
    const { ami, client } = await fake.connected();

    const reply = client.action('Command', { Command: 'core show uptime' });
    const sent = await ami.expectAction('Command');
    ami.sendLines([
      'Response: Success',
      `ActionID: ${sent.get('ActionID')}`,
      'Output: System uptime: 1 hour',
      'Output: Last reload: 5 minutes',
    ]);

    expect((await reply).Output).toBe(
      'System uptime: 1 hour\nLast reload: 5 minutes'
    );
  });

  test('rejects with the message of an error response', async () => {
    const { ami, client } = await fake.connected();

    const reply = pending(client.action('Hangup', { Channel: 'nope' }));
    ami.respond(await ami.expectAction('Hangup'), {
      Response: 'Error',
      Message: 'No such channel',
    });

    await expect(reply).rejects.toThrow('No such channel');
  });

  test('refuses a value with a line break and sends nothing', async () => {
    const { ami, client } = await fake.connected();
    const before = ami.received.length;

    await expect(
      client.action('Hangup', { Channel: 'x\r\nAction: Command' })
    ).rejects.toThrow('Invalid AMI header');
    await Bun.sleep(10);

    expect(ami.received.length).toBe(before);
  });

  test('refuses to let the caller set ActionID', async () => {
    const { client } = await fake.connected();

    await expect(client.action('Ping', { ActionID: '7' })).rejects.toThrow(
      'ActionID is set by the client'
    );
  });

  test('rejects when no response arrives in time', async () => {
    const { ami, client } = await fake.connected(50);

    const reply = pending(client.action('Ping'));
    await ami.expectAction('Ping');

    await expect(reply).rejects.toThrow(
      'Timed out waiting for the response to Ping'
    );
  });

  test('rejects pending actions and emits close when the connection drops', async () => {
    const { ami, client } = await fake.connected();
    let closed = false;
    client.on('close', () => {
      closed = true;
    });

    const reply = pending(client.action('Ping'));
    await ami.expectAction('Ping');
    ami.dropClient();

    await expect(reply).rejects.toThrow('AMI connection closed');
    expect(closed).toBe(true);
    expect(client.connected).toBe(false);
  });
});

describe('events', () => {
  test('emits events but not responses', async () => {
    const { ami, client } = await fake.connected();
    const events: AMIMessage[] = [];
    client.on('event', (event) => events.push(event));

    const reply = client.action('Ping');
    ami.send({ Event: 'FullyBooted', Status: 'Fully Booted' });
    ami.respond(await ami.expectAction('Ping'), { Response: 'Success' });
    await reply;

    expect(events).toEqual([{ Event: 'FullyBooted', Status: 'Fully Booted' }]);
  });
});

describe('originate', () => {
  test('dials into an application and resolves once answered', async () => {
    const { ami, client } = await fake.connected();

    const call = client.originate({
      channel: 'Local/905551112233@from-internal',
      application: 'AGI',
      data: 'agi://10.0.0.20:4573',
      timeout: 20_000,
      callerId: '"Automation" <2120000000>',
      variables: { CAMPAIGN: 'test' },
    });
    const sent = await ami.expectAction('Originate');
    ami.respond(sent, {
      Response: 'Success',
      Message: 'Originate successfully queued',
    });
    ami.send({
      Event: 'OriginateResponse',
      ActionID: 'other',
      Response: 'Failure',
      Reason: '5',
    });
    ami.send({
      Event: 'OriginateResponse',
      ActionID: sent.get('ActionID') ?? '',
      Response: 'Success',
      Channel: 'Local/905551112233@from-internal-00000001;1',
      Reason: '4',
      Uniqueid: '1700000000.7',
    });

    expect(sent.lines.slice(2)).toEqual([
      'Channel: Local/905551112233@from-internal',
      'Application: AGI',
      'Data: agi://10.0.0.20:4573',
      'Timeout: 20000',
      'CallerID: "Automation" <2120000000>',
      'Variable: CAMPAIGN=test',
      'Async: true',
    ]);
    const result = await call;
    expect(result.answered).toBe(true);
    expect(result.reason).toBe(OriginateReason.ANSWERED);
    expect(result.channel).toBe('Local/905551112233@from-internal-00000001;1');
    expect(result.uniqueid).toBe('1700000000.7');
  });

  test('resolves with the reason when the call is not answered', async () => {
    const { ami, client } = await fake.connected();

    const call = client.originate({
      channel: 'PJSIP/1000',
      application: 'AGI',
    });
    const sent = await ami.expectAction('Originate');
    ami.respond(sent, { Response: 'Success' });
    ami.send({
      Event: 'OriginateResponse',
      ActionID: sent.get('ActionID') ?? '',
      Response: 'Failure',
      Reason: '5',
    });

    const result = await call;
    expect(result.answered).toBe(false);
    expect(result.reason).toBe(OriginateReason.BUSY);
  });

  test('dials into a dialplan location with priority 1 by default', async () => {
    const { ami, client } = await fake.connected();

    const call = client.originate({
      channel: 'PJSIP/1000',
      context: 'from-internal',
      exten: '4000',
    });
    const sent = await ami.expectAction('Originate');
    ami.respond(sent, { Response: 'Success' });
    ami.send({
      Event: 'OriginateResponse',
      ActionID: sent.get('ActionID') ?? '',
      Response: 'Success',
      Reason: '4',
    });
    await call;

    expect(sent.lines.slice(2)).toEqual([
      'Channel: PJSIP/1000',
      'Context: from-internal',
      'Exten: 4000',
      'Priority: 1',
      'Timeout: 30000',
      'Async: true',
    ]);
  });

  test('needs exactly one of application or context and exten', async () => {
    const { client } = await fake.connected();
    const message = 'Originate needs either application, or context and exten';

    await expect(client.originate({ channel: 'PJSIP/1000' })).rejects.toThrow(
      message
    );
    await expect(
      client.originate({
        channel: 'PJSIP/1000',
        application: 'AGI',
        context: 'from-internal',
        exten: '4000',
      })
    ).rejects.toThrow(message);
  });

  test('rejects when Asterisk refuses the action', async () => {
    const { ami, client } = await fake.connected();

    const call = pending(
      client.originate({ channel: 'PJSIP/1000', application: 'AGI' })
    );
    ami.respond(await ami.expectAction('Originate'), {
      Response: 'Error',
      Message: 'Permission denied',
    });

    await expect(call).rejects.toThrow('Permission denied');
  });
});

describe('close', () => {
  test('logs off, closes the connection and emits close', async () => {
    const { ami, client } = await fake.connected();
    let closed = false;
    client.on('close', () => {
      closed = true;
    });

    const closing = client.close();
    ami.respond(await ami.expectAction('Logoff'), {
      Response: 'Goodbye',
      Message: 'Thanks for all the fish.',
    });
    await closing;

    expect(closed).toBe(true);
    expect(client.connected).toBe(false);
  });

  test('does nothing when not connected', async () => {
    const { client } = await fake.create();

    await client.close();

    expect(client.connected).toBe(false);
  });
});
