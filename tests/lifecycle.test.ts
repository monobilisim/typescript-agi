// What happens when the caller hangs up or the connection drops.

import { describe, expect, test } from 'bun:test';
import { pending, useAgiServer } from './support/asterisk';

const agi = useAgiServer();

describe('caller hangs up', () => {
  test('emits hangup, then close, and closes the connection', async () => {
    const { channel, asterisk } = await agi.call();
    const events: string[] = [];
    channel.on('hangup', () => events.push('hangup'));
    channel.on('close', () => events.push('close'));

    asterisk.hangup();
    await asterisk.closed;
    await Bun.sleep(10);

    expect(events).toEqual(['hangup', 'close']);
  });

  test('rejects the commands still waiting in the queue', async () => {
    const { channel, asterisk } = await agi.call();
    const cleared: unknown[] = [];
    channel.addListener('queueCleared', (event: unknown) =>
      cleared.push(event)
    );

    const onTheWire = pending(channel.exec('Playback', 'long', Infinity));
    const waiting = [pending(channel.noop()), pending(channel.noop())];
    await asterisk.nextCommand();

    asterisk.hangup();

    for (const command of waiting) {
      await expect(command).rejects.toThrow(
        'Call hung up before command could be executed'
      );
    }
    expect(cleared).toEqual([{ reason: 'hangup', commandsCleared: 2 }]);
    await expect(onTheWire).rejects.toThrow(
      'Call hung up before the command completed'
    );
  });

  test('a command with no timeout fails at once instead of hanging', async () => {
    const { channel, asterisk } = await agi.call();
    const failed: unknown[] = [];
    channel.addListener('commandFailed', (event: unknown) =>
      failed.push(event)
    );
    const onTheWire = pending(channel.exec('Dial', 'PJSIP/2000', Infinity));
    await asterisk.nextCommand();

    asterisk.hangup();

    await expect(onTheWire).rejects.toThrow(
      'Call hung up before the command completed'
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ command: 'EXEC Dial PJSIP/2000' });
  });

  test('new commands are refused afterwards', async () => {
    const { channel, asterisk } = await agi.call();

    asterisk.hangup();
    await asterisk.closed;

    await expect(channel.answer()).rejects.toThrow(
      'Channel is no longer alive'
    );
  });
});

describe('connection drops', () => {
  test('emits close and rejects the commands still waiting', async () => {
    const { channel, asterisk } = await agi.call();
    const cleared: unknown[] = [];
    let closed = false;
    channel.addListener('queueCleared', (event: unknown) =>
      cleared.push(event)
    );
    channel.on('close', () => {
      closed = true;
    });

    const onTheWire = pending(channel.exec('Playback', 'long', Infinity));
    const waiting = [pending(channel.noop()), pending(channel.noop())];
    await asterisk.nextCommand();

    await asterisk.close();

    for (const command of waiting) {
      await expect(command).rejects.toThrow(
        'Channel closed before command could be sent'
      );
    }
    expect(closed).toBe(true);
    expect(cleared).toEqual([{ reason: 'channel_closed', commandsCleared: 2 }]);
    await expect(onTheWire).rejects.toThrow(
      'Channel closed before the command completed'
    );
    await expect(channel.noop()).rejects.toThrow('Channel is no longer alive');
  });
});
