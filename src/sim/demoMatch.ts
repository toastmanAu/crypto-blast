/**
 * A scripted demo match, shared by the replay test and the replay CLI so both
 * exercise the exact same input sequence. Covers every sim path: raise aim,
 * charge, fire, flight, detonation (terrain carve + wind re-roll), then settle.
 */
import { TickInput } from './World';
import { GameTape, createTape, recordTick } from './tape';

const idle: TickInput = {
  aimUp: false, aimDown: false, fireHeld: false, firePressed: false, fireReleased: false,
};
const mk = (over: Partial<TickInput>): TickInput => ({ ...idle, ...over });

export function demoInputs(): TickInput[] {
  const inputs: TickInput[] = [];
  for (let t = 0; t < 12; t++) inputs.push(mk({ aimUp: true })); // raise angle
  inputs.push(mk({ firePressed: true, fireHeld: true })); // begin charge
  for (let t = 0; t < 40; t++) inputs.push(mk({ fireHeld: true })); // hold to charge
  inputs.push(mk({ fireReleased: true })); // launch
  for (let t = 0; t < 250; t++) inputs.push(idle); // flight + detonation + settle
  return inputs;
}

export function demoTape(seed: number, width: number, height: number): GameTape {
  const tape = createTape(seed, width, height);
  for (const input of demoInputs()) recordTick(tape, input);
  return tape;
}

/** Two full turns: team 0 fires, settles, team 1 fires. Exercises the turn handoff. */
export function turnLoopInputs(): TickInput[] {
  const inputs: TickInput[] = [];
  const fireOnce = (): void => {
    for (let t = 0; t < 10; t++) inputs.push(mk({ aimUp: true }));
    inputs.push(mk({ firePressed: true, fireHeld: true }));
    for (let t = 0; t < 30; t++) inputs.push(mk({ fireHeld: true }));
    inputs.push(mk({ fireReleased: true }));
    for (let t = 0; t < 500; t++) inputs.push(idle); // flight + settle + handoff
  };
  fireOnce(); // team 0
  fireOnce(); // team 1
  return inputs;
}

/** Select watermelon (index 3), aim, charge, fire — exercises the selectWeapon path. */
export function selectThenFireInputs(): TickInput[] {
  const inputs: TickInput[] = [];
  inputs.push(mk({ selectWeapon: 3 }));            // confirm a selection on tick 0
  for (let t = 0; t < 10; t++) inputs.push(mk({ aimUp: true }));
  inputs.push(mk({ firePressed: true, fireHeld: true }));
  for (let t = 0; t < 30; t++) inputs.push(mk({ fireHeld: true }));
  inputs.push(mk({ fireReleased: true }));
  for (let t = 0; t < 250; t++) inputs.push(idle);
  return inputs;
}
