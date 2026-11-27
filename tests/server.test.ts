import { describe, expect, test } from 'bun:test';
import { AGIServer, type Channel } from '@monobilisim/typescript-agi';
import {
  AGI_ENV,
  FakeAsterisk,
  HOST,
  environmentBlock,
  freePort,
  placeCall,
  startServer,
} from './support/asterisk';

describe('AGIServer', () => {
  test('emits listening with the port and address it was given', async () => {
    const port = await freePort();
    const server = new AGIServer(port, HOST);
    const listening = new Promise<[number, string]>((resolve) =>
      server.on('listening', (p, ip) => resolve([p, ip]))
    );

    await server.start();

    expect(await listening).toEqual([port, HOST]);
    await server.stop();
  });

  test('stop() resolves and emits close', async () => {
    const { server } = await startServer();
    let closed = false;
    server.on('close', () => {
      closed = true;
    });

    await server.stop();

    expect(closed).toBe(true);
  });

  test('stop() rejects when the server was never started', async () => {
    const server = new AGIServer(await freePort(), HOST);

    await expect(server.stop()).rejects.toThrow();
  });

  test('emits error when the port is already taken', async () => {
    const { server, port } = await startServer();
    const second = new AGIServer(port, HOST);
    const failed = new Promise<Error>((resolve) => second.on('error', resolve));

    await second.start();

    expect((await failed).message).toStartWith('Internal TCP server error:');
    await server.stop();
  });

  test('hands out the channel only after the whole environment block', async () => {
    const { server, port } = await startServer();
    let channel: Channel | undefined;
    server.on('channel', (c) => {
      channel = c;
    });
    const asterisk = await FakeAsterisk.connect(port);

    const block = environmentBlock(AGI_ENV);
    asterisk.write(block.slice(0, -1));
    await Bun.sleep(50);
    expect(channel).toBeUndefined();

    const ready = new Promise<Channel>((resolve) =>
      server.once('channel', resolve)
    );
    asterisk.write('\n');
    expect(await ready).toBe(channel!);

    await asterisk.close();
    await server.stop();
  });

  test('serves several calls at once, each on its own channel', async () => {
    const { server, port } = await startServer();
    const first = await placeCall(server, port, {
      ...AGI_ENV,
      agi_uniqueid: '1.1',
    });
    const second = await placeCall(server, port, {
      ...AGI_ENV,
      agi_uniqueid: '1.2',
    });

    expect(first.channel).not.toBe(second.channel);
    expect(first.channel.uniqueid).toBe('1.1');
    expect(second.channel.uniqueid).toBe('1.2');

    const a = first.channel.getVariable('who');
    const b = second.channel.getVariable('who');
    await second.asterisk.expectCommand('GET VARIABLE WHO', '200 result=1 (b)');
    await first.asterisk.expectCommand('GET VARIABLE WHO', '200 result=1 (a)');
    expect(await a).toBe('a');
    expect(await b).toBe('b');

    await first.asterisk.close();
    await second.asterisk.close();
    await server.stop();
  });
});

describe('Channel environment', () => {
  test('exposes every agi_* variable Asterisk sent', async () => {
    const { server, port } = await startServer();
    const { channel, asterisk } = await placeCall(server, port);

    expect(channel.network).toBe(true);
    expect(channel.network_script).toBe('ivr');
    expect(channel.request).toBe('ivr');
    expect(channel.channel).toBe('PJSIP/1000-00000001');
    expect(channel.language).toBe('tr');
    expect(channel.type).toBe('PJSIP');
    expect(channel.uniqueid).toBe('1700000000.42');
    expect(channel.version).toBe('20.5.0');
    expect(channel.callerid).toBe('1000');
    expect(channel.calleridname).toBe('Ali');
    expect(channel.callingpres).toBe('0');
    expect(channel.callingani2).toBe('0');
    expect(channel.callington).toBe('0');
    expect(channel.callingtns).toBe('0');
    expect(channel.dnid).toBe('4000');
    expect(channel.rdnis).toBe('unknown');
    expect(channel.context).toBe('from-internal');
    expect(channel.extension).toBe('4000');
    expect(channel.priority).toBe('1');
    expect(channel.enhanced).toBe('0.0');
    expect(channel.accountcode).toBe('sales');
    expect(channel.threadid).toBe('139689736754944');

    await asterisk.close();
    await server.stop();
  });

  test('keeps values that contain colons, such as the agi:// URL', async () => {
    const { server, port } = await startServer();
    const { channel, asterisk } = await placeCall(server, port, {
      ...AGI_ENV,
      agi_request: 'agi://127.0.0.1:4573/ivr',
    });

    expect(channel.request).toBe('agi://127.0.0.1:4573/ivr');

    await asterisk.close();
    await server.stop();
  });

  test('network is false when agi_network is not yes', async () => {
    const { server, port } = await startServer();
    const { channel, asterisk } = await placeCall(server, port, {
      ...AGI_ENV,
      agi_network: 'no',
    });

    expect(channel.network).toBe(false);

    await asterisk.close();
    await server.stop();
  });

  test('unknown variables are ignored and missing ones read as empty', async () => {
    const { server, port } = await startServer();
    const { channel, asterisk } = await placeCall(server, port, {
      agi_request: 'ivr',
      agi_arg_1: 'ignored',
    });

    expect(channel.request).toBe('ivr');
    expect(channel.callerid).toBe('');
    expect(channel.network).toBe(false);

    await asterisk.close();
    await server.stop();
  });
});
