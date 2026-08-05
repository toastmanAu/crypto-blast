import { describe, it, expect } from 'vitest';
import { WEAPONS, WEAPON_ORDER, weaponAt } from '../src/weapons/weaponData';

describe('weapon data', () => {
  it('has 6 weapons in append-only order, moonShot first', () => {
    expect(WEAPON_ORDER).toEqual([
      'moonShot', 'gasGrenade', 'airdropCluster', 'watermelonBomb', 'llamaBomb', 'bridge',
    ]);
  });

  it('weaponAt resolves an index to its def', () => {
    expect(weaponAt(0).id).toBe('moonShot');
    expect(weaponAt(3).id).toBe('watermelonBomb');
  });

  it('moonShot is unlimited (-1), others finite and positive', () => {
    expect(weaponAt(0).ammoStart).toBe(-1);
    for (let i = 1; i < WEAPON_ORDER.length; i++) {
      expect(weaponAt(i).ammoStart).toBeGreaterThan(0);
    }
  });

  it('every WEAPON_ORDER id exists in WEAPONS with required fields', () => {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      expect(w).toBeDefined();
      expect(w.blastRadius).toBeGreaterThan(0);
      expect(w.launchSpeed).toBeGreaterThan(0);
    }
  });

  it('bridge is a real weapon (the placeholder concept is fully removed)', () => {
    const bridge = weaponAt(5);
    expect(bridge.id).toBe('bridge');
    expect(bridge.blastRadius).toBeGreaterThan(0);
    expect(bridge.launchSpeed).toBeGreaterThan(0);
    // No `placeholder` field exists on WeaponDef anymore — all behaviours shipped.
    expect('placeholder' in bridge).toBe(false);
  });
});
