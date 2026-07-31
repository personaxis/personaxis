/**
 * The aura's part bank.
 *
 * Design constraints this bank exists to satisfy, each one learned from a portrait that
 * failed to read as a face:
 *
 *   A face needs all of its features. Dropping the nose to flatten the head was the wrong
 *   trade: a head is flattened by making it WIDER, not by deleting features. The face
 *   interior is seven columns so brows, eyes, nose and mouth all fit.
 *
 *   Ears and hair are separate slots. Ears sit either side of the eye row, where ears
 *   actually are; hair has two parts, the crown on top and side locks down the temples.
 *
 *   The neck is its own row. Without it the head reads as glued to the torso.
 *
 *   Breathing has to change a SHAPE to be visible. The breath changes the torso's width
 *   (9 <-> 7) rather than nudging a couple of shoulder glyphs in place.
 *
 * Every glyph occupies exactly one column: a double-width character would shift the row
 * and break the figure. Two archetypes, human and android, with separate banks.
 */

export type Archetype = "human" | "android";

/**
 * The face interior is SEVEN columns: wide enough to flatten the head while keeping
 * brows, eyes, nose and mouth, with the eyes still one column apart.
 */
export const FACE_W = 7;

export interface PartBank {
  /** Hair or helmet on top of the head, 9 columns. */
  crowns: string[];
  /**
   * Side locks down the temples as [resting, swayed], 1 column each, or [" ", " "] for a
   * persona with no side hair. They are PAIRED rather than drawn independently because
   * two unrelated glyphs (a dotted lock becoming a double bar) read as the persona
   * changing hairstyle between frames; a pair of neighbours reads as hair moving.
   */
  locks: Array<[string, string]>;
  /** Ears (or sensors), [left, right], drawn outside the eye row. */
  ears: Array<[string, string]>;
  /** Brow row, 7 columns. */
  brows: string[];
  /** Eye row, 7 columns. */
  eyes: string[];
  /** Closed lids, 7 columns. */
  lids: string[];
  /** Nose row, 7 columns. */
  noses: string[];
  /** Mouth row, 7 columns. */
  mouths: string[];
  /** Jaw, 9 columns. */
  jaws: string[];
  /** Neck, 3 columns: what keeps the head off the shoulders. */
  necks: string[];
  /** Shoulder line, 11 columns, solid. */
  shoulders: string[];
  /** Torso fill, 9 columns when relaxed (the breath narrows it to 7). */
  fills: string[];
  /** A small orbiting mark. */
  sparks: string[];
}

export const HUMAN: PartBank = {
  crowns: [
    "▁▃▄▄▄▄▄▃▁",
    "▄▄▄▄▄▄▄▄▄",
    "▗▄▟▓▓▓▙▄▖",
    "╱▔▔▔▔▔▔▔╲",
    "▂▄▆▆▆▆▆▄▂",
    "░▒▓▓▓▓▓▒░",
    "▁▂▃▃▃▃▃▂▁",
    "▄▟▓▓▓▓▓▙▄",
    "▗▛▀▀▀▀▀▜▖",
    "◜◝◝◝◝◝◝◝◜",
  ],
  locks: [
    [" ", " "],
    ["▏", "▎"],
    ["▎", "▏"],
    ["╎", "┆"],
    ["┆", "╎"],
    ["▕", "▏"],
    ["┊", "┆"],
    ["╷", "╵"],
  ],
  ears: [
    [" ", " "],
    ["(", ")"],
    ["⊂", "⊃"],
    ["╰", "╯"],
    ["˂", "˃"],
    ["ᐸ", "ᐳ"],
  ],
  brows: ["  ╌ ╌  ", "  ─ ─  ", "  ╍ ╍  ", "  ╲ ╱  ", "  ╱ ╲  ", "  ▁ ▁  ", "  ▔ ▔  ", " ╌╌ ╌╌ "],
  eyes: ["  ◕ ◕  ", "  ● ●  ", "  ◉ ◉  ", "  ⊙ ⊙  ", "  ʘ ʘ  ", "  ◑ ◐  ", "  ◔ ◔  ", "  ◍ ◍  ", "  ❍ ❍  ", "  ⦿ ⦿  ", "  ʚ ɞ  ", "  ◠ ◠  "],
  lids: ["  ‿ ‿  ", "  ⌣ ⌣  ", "  ▁ ▁  ", "  ᵕ ᵕ  "],
  noses: ["   ▽   ", "   ᵥ   ", "   ⌄   ", "   ╵   ", "   ◡   ", "   ʌ   ", "   ᴗ   ", "   ⌐   "],
  mouths: ["  ───  ", "  ‿‿‿  ", "  ▁▁▁  ", "   ω   ", "  ◡◡◡  ", "  ᵕᵕᵕ  ", "  ╰─╯  ", "  ▂▂▂  ", "  ◠◠◠  ", "  ═══  "],
  jaws: ["╰───┬───╯", "╲───┬───╱", "▝▄▄▄┬▄▄▄▘", "╰▁▁▁┬▁▁▁╯", "▚───┬───▞"],
  necks: ["▐█▌", "▐▓▌", "║█║", "╎█╎", "▕█▏", "▐▒▌"],
  shoulders: ["▄▟███████▙▄", "▗▄▟█████▙▄▖", "▄▟▓▓▓▓▓▓▓▙▄", "▗▄▛▀▀▀▀▀▜▄▖", "▄▟█▓█▓█▓█▙▄", "▗▟███████▙▖"],
  fills: ["█████████", "▓▓▓▓▓▓▓▓▓", "▒▒▒▒▒▒▒▒▒", "█▓█▓█▓█▓█", "▓███████▓", "░▒▓▓▓▓▓▒░"],
  sparks: ["·", "˚", "✦", "✧", "◦", "⋆", "°", "∙"],
};

