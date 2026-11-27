// Each public command: the exact line the library writes to Asterisk, how it
// reads Asterisk's reply, and the error it throws when Asterisk reports failure.

import { describe, expect, test } from 'bun:test';
import {
  ChannelState,
  DialStatus,
  PlaybackStatus,
  type Channel,
} from '@monobilisim/typescript-agi';
import { pending, useAgiServer } from './support/asterisk';

const agi = useAgiServer();

interface Success {
  title: string;
  run: (channel: Channel) => Promise<unknown>;
  command: string;
  reply: string;
  expected: unknown;
}

interface Failure {
  title: string;
  run: (channel: Channel) => Promise<unknown>;
  command: string;
  reply: string;
  error: string;
}

const NOT_200 = '510 Invalid or unknown command';

// One row per case reads better than what the formatter would make of it.
// prettier-ignore
const successes: Success[] = [
  // Call control
  { title: 'answer()', run: (c) => c.answer(), command: 'ANSWER', reply: '200 result=0', expected: undefined },
  { title: 'hangup()', run: (c) => c.hangup(), command: 'HANGUP', reply: '200 result=1', expected: undefined },
  { title: 'hangup(channel)', run: (c) => c.hangup('PJSIP/2000-00000002'), command: 'HANGUP PJSIP/2000-00000002', reply: '200 result=1', expected: undefined },
  { title: 'noop()', run: (c) => c.noop(), command: 'NOOP', reply: '200 result=0', expected: undefined },
  { title: 'channelStatus()', run: (c) => c.channelStatus(), command: 'CHANNEL STATUS', reply: '200 result=6', expected: ChannelState.UP },
  { title: 'channelStatus(channel)', run: (c) => c.channelStatus('PJSIP/2000-00000002'), command: 'CHANNEL STATUS PJSIP/2000-00000002', reply: '200 result=4', expected: ChannelState.RINGING },
  { title: 'exec()', run: (c) => c.exec('Playback', 'hello-world'), command: 'EXEC Playback hello-world', reply: '200 result=0', expected: 0 },
  { title: 'goSub()', run: (c) => c.goSub('sub-greet', 's', 1, 'tr'), command: 'GOSUB sub-greet s 1 tr', reply: '200 result=0', expected: undefined },
  { title: 'setAutoHangup()', run: (c) => c.setAutoHangup(), command: 'SET AUTOHANGUP 60', reply: '200 result=0', expected: undefined },
  { title: 'setAutoHangup(0)', run: (c) => c.setAutoHangup(0), command: 'SET AUTOHANGUP 0', reply: '200 result=0', expected: undefined },
  { title: 'setCallerID(number, name)', run: (c) => c.setCallerID(1000, 'Ali'), command: 'SET CALLERID "Ali"<1000>', reply: '200 result=1', expected: undefined },
  { title: 'setCallerID(number)', run: (c) => c.setCallerID(1000), command: 'SET CALLERID 1000', reply: '200 result=1', expected: undefined },
  { title: 'setContext()', run: (c) => c.setContext('from-internal'), command: 'SET CONTEXT from-internal', reply: '200 result=0', expected: undefined },
  { title: 'setExtension()', run: (c) => c.setExtension('4000'), command: 'SET EXTENSION 4000', reply: '200 result=0', expected: undefined },
  { title: 'setPriority()', run: (c) => c.setPriority(3), command: 'SET PRIORITY 3', reply: '200 result=0', expected: undefined },
  { title: 'setMusic()', run: (c) => c.setMusic(), command: 'SET MUSIC ON', reply: '200 result=0', expected: undefined },
  { title: 'setMusic(true, class)', run: (c) => c.setMusic(true, 'jazz'), command: 'SET MUSIC ON jazz', reply: '200 result=0', expected: undefined },
  { title: 'setMusic(false)', run: (c) => c.setMusic(false), command: 'SET MUSIC OFF', reply: '200 result=0', expected: undefined },
  { title: 'tddMode(true)', run: (c) => c.tddMode(true), command: 'TDD MODE ON', reply: '200 result=1', expected: undefined },
  { title: 'tddMode(false)', run: (c) => c.tddMode(false), command: 'TDD MODE OFF', reply: '200 result=1', expected: undefined },
  { title: 'verbose(message, level)', run: (c) => c.verbose('hello', 3), command: 'VERBOSE "hello" 3', reply: '200 result=1', expected: undefined },
  { title: 'verbose(message)', run: (c) => c.verbose('hello'), command: 'VERBOSE "hello"', reply: '200 result=1', expected: undefined },

  // Variables and database
  { title: 'getVariable()', run: (c) => c.getVariable('dialstatus'), command: 'GET VARIABLE DIALSTATUS', reply: '200 result=1 (ANSWER)', expected: 'ANSWER' },
  { title: 'getVariable() of a value with spaces', run: (c) => c.getVariable('callerid(name)'), command: 'GET VARIABLE CALLERID(NAME)', reply: '200 result=1 (Ali Veli)', expected: 'Ali Veli' },
  { title: 'getVariable() of a value with parentheses and =', run: (c) => c.getVariable('x'), command: 'GET VARIABLE X', reply: '200 result=1 (a=b (c)  d)', expected: 'a=b (c)  d' },
  { title: 'getFullVariable()', run: (c) => c.getFullVariable('${CALLERID(num)}'), command: 'GET FULL VARIABLE ${CALLERID(NUM)}', reply: '200 result=1 (1000)', expected: '1000' },
  { title: 'getFullVariable(key, channel)', run: (c) => c.getFullVariable('${EXTEN}', 'PJSIP/2000-00000002'), command: 'GET FULL VARIABLE ${EXTEN} PJSIP/2000-00000002', reply: '200 result=1 (2000)', expected: '2000' },
  { title: 'setVariable()', run: (c) => c.setVariable('lang', 'tr'), command: 'SET VARIABLE LANG "tr"', reply: '200 result=1', expected: undefined },
  { title: 'databaseGet()', run: (c) => c.databaseGet('cf', '1000'), command: 'DATABASE GET cf 1000', reply: '200 result=1 (2000)', expected: '2000' },
  { title: 'databasePut()', run: (c) => c.databasePut('cf', '1000', '2000'), command: 'DATABASE PUT cf 1000 2000', reply: '200 result=1', expected: '' },
  { title: 'databaseDelTree() of an existing tree', run: (c) => c.databaseDelTree('cf', '1000'), command: 'DATABASE DELTREE cf 1000', reply: '200 result=1', expected: true },
  { title: 'databaseDelTree() of a missing tree', run: (c) => c.databaseDelTree('cf'), command: 'DATABASE DELTREE cf', reply: '200 result=0', expected: false },
  { title: 'databaseDel()', run: (c) => c.databaseDel('cf', '1000'), command: 'DATABASE DEL cf 1000', reply: '200 result=1', expected: undefined },

  // Prompts and digits
  { title: 'getData(file)', run: (c) => c.getData('enter-pin'), command: 'GET DATA enter-pin 5000', reply: '200 result=1234', expected: { digits: '1234', timeout: false } },
  { title: 'getData(file, timeout, maxDigits)', run: (c) => c.getData('enter-pin', 8000, 4), command: 'GET DATA enter-pin 8000 4', reply: '200 result=4321', expected: { digits: '4321', timeout: false } },
  { title: 'getData() timing out', run: (c) => c.getData('enter-pin', 5000, 4), command: 'GET DATA enter-pin 5000 4', reply: '200 result=12 (timeout)', expected: { digits: '12', timeout: true } },
  { title: 'getOption()', run: (c) => c.getOption('main-menu', '123', 3), command: 'GET OPTION main-menu "123" 3000', reply: '200 result=50 endpos=8000', expected: { digit: '2', endpos: 8000 } },
  { title: 'waitForDigit()', run: (c) => c.waitForDigit(), command: 'WAIT FOR DIGIT 5000', reply: '200 result=49', expected: '1' },
  { title: 'waitForDigit() without a digit', run: (c) => c.waitForDigit(2), command: 'WAIT FOR DIGIT 2000', reply: '200 result=0', expected: '' },
  { title: 'receiveChar()', run: (c) => c.receiveChar(2), command: 'RECEIVE CHAR 2000', reply: '200 result=65', expected: { char: 'A', timeout: false } },
  { title: 'receiveChar() timing out', run: (c) => c.receiveChar(), command: 'RECEIVE CHAR 5000', reply: '200 result=0 (timeout)', expected: { char: '', timeout: true } },
  { title: 'receiveText()', run: (c) => c.receiveText(3), command: 'RECEIVE TEXT 3000', reply: '200 result=merhaba', expected: 'merhaba' },
  { title: 'recordFile() with defaults', run: (c) => c.recordFile('/tmp/msg'), command: 'RECORD FILE /tmp/msg gsm "#" 10000', reply: '200 result=35 (dtmf) endpos=16000', expected: { digit: '#', endpos: 16000, timeout: false } },
  { title: 'recordFile() with beep and silence', run: (c) => c.recordFile('/tmp/msg', 'wav', '#', 30, true, 5), command: 'RECORD FILE /tmp/msg wav "#" 30000  BEEP s=5', reply: '200 result=0 (timeout) endpos=24000', expected: { digit: '', endpos: 24000, timeout: true } },

  // Say
  { title: 'sayAlpha()', run: (c) => c.sayAlpha('abc'), command: 'SAY ALPHA abc "#"', reply: '200 result=0', expected: '' },
  { title: 'sayAlpha() interrupted by a digit', run: (c) => c.sayAlpha('abc', '0123456789#'), command: 'SAY ALPHA abc "0123456789#"', reply: '200 result=35', expected: '#' },
  { title: 'sayDate(Date)', run: (c) => c.sayDate(new Date(1_700_000_000_000)), command: 'SAY DATE 1700000000 "#"', reply: '200 result=0', expected: '' },
  { title: 'sayDate(epoch)', run: (c) => c.sayDate(1_700_000_000, '12'), command: 'SAY DATE 1700000000 "12"', reply: '200 result=49', expected: '1' },
  { title: 'sayDateTime()', run: (c) => c.sayDateTime(new Date(1_700_000_000_000), '#', 'dB', 'Europe/Istanbul'), command: 'SAY DATETIME 1700000000 "#" dB Europe/Istanbul', reply: '200 result=0', expected: '' },
  { title: 'sayDigits()', run: (c) => c.sayDigits('1234'), command: 'SAY DIGITS 1234 "#"', reply: '200 result=0', expected: '' },
  { title: 'sayNumber()', run: (c) => c.sayNumber(42), command: 'SAY NUMBER 42 "#"', reply: '200 result=0', expected: '' },
  { title: 'sayPhonetic()', run: (c) => c.sayPhonetic('mono'), command: 'SAY PHONETIC mono "#"', reply: '200 result=0', expected: '' },
  { title: 'sayTime()', run: (c) => c.sayTime(1_700_000_000), command: 'SAY TIME 1700000000 "#"', reply: '200 result=0', expected: '' },

  // Media
  { title: 'sendImage()', run: (c) => c.sendImage('logo'), command: 'SEND IMAGE logo', reply: '200 result=0', expected: undefined },
  { title: 'sendText()', run: (c) => c.sendText('merhaba'), command: 'SEND TEXT "merhaba"', reply: '200 result=0', expected: undefined },
];

