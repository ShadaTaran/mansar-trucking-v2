import { createInterface } from 'node:readline';

/** Minimal terminal I/O the CLI needs; injectable for tests. */
export interface PromptIo {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WriteStream;
}

/** Echoed line input (e.g. an email address). */
export function readLine(io: PromptIo, question: string): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Non-echoing input for secrets. Requires a real TTY (raw mode) so the value
 * is never echoed by a line-buffered terminal; refuses to run otherwise.
 */
export function readHidden(io: PromptIo, question: string): Promise<string> {
  const { input, output } = io;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(
      new Error('hidden input requires an interactive terminal (TTY)'),
    );
  }

  return new Promise((resolve, reject) => {
    const chars: string[] = [];
    const finish = (): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(chars.join(''));
          return;
        }
        if (ch === '' || ch === '') {
          finish();
          reject(new Error('input aborted'));
          return;
        }
        if (ch === '' || ch === '\b') {
          chars.pop();
          continue;
        }
        chars.push(ch);
      }
    };

    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
