import { ProjectileParams } from '../physics/ProjectilePhysics';

export interface WeaponDef {
  id: string;
  name: string;
  projectile: ProjectileParams;
  blastRadius: number;
  damage: number;        // TODO(P2): applied to ape health in the turn loop
  launchSpeed: number; // px/s at full power
}

export const WEAPONS: Record<string, WeaponDef> = {
  moonShot: {
    id: 'moonShot',
    name: 'Moon Shot',
    // mass 4 -> windSusceptibility 1/4: a medium rocket that drifts a little
    projectile: { mass: 4, gravityScale: 1, drag: 0.02, windSusceptibility: 1 / 4 },
    blastRadius: 42,
    damage: 45,
    launchSpeed: 760,
  },
};