// prettier-ignore
const failures: Failure[] = [
  { title: 'answer()', run: (c) => c.answer(), command: 'ANSWER', reply: '200 result=-1', error: 'Could not answer call' },
  { title: 'hangup()', run: (c) => c.hangup(), command: 'HANGUP', reply: '200 result=-1', error: 'Could not hang up call' },
  { title: 'noop() on a non-200 reply', run: (c) => c.noop(), command: 'NOOP', reply: NOT_200, error: 'Could not NOOP' },
  { title: 'channelStatus()', run: (c) => c.channelStatus(), command: 'CHANNEL STATUS', reply: '200 result=-1', error: 'Could not get channel status' },
  { title: 'exec()', run: (c) => c.exec('Nope', ''), command: 'EXEC Nope', reply: '200 result=-2', error: 'Could not execute application' },
  { title: 'goSub()', run: (c) => c.goSub('sub-x', 's', 1), command: 'GOSUB sub-x s 1', reply: '200 result=-1', error: 'Could not execute gosub' },
  { title: 'setAutoHangup()', run: (c) => c.setAutoHangup(5), command: 'SET AUTOHANGUP 5', reply: '200 result=-1', error: 'Could not set auto hangup' },
  { title: 'setCallerID()', run: (c) => c.setCallerID(1000), command: 'SET CALLERID 1000', reply: '200 result=0', error: 'Could not set caller id' },
  { title: 'setContext()', run: (c) => c.setContext('x'), command: 'SET CONTEXT x', reply: '200 result=-1', error: 'Could not set context' },
  { title: 'setExtension()', run: (c) => c.setExtension('x'), command: 'SET EXTENSION x', reply: '200 result=-1', error: 'Could not set extension' },
  { title: 'setPriority()', run: (c) => c.setPriority(9), command: 'SET PRIORITY 9', reply: '200 result=-1', error: 'Could not set priority' },
  { title: 'setMusic()', run: (c) => c.setMusic(), command: 'SET MUSIC ON', reply: NOT_200, error: 'Could not set priority' },
  { title: 'tddMode()', run: (c) => c.tddMode(true), command: 'TDD MODE ON', reply: '200 result=0', error: 'Could not set TDD mode' },
  { title: 'verbose()', run: (c) => c.verbose('x'), command: 'VERBOSE "x"', reply: NOT_200, error: 'Could not send logging message' },
  { title: 'getVariable() of an unset variable', run: (c) => c.getVariable('nope'), command: 'GET VARIABLE NOPE', reply: '200 result=0', error: 'Variable not set' },
  { title: 'getFullVariable() of an unset variable', run: (c) => c.getFullVariable('${NOPE}'), command: 'GET FULL VARIABLE ${NOPE}', reply: '200 result=0', error: 'Variable not set' },
  { title: 'setVariable()', run: (c) => c.setVariable('x', 'y'), command: 'SET VARIABLE X "y"', reply: NOT_200, error: 'Could not set variable' },
  { title: 'databaseGet() of a missing key', run: (c) => c.databaseGet('cf', '9'), command: 'DATABASE GET cf 9', reply: '200 result=0', error: 'Database key not set' },
  { title: 'databasePut()', run: (c) => c.databasePut('cf', '9', '1'), command: 'DATABASE PUT cf 9 1', reply: '200 result=0', error: 'Database key not set' },
  { title: 'databaseDel()', run: (c) => c.databaseDel('cf', '9'), command: 'DATABASE DEL cf 9', reply: '200 result=0', error: 'Could not delete from the database' },
  { title: 'databaseDelTree()', run: (c) => c.databaseDelTree('cf'), command: 'DATABASE DELTREE cf', reply: NOT_200, error: 'Could not delete tree from database' },
  { title: 'getData()', run: (c) => c.getData('enter-pin'), command: 'GET DATA enter-pin 5000', reply: '200 result=-1', error: 'Could not get data from channel' },
  { title: 'getOption()', run: (c) => c.getOption('main-menu'), command: 'GET OPTION main-menu "#" 5000', reply: '200 result=-1', error: 'Could not get option' },
  { title: 'getOption() when the file did not play', run: (c) => c.getOption('main-menu'), command: 'GET OPTION main-menu "#" 5000', reply: '200 result=0 endpos=0', error: 'Could Not play file' },
  { title: 'waitForDigit()', run: (c) => c.waitForDigit(), command: 'WAIT FOR DIGIT 5000', reply: '200 result=-1', error: 'Could not wait for digit' },
  { title: 'receiveChar()', run: (c) => c.receiveChar(), command: 'RECEIVE CHAR 5000', reply: '200 result=-1', error: 'Could not get data from channel' },
  { title: 'receiveText()', run: (c) => c.receiveText(), command: 'RECEIVE TEXT 5000', reply: '200 result=-1', error: 'Could not get data from channel' },
  { title: 'recordFile()', run: (c) => c.recordFile('/tmp/msg'), command: 'RECORD FILE /tmp/msg gsm "#" 10000', reply: '200 result=-1', error: 'Could not record file' },
  { title: 'sayAlpha()', run: (c) => c.sayAlpha('a'), command: 'SAY ALPHA a "#"', reply: '200 result=-1', error: 'Could not say alpha' },
  { title: 'sayDate()', run: (c) => c.sayDate(1), command: 'SAY DATE 1 "#"', reply: '200 result=-1', error: 'Could not say date' },
  { title: 'sayDateTime()', run: (c) => c.sayDateTime(1), command: 'SAY DATETIME 1 "#"', reply: '200 result=-1', error: 'Could not say date time' },
  { title: 'sayDigits()', run: (c) => c.sayDigits('1'), command: 'SAY DIGITS 1 "#"', reply: '200 result=-1', error: 'Could not say digits' },
  { title: 'sayNumber()', run: (c) => c.sayNumber(1), command: 'SAY NUMBER 1 "#"', reply: '200 result=-1', error: 'Could not say number' },
  { title: 'sayPhonetic()', run: (c) => c.sayPhonetic('a'), command: 'SAY PHONETIC a "#"', reply: '200 result=-1', error: 'Could not say phonetic' },
  { title: 'sayTime()', run: (c) => c.sayTime(1), command: 'SAY TIME 1 "#"', reply: '200 result=-1', error: 'Could not say time' },
  { title: 'sendImage()', run: (c) => c.sendImage('logo'), command: 'SEND IMAGE logo', reply: '200 result=-1', error: 'Could not send image' },
  { title: 'sendText()', run: (c) => c.sendText('x'), command: 'SEND TEXT "x"', reply: '200 result=-1', error: 'Could not send text' },
];

