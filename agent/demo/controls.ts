/** Terminal keyboard controls for the running match: pause, step, quit. */
import * as readline from 'readline';

export type ControlHandlers = {
  togglePause: () => void;
  step: () => void;
  quit: () => void;
};

/**
 * Wires up single-keypress controls on stdin. Returns a cleanup function that puts the
 * terminal back the way it found it - raw mode swallows Ctrl-C, so `quit` is responsible
 * for calling this.
 *
 * If stdin isn't a TTY (piped, or running under a supervisor) this does nothing and the
 * match simply runs to completion.
 */
export function installKeyboardControls(handlers: ControlHandlers): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return () => {};
  }

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  const onKeypress = (str: string | undefined, key: readline.Key | undefined) => {
    if (key?.ctrl === true && key.name === 'c') {
      handlers.quit();
      return;
    }
    switch (key?.name ?? str) {
    case 'p':
    case 'space':
      handlers.togglePause();
      break;
    case 's':
      handlers.step();
      break;
    case 'q':
      handlers.quit();
      break;
    default:
      break;
    }
  };

  stdin.on('keypress', onKeypress);

  return () => {
    stdin.off('keypress', onKeypress);
    stdin.setRawMode(false);
    stdin.pause();
  };
}
