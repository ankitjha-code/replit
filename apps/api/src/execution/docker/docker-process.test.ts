import { describe, expect, it } from 'vitest';
import { createDemultiplexer } from './docker-process.js';
import type { ProcessOutput } from '../provider.js';

function frame(stream: 'stdout' | 'stderr', text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt8(stream === 'stderr' ? 2 : 1, 0);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function collect(chunks: Buffer[]): ProcessOutput[] {
  const seen: ProcessOutput[] = [];
  const demultiplex = createDemultiplexer((output) => seen.push(output));
  for (const chunk of chunks) demultiplex(chunk);
  return seen;
}

const text = (output: ProcessOutput) => Buffer.from(output.chunk).toString('utf8');

describe('reading framed output', () => {
  it('separates the two streams', () => {
    const seen = collect([frame('stdout', 'listening\n'), frame('stderr', 'a warning\n')]);

    expect(seen.map((output) => [output.stream, text(output)])).toEqual([
      ['stdout', 'listening\n'],
      ['stderr', 'a warning\n'],
    ]);
  });

  it('reads several frames out of one chunk', () => {
    const seen = collect([Buffer.concat([frame('stdout', 'a'), frame('stdout', 'b')])]);
    expect(seen.map(text)).toEqual(['a', 'b']);
  });

  it('waits when a header arrives split', () => {
    const whole = frame('stdout', 'hello');
    const seen = collect([whole.subarray(0, 3), whole.subarray(3)]);

    expect(seen.map(text)).toEqual(['hello']);
  });

  it('waits when a payload arrives split', () => {
    const whole = frame('stdout', 'a long line of output');
    const seen = collect([whole.subarray(0, 12), whole.subarray(12)]);

    expect(seen.map(text)).toEqual(['a long line of output']);
  });

  it('waits for a frame that has not finished arriving', () => {
    const whole = frame('stdout', 'incomplete');
    expect(collect([whole.subarray(0, whole.length - 2)])).toEqual([]);
  });

  it('emits nothing for an empty frame', () => {
    expect(collect([frame('stdout', '')])).toEqual([]);
  });

  it('does not join a partial frame to the next one', () => {
    const first = frame('stdout', 'one');
    const second = frame('stderr', 'two');
    const seen = collect([Buffer.concat([first, second.subarray(0, 4)]), second.subarray(4)]);

    expect(seen.map((output) => [output.stream, text(output)])).toEqual([
      ['stdout', 'one'],
      ['stderr', 'two'],
    ]);
  });

  it('carries bytes it cannot decode, unchanged', () => {
    const payload = Buffer.from([0xe2, 0x9c]);
    const header = Buffer.alloc(8);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(payload.length, 4);

    const seen = collect([Buffer.concat([header, payload])]);
    expect(Buffer.from(seen[0]!.chunk)).toEqual(payload);
  });
});