describe('commands that succeed', () => {
  for (const c of successes) {
    test(c.title, async () => {
      const { channel, asterisk } = await agi.call();
      const result = pending(c.run(channel));

      await asterisk.expectCommand(c.command, c.reply);

      expect(await result).toEqual(c.expected);
    });
  }
});

describe('commands that fail', () => {
  for (const c of failures) {
    test(c.title, async () => {
      const { channel, asterisk } = await agi.call();
      const result = pending(c.run(channel));

      await asterisk.expectCommand(c.command, c.reply);

      await expect(result).rejects.toThrow(c.error);
    });
  }
});

describe('commands that talk to Asterisk more than once', () => {
  test('streamFile() plays the file, then checks PLAYBACKSTATUS', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.streamFile('hello-world'));

    await asterisk.expectCommand(
      'STREAM FILE hello-world "#"',
      '200 result=0 endpos=12345'
    );
    await asterisk.expectCommand(
      'GET VARIABLE PLAYBACKSTATUS',
      '200 result=1 (SUCCESS)'
    );

    expect(await result).toEqual({ digit: '', endpos: 12345 });
  });

  test('streamFile() returns the digit that interrupted playback', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.streamFile('hello-world', '#*', 2000));

    await asterisk.expectCommand(
      'STREAM FILE hello-world "#*" 2000',
      '200 result=42 endpos=800'
    );
    await asterisk.expectCommand(
      'GET VARIABLE PLAYBACKSTATUS',
      '200 result=1 (SUCCESS)'
    );

    expect(await result).toEqual({ digit: '*', endpos: 800 });
  });

  test('streamFile() throws when PLAYBACKSTATUS is not SUCCESS', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.streamFile('missing'));

    await asterisk.expectCommand(
      'STREAM FILE missing "#"',
      '200 result=0 endpos=0'
    );
    await asterisk.expectCommand(
      'GET VARIABLE PLAYBACKSTATUS',
      '200 result=1 (FAILED)'
    );

    await expect(result).rejects.toThrow('Could not stream file');
  });

  test('streamFile() throws when STREAM FILE fails', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.streamFile('missing'));

    await asterisk.expectCommand(
      'STREAM FILE missing "#"',
      '200 result=-1 endpos=0'
    );

    await expect(result).rejects.toThrow('Could not stream file');
  });

  for (const [status, expected] of [
    ['SUCCESS', PlaybackStatus.SUCCESS],
    ['USERSTOPPED', PlaybackStatus.USER_STOPPED],
    ['REMOTESTOPPED', PlaybackStatus.REMOTE_STOPPED],
    ['ERROR', PlaybackStatus.ERROR],
  ] as const) {
    test(`controlStreamFile() maps CPLAYBACKSTATUS ${status}`, async () => {
      const { channel, asterisk } = await agi.call();
      const result = pending(
        channel.controlStreamFile('menu', '#', 3000, '6', '4', '5')
      );

      await asterisk.expectCommand(
        'CONTROL STREAM FILE menu "#" 3000 6 4 5',
        '200 result=35'
      );
      await asterisk.expectCommand(
        'GET VARIABLE CPLAYBACKSTATUS',
        `200 result=1 (${status})`
      );
      await asterisk.expectCommand(
        'GET VARIABLE CPLAYBACKOFFSET',
        '200 result=1 (4200)'
      );

      expect(await result).toEqual({
        digit: '#',
        playbackStatus: expected,
        playbackOffset: 4200,
      });
    });
  }

  test('controlStreamFile() with defaults', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.controlStreamFile('menu'));

    await asterisk.expectCommand('CONTROL STREAM FILE menu ""', '200 result=0');
    await asterisk.expectCommand(
      'GET VARIABLE CPLAYBACKSTATUS',
      '200 result=1 (SUCCESS)'
    );
    await asterisk.expectCommand(
      'GET VARIABLE CPLAYBACKOFFSET',
      '200 result=1 (0)'
    );

    expect(await result).toEqual({
      digit: '',
      playbackStatus: PlaybackStatus.SUCCESS,
      playbackOffset: 0,
    });
  });

  test('controlStreamFile() throws when the command fails', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.controlStreamFile('menu'));

    await asterisk.expectCommand(
      'CONTROL STREAM FILE menu ""',
      '200 result=-1'
    );

    await expect(result).rejects.toThrow('Could not control stream file');
  });

  for (const [status, expected] of [
    ['ANSWER', DialStatus.ANSWER],
    ['BUSY', DialStatus.BUSY],
    ['NOANSWER', DialStatus.NOANSWER],
    ['CANCEL', DialStatus.CANCEL],
    ['CONGESTION', DialStatus.CONGESTION],
    ['CHANUNAVAIL', DialStatus.CHANUNAVAIL],
    ['DONTCALL', DialStatus.DONTCALL],
    ['TORTURE', DialStatus.TORTURE],
    ['INVALIDARGS', DialStatus.INVALIDARGS],
  ] as const) {
    test(`dial() maps DIALSTATUS ${status}`, async () => {
      const { channel, asterisk } = await agi.call();
      const result = pending(channel.dial('PJSIP/2000', 20, 'tT'));

      await asterisk.expectCommand(
        'EXEC Dial PJSIP/2000,20,tT',
        '200 result=0'
      );
      await asterisk.expectCommand(
        'GET VARIABLE DIALSTATUS',
        `200 result=1 (${status})`
      );

      expect(await result).toBe(expected);
    });
  }

  test('dial() with defaults', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.dial('PJSIP/2000'));

    await asterisk.expectCommand('EXEC Dial PJSIP/2000,30,', '200 result=0');
    await asterisk.expectCommand(
      'GET VARIABLE DIALSTATUS',
      '200 result=1 (ANSWER)'
    );

    expect(await result).toBe(DialStatus.ANSWER);
  });

  test('dial() throws on an unknown DIALSTATUS', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.dial('PJSIP/2000'));

    await asterisk.expectCommand('EXEC Dial PJSIP/2000,30,', '200 result=0');
    await asterisk.expectCommand(
      'GET VARIABLE DIALSTATUS',
      '200 result=1 (SOMETHING)'
    );

    await expect(result).rejects.toThrow('Unknown dial status');
  });

  test('break() interrupts async AGI and closes the connection', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.break());

    await asterisk.expectCommand('ASYNCAGI BREAK', '200 result=0');

    expect(await result).toBeUndefined();
    await asterisk.closed;
  });

  test('break() throws when Asterisk refuses', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.break());

    await asterisk.expectCommand('ASYNCAGI BREAK', '200 result=-1');

    await expect(result).rejects.toThrow('Could not interrupt processing');
  });
});