export const ANDROID: PartBank = {
  crowns: [
    "╔═══════╗",
    "▛▀▀▀▀▀▀▀▜",
    "┏━━━━━━━┓",
    "▗▄▄▄▄▄▄▄▖",
    "╭╌╌╌╌╌╌╌╮",
    "█▀▀▀▀▀▀▀█",
    "▟▀▀▀▀▀▀▀▙",
    "◤▔▔▔▔▔▔▔◥",
    "╒═══════╕",
    "▚▀▀▀▀▀▀▀▞",
  ],
  locks: [
    [" ", " "],
    ["║", "▏"],
    ["┃", "▏"],
    ["▐", "▕"],
    ["╎", "┇"],
    ["┇", "╎"],
    ["▌", "▎"],
    ["╿", "╽"],
  ],
  ears: [
    [" ", " "],
    ["◄", "►"],
    ["▌", "▐"],
    ["┫", "┣"],
    ["╡", "╞"],
    ["▪", "▪"],
  ],
  brows: ["  ▬ ▬  ", "  ═ ═  ", "  ▭ ▭  ", "  ▀ ▀  ", "  ─ ─  ", " ▬▬ ▬▬ "],
  eyes: ["  ◙ ◙  ", "  ▣ ▣  ", "  ◫ ◫  ", "  ▰ ▰  ", "  ⊡ ⊡  ", "  ▨ ▨  ", "  ◈ ◈  ", "  ⬖ ⬗  ", "  ▮ ▮  ", "  ◘ ◘  ", "  ⊞ ⊞  ", "  ▪ ▪  "],
  lids: ["  ▬ ▬  ", "  ─ ─  ", "  ▁ ▁  ", "  ▪ ▪  "],
  noses: ["   ▬   ", "   ┅   ", "   ▪   ", "   ╹   ", "   ⌗   ", "   ▫   "],
  mouths: ["  ▭▭▭  ", "  ▬▬▬  ", "  ═══  ", "  ┅┅┅  ", "  ▤▤▤  ", "  ░░░  ", "  ▪▪▪  ", "  ▁▁▁  "],
  jaws: ["╚═══╤═══╝", "▙▄▄▄┬▄▄▄▟", "┗━━━┳━━━┛", "▚▄▄▄┬▄▄▄▞", "╰───┬───╯"],
  necks: ["▐█▌", "║█║", "╪█╪", "┃█┃", "▐▓▌", "╎█╎"],
  shoulders: ["▄▟███████▙▄", "▗▄▟█▓█▓█▙▄▖", "▄▟███████▙▄", "▗▄▛▀▀▀▀▀▜▄▖", "▟█▚▚▚▚▚▚▚█▙", "▗▄███████▄▖"],
  fills: ["█████████", "█▓█▓█▓█▓█", "▓▓▓▓▓▓▓▓▓", "█▚▚▚▚▚▚▚█", "▓░▓░▓░▓░▓", "███▓▓▓███"],
  sparks: ["▪", "·", "⌁", "◦", "▫", "˚", "∙", "⋆"],
};

export const BANKS: Record<Archetype, PartBank> = { human: HUMAN, android: ANDROID };

/** Distinct portraits a bank can compose. */
export function bankCombinations(b: PartBank): number {
  return (
    b.crowns.length *
    b.locks.length *
    b.ears.length *
    b.brows.length *
    b.eyes.length *
    b.noses.length *
    b.mouths.length *
    b.jaws.length *
    b.necks.length *
    b.shoulders.length *
    b.fills.length *
    b.sparks.length
  );
}
