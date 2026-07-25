import { describe, it, expect } from 'vitest';
import { createWorld, stepWorld } from '../src/sim/World';
import type { WorldState } from '../src/sim/World';
import { AIPlayer } from '../src/ai/AIPlayer';

const W = 1280;
const H = 720;

describe('AIPlayer', () => {
  it('steers, charges, and fires on its turn', () => {
    const w = createWorld(1234, W, H);
    const ai = new AIPlayer();
    let launched = false;
    for (let i = 0; i < 250; i++) {
      const input = ai.nextInput(w);
      stepWorld(w, input);
      if (w.shot) launched = true;
    }
    expect(launched).toBe(true);
  });

  it('is deterministic — same world yields the same input sequence', () => {
    const run = (): string => {
      const w = createWorld(1234, W, H);
      const ai = new AIPlayer();
      const inputs: string[] = [];
      for (let i = 0; i < 200; i++) {
        const input = ai.nextInput(w);
        inputs.push(JSON.stringify(input));
        stepWorld(w, input);
      }
      return inputs.join('|');
    };
    expect(run()).toBe(run());
  });

  it('an AI-vs-AI match reaches a winner', () => {
    const w: WorldState = createWorld(1234, W, H);
    const ai = new AIPlayer();
    let guard = 0;
    while (w.winner === null && guard < 40000) {
      stepWorld(w, ai.nextInput(w));
      guard++;
    }
    expect(w.winner).not.toBeNull();
  }, 60000);
});