describe('getData() with an inter-digit timeout', () => {
  test('collects a digit pressed during the prompt, then the rest one by one', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.getData('enter-account', 10000, 3, 3000));

    await asterisk.expectCommand(
      'STREAM FILE enter-account "0123456789*#"',
      '200 result=49 endpos=1000'
    );
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=50');
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=51');

    expect(await result).toEqual({ digits: '123', timeout: false });
  });

  test('returns what was collected when the caller stops typing', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.getData('enter-account', 10000, 4, 3000));

    await asterisk.expectCommand(
      'STREAM FILE enter-account "0123456789*#"',
      '200 result=0 endpos=5000'
    );
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=55');
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=0');

    expect(await result).toEqual({ digits: '7', timeout: false });
  });

  test('reports a timeout when no digit arrives at all', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.getData('enter-account', 10000, 4, 3000));

    await asterisk.expectCommand(
      'STREAM FILE enter-account "0123456789*#"',
      '200 result=0 endpos=5000'
    );
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=0');

    expect(await result).toEqual({ digits: '', timeout: true });
  });

  test('a prompt that fails to play does not stop digit collection', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.getData('missing', 10000, 2, 3000));

    await asterisk.expectCommand(
      'STREAM FILE missing "0123456789*#"',
      '200 result=-1 endpos=0'
    );
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=56');
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=57');

    expect(await result).toEqual({ digits: '89', timeout: false });
  });

  test('a failing WAIT FOR DIGIT ends collection as a timeout', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.getData('enter-account', 10000, 3, 3000));

    await asterisk.expectCommand(
      'STREAM FILE enter-account "0123456789*#"',
      '200 result=49 endpos=1000'
    );
    await asterisk.expectCommand('WAIT FOR DIGIT 3000', '200 result=-1');

    expect(await result).toEqual({ digits: '1', timeout: true });
  });

  test('maxDigits of 1 uses a plain GET DATA', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.getData('confirm', 4000, 1, 3000));

    await asterisk.expectCommand('GET DATA confirm 4000 1', '200 result=1');

    expect(await result).toEqual({ digits: '1', timeout: false });
  });
});

