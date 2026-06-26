import Phaser from 'phaser';

/**
 * Map a direction vector (screen coords, +y down) to the nearest of `count`
 * radial slots laid out CLOCKWISE starting at straight up (slot 0). Pure.
 */
export function slotFromAngle(dx: number, dy: number, count: number): number {
  // angle clockwise from "up": up=(0,-1)->0, right=(1,0)->PI/2, etc.
  let a = Math.atan2(dx, -dy);           // 0 at up, +clockwise
  if (a < 0) a += Math.PI * 2;
  const slot = Math.round(a / ((Math.PI * 2) / count)) % count;
  return slot;
}

const RADIUS = 120;
const ICON_SIZE = 56;

export class WeaponWheel {
  private container: Phaser.GameObjects.Container;
  private icons: Phaser.GameObjects.Image[] = [];
  private counts: Phaser.GameObjects.Text[] = [];
  private open_ = false;

  constructor(scene: Phaser.Scene, iconKeys: string[]) {
    this.container = scene.add.container(0, 0).setDepth(1000).setVisible(false);
    const n = iconKeys.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;       // slot 0 at top, clockwise
      const x = Math.sin(a) * RADIUS;
      const y = -Math.cos(a) * RADIUS;
      const icon = scene.add.image(x, y, iconKeys[i]);
      icon.setDisplaySize(ICON_SIZE, ICON_SIZE);
      const label = scene.add.text(x, y + ICON_SIZE / 2, '', {
        color: '#ffffff', fontSize: '14px',
      }).setOrigin(0.5, 0);
      this.icons.push(icon);
      this.counts.push(label);
      this.container.add(icon);
      this.container.add(label);
    }
  }

  get isOpen(): boolean { return this.open_; }

  open(cx: number, cy: number): void {
    this.container.setPosition(cx, cy).setVisible(true);
    this.open_ = true;
  }

  close(): void {
    this.container.setVisible(false);
    this.open_ = false;
  }

  /** Redraw highlight ring + ammo counts. ammo: number[] for the active team. */
  update(highlight: number, ammo: number[], selected: number): void {
    for (let i = 0; i < this.icons.length; i++) {
      const empty = ammo[i] === 0;
      const isHi = i === highlight;
      this.icons[i].setAlpha(empty ? 0.3 : 1)
        .setScale(isHi ? 1.0 : 0.82)
        .setTint(i === selected ? 0x66ff99 : 0xffffff);
      this.counts[i].setText(ammo[i] < 0 ? '∞' : String(ammo[i]));
    }
  }
}
