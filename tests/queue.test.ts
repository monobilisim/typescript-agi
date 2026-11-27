// The FIFO command queue: one command on the wire at a time, timeouts,
// backpressure, monitoring events and manual clearing.

import { describe, expect, test } from 'bun:test';
import { pending, useAgiServer } from './support/asterisk';

const agi = useAgiServer();

describe('command queue', () => {
  test('sends one command at a time and pairs each reply with its command', async () => {
    const { channel, asterisk } = await agi.call();

    const first = pending(channel.getVariable('a'));
    const second = pending(channel.getVariable('b'));
    const third = pending(channel.getVariable('c'));

    expect(await asterisk.nextCommand()).toBe('GET VARIABLE A');
    await Bun.sleep(30);
    expect(asterisk.received).toEqual(['GET VARIABLE A']);
    asterisk.reply('200 result=1 (1)');

    expect(await asterisk.nextCommand()).toBe('GET VARIABLE B');
    await Bun.sleep(30);
    expect(asterisk.received).toHaveLength(2);
    asterisk.reply('200 result=1 (2)');

    await asterisk.expectCommand('GET VARIABLE C', '200 result=1 (3)');

    expect(await Promise.all([first, second, third])).toEqual(['1', '2', '3']);
  });

  test('keeps going after a command fails', async () => {
    const { channel, asterisk } = await agi.call();

    const failing = pending(channel.getVariable('unset'));
    const next = pending(channel.getVariable('set'));

    await asterisk.expectCommand('GET VARIABLE UNSET', '200 result=0');
    await asterisk.expectCommand('GET VARIABLE SET', '200 result=1 (ok)');

    await expect(failing).rejects.toThrow('Variable not set');
    expect(await next).toBe('ok');
  });

  test('a reply split over several TCP packets is put back together', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.getVariable('split'));

    expect(await asterisk.nextCommand()).toBe('GET VARIABLE SPLIT');
    asterisk.write('200 res');
    await Bun.sleep(20);
    asterisk.write('ult=1 (whole)\n');

    expect(await result).toBe('whole');
  });

  test('getQueueStats() reports an idle queue', async () => {
    const { channel } = await agi.call();

    expect(channel.getQueueStats()).toEqual({
      size: 0,
      isProcessing: false,
      oldestCommandAge: null,
    });
  });

  test('getQueueStats() reports waiting commands while one is on the wire', async () => {
    const { channel, asterisk } = await agi.call();

    const commands = [
      pending(channel.noop()),
      pending(channel.noop()),
      pending(channel.noop()),
    ];
    await asterisk.nextCommand();
    await Bun.sleep(10);

    const stats = channel.getQueueStats();
    expect(stats.size).toBe(2);
    expect(stats.isProcessing).toBe(true);
    expect(stats.oldestCommandAge).toBeGreaterThanOrEqual(0);

    asterisk.reply('200 result=0');
    await asterisk.expectCommand('NOOP', '200 result=0');
    await asterisk.expectCommand('NOOP', '200 result=0');
    await Promise.all(commands);
  });

  test('clearCommandQueue() rejects every waiting command', async () => {
    const { channel, asterisk } = await agi.call();
    const cleared: unknown[] = [];
    channel.addListener('queueCleared', (event: unknown) =>
      cleared.push(event)
    );

    const onTheWire = pending(channel.noop());
    const waiting = [pending(channel.noop()), pending(channel.noop())];
    await asterisk.nextCommand();

    expect(channel.clearCommandQueue()).toBe(2);
    expect(cleared).toEqual([{ reason: 'manual', commandsCleared: 2 }]);
    for (const command of waiting) {
      await expect(command).rejects.toThrow('Command queue manually cleared');
    }

    asterisk.reply('200 result=0');
    expect(await onTheWire).toBeUndefined();
    expect(channel.getQueueStats().size).toBe(0);
  });

  test('clearCommandQueue() on an empty queue returns 0', async () => {
    const { channel } = await agi.call();

    expect(channel.clearCommandQueue()).toBe(0);
  });

  test('rejects new commands once 100 are waiting (backpressure)', async () => {
    const { channel, asterisk } = await agi.call();

    const onTheWire = pending(channel.exec('Wait', '1', 200));
    const waiting = Array.from({ length: 100 }, () => pending(channel.noop()));
    await asterisk.nextCommand();

    await expect(channel.noop()).rejects.toThrow(
      'Command queue full (100). Command rejected: NOOP'
    );

    channel.clearCommandQueue();
    await Promise.allSettled(waiting);
    await expect(onTheWire).rejects.toThrow('Command timeout after 200ms');
  });
});

describe('command timeouts', () => {
  test('a custom timeout rejects when Asterisk does not answer in time', async () => {
    const { channel, asterisk } = await agi.call();
    const failed: unknown[] = [];
    channel.addListener('commandFailed', (event: unknown) =>
      failed.push(event)
    );

    const result = pending(channel.exec('Dial', 'PJSIP/2000', 50));

    expect(await asterisk.nextCommand()).toBe('EXEC Dial PJSIP/2000');
    await expect(result).rejects.toThrow(
      'Command timeout after 50ms: EXEC Dial PJSIP/2000'
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ command: 'EXEC Dial PJSIP/2000' });
  });

  test('the next command still runs after a timeout', async () => {
    const { channel, asterisk } = await agi.call();

    const timedOut = pending(channel.exec('Wait', '10', 50));
    await asterisk.nextCommand();
    await expect(timedOut).rejects.toThrow('Command timeout');

    const next = pending(channel.noop());
    await asterisk.expectCommand('NOOP', '200 result=0');
    expect(await next).toBeUndefined();
  });

  test('Infinity waits as long as it takes', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.exec('Queue', 'support', Infinity));

    expect(await asterisk.nextCommand()).toBe('EXEC Queue support');
    await Bun.sleep(100);
    asterisk.reply('200 result=0');

    expect(await result).toBe(0);
  });
});

describe('monitoring events', () => {
  test('a command emits commandQueued, send, recv, response, commandProcessed and queueEmpty', async () => {
    const { channel, asterisk } = await agi.call();
    const events: [string, unknown][] = [];
    for (const name of [
      'commandQueued',
      'send',
      'recv',
      'response',
      'commandProcessed',
      'queueEmpty',
    ]) {
      channel.addListener(name, (payload: unknown) =>
        events.push([name, payload])
      );
    }

    const result = pending(channel.noop());
    await asterisk.expectCommand('NOOP', '200 result=0');
    await result;
    await Bun.sleep(10);

    expect(events.map(([name]) => name)).toEqual([
      'commandQueued',
      'send',
      'recv',
      'response',
      'commandProcessed',
      'queueEmpty',
    ]);
    const payload = Object.fromEntries(events);
    expect(payload.commandQueued).toEqual({ command: 'NOOP', queueSize: 1 });
    expect(payload.send).toBe('NOOP\n');
    expect(payload.recv).toBe('200 result=0');
    expect(payload.response).toMatchObject({ code: 200, result: 0 });
    expect(payload.commandProcessed).toMatchObject({ command: 'NOOP' });
    expect(
      (payload.commandProcessed as { duration: number }).duration
    ).toBeGreaterThanOrEqual(0);
  });
});