describe('speech commands return the raw response', () => {
  test('create, set, load, activate, recognize, deactivate, unload, destroy', async () => {
    const { channel, asterisk } = await agi.call();

    const steps: [() => Promise<{ code: number; result: number }>, string][] = [
      [() => channel.speechCreate('lumenvox'), 'SPEECH CREATE ENGINE lumenvox'],
      [
        () => channel.speechSet('confidence', '500'),
        'SPEECH SET confidence 500',
      ],
      [
        () => channel.speechLoadGrammar('yesno', '/grammars/yesno.gram'),
        'SPEECH LOAD GRAMMAR yesno /grammars/yesno.gram',
      ],
      [
        () => channel.speechActivateGrammar('yesno'),
        'SPEECH ACTIVATE GRAMMAR yesno',
      ],
      [
        () => channel.speechDeactivateGrammar('yesno'),
        'SPEECH DEACTIVATE GRAMMAR yesno',
      ],
      [
        () => channel.speedUnloadGrammar('yesno'),
        'SPEECH UNLOAD GRAMMAR yesno',
      ],
      [() => channel.speechDestroy(), 'SPEECH DESTROY'],
    ];

    for (const [run, command] of steps) {
      const result = pending(run());
      await asterisk.expectCommand(command, '200 result=1');
      expect(await result).toMatchObject({ code: 200, result: 1 });
    }
  });

  test('speechRecognize() exposes the recognition results through response arguments', async () => {
    const { channel, asterisk } = await agi.call();
    const result = pending(channel.speechRecognize('say-yes-or-no', 5, 0));

    await asterisk.expectCommand(
      'SPEECH RECOGNIZE say-yes-or-no 5000 0',
      '200 result=1 (speech) endpos=0 results=1 score0=950 text0=yes grammar0=yesno'
    );

    const response = await result;
    expect(response.code).toBe(200);
    expect(response.result).toBe(1);
    expect(response.arguments.boolean('speech')).toBe(true);
    expect(response.arguments.number('results')).toBe(1);
    expect(response.arguments.number('score0')).toBe(950);
    expect(response.arguments.string('text0')).toBe('yes');
    expect(response.arguments.string('grammar0')).toBe('yesno');
    expect(response.arguments.string('missing')).toBe('');
    expect(response.arguments.number('missing')).toBe(0);
    expect(response.arguments.boolean('missing')).toBe(false);
    expect(response.arguments.nokey()).toBe('speech');
  });
});
