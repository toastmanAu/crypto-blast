import { ProjectileParams } from '../physics/ProjectilePhysics';

export interface WeaponDef {
  id: string;
  name: string;
  projectile: ProjectileParams;
  blastRadius: number;
  damage: number;
  launchSpeed: number;   // px/s at full power
  ammoStart: number;     // -1 = unlimited
  placeholder?: boolean; // ballistic stand-in; real behaviour is a later phase (P4)
}

export const WEAPONS: Record<string, WeaponDef> = {
  moonShot: {
    id: 'moonShot', name: 'Moon Shot',
    projectile: { mass: 4, gravityScale: 1, drag: 0.02, windSusceptibility: 1 / 4 },
    blastRadius: 42, damage: 45, launchSpeed: 760, ammoStart: -1,
  },
  gasGrenade: {
    id: 'gasGrenade', name: 'Gas Grenade',
    projectile: { mass: 3, gravityScale: 1.05, drag: 0.03, windSusceptibility: 1 / 3 },
    blastRadius: 55, damage: 30, launchSpeed: 620, ammoStart: 3,
  },
  airdropCluster: {
    id: 'airdropCluster', name: 'Airdrop Cluster',
    projectile: { mass: 5, gravityScale: 1, drag: 0.02, windSusceptibility: 1 / 5 },
    blastRadius: 38, damage: 35, launchSpeed: 700, ammoStart: 2,
  },
  watermelonBomb: {
    id: 'watermelonBomb', name: 'Watermelon Bomb',
    projectile: { mass: 6, gravityScale: 1.1, drag: 0.015, windSusceptibility: 1 / 6 },
    blastRadius: 60, damage: 50, launchSpeed: 720, ammoStart: 3,
  },
  llamaBomb: {
    id: 'llamaBomb', name: 'Llama Bomb',
    projectile: { mass: 4, gravityScale: 1, drag: 0.025, windSusceptibility: 1 / 4 },
    blastRadius: 48, damage: 40, launchSpeed: 680, ammoStart: 2,
  },
  bridge: {
    id: 'bridge', name: 'Bridge',
    projectile: { mass: 4, gravityScale: 1, drag: 0.04, windSusceptibility: 1 / 4 },
    blastRadius: 20, damage: 10, launchSpeed: 500, ammoStart: 1, placeholder: true,
  },
};

// Append-only forever: the index is encoded in tapes + hashWorld. Never reorder/remove.
export const WEAPON_ORDER: readonly string[] = [
  'moonShot', 'gasGrenade', 'airdropCluster', 'watermelonBomb', 'llamaBomb', 'bridge',
];

export function weaponAt(index: number): WeaponDef {
  return WEAPONS[WEAPON_ORDER[index]];
}
