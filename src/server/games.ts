export interface GameEntry {
  name: string;
  aliases: string[];
  tags: string[];
}

export const GAMES: GameEntry[] = [
  { name: 'Grand Theft Auto VI', aliases: ['gta 6', 'gta6', 'gta vi', 'grand theft auto 6', 'grand theft auto vi'], tags: ['GTA6', 'GrandTheftAuto'] },
  { name: 'Grand Theft Auto V', aliases: ['gta 5', 'gta5', 'gta v', 'gta rp', 'gtarp', 'grand theft auto v', 'grand theft auto 5', 'fivem'], tags: ['GTA5', 'GTARP', 'GTA'] },
  { name: 'Grand Theft Auto: San Andreas', aliases: ['grand theft auto san andreas', 'gta sa'], tags: ['GTA', 'SanAndreas'] },
  { name: 'Valorant', aliases: ['valorant', 'valo'], tags: ['Valorant', 'ValClips'] },
  { name: 'Counter-Strike 2', aliases: ['counter-strike 2', 'counter strike 2', 'cs2', 'csgo', 'cs:go'], tags: ['CS2', 'CounterStrike'] },
  { name: 'Fortnite', aliases: ['fortnite'], tags: ['Fortnite', 'FortniteClips'] },
  { name: 'Minecraft', aliases: ['minecraft', 'mc'], tags: ['Minecraft', 'MinecraftClips'] },
  { name: 'League of Legends', aliases: ['league of legends', 'lol'], tags: ['LeagueOfLegends', 'LoL'] },
  { name: 'Call of Duty: Warzone', aliases: ['warzone', 'cod warzone', 'call of duty', 'black ops 6', 'bo6', 'mw3'], tags: ['Warzone', 'CallOfDuty', 'COD'] },
  { name: 'Elden Ring', aliases: ['elden ring', 'shadow of the erdtree'], tags: ['EldenRing', 'FromSoftware'] },
  { name: 'Roblox', aliases: ['roblox'], tags: ['Roblox', 'RobloxClips'] },
  { name: 'Helldivers 2', aliases: ['helldivers 2', 'helldivers2'], tags: ['Helldivers2', 'StarshipTroopers', 'CoOp'] },
  { name: 'Cyberpunk 2077', aliases: ['cyberpunk 2077', 'cyberpunk'], tags: ['Cyberpunk2077', 'NightCity'] },
  { name: 'Starfield', aliases: ['starfield'], tags: ['Starfield', 'Bethesda'] },
  { name: 'Black Myth Wukong', aliases: ['black myth', 'wukong'], tags: ['BlackMythWukong', 'ActionRPG'] },
  { name: 'Marvel Rivals', aliases: ['marvel rivals'], tags: ['MarvelRivals', 'Heroes'] },
  { name: 'Overwatch 2', aliases: ['overwatch 2', 'overwatch'], tags: ['Overwatch2', 'OW2', 'Blizzard'] },
  { name: 'ARK', aliases: ['ark: survival', 'ark survival'], tags: ['ARK', 'Survival'] },
  { name: 'Dead by Daylight', aliases: ['dead by daylight'], tags: ['DeadByDaylight', 'Asymmetric'] },
  { name: 'Rocket League', aliases: ['rocket league'], tags: ['RocketLeague', 'CarSports'] },
  { name: 'Apex Legends', aliases: ['apex legends'], tags: ['ApexLegends', 'Apex'] },
  { name: 'PUBG', aliases: ['pubg', 'playerunknown'], tags: ['PUBG', 'BattleRoyale'] },
];

export const GENERIC_TAGS = ['Gaming', 'Gameplay', 'GamingClips', 'StreamHighlights'];

const ALIASES = GAMES.flatMap((g) => g.aliases.map((alias) => ({ alias, name: g.name, tags: g.tags }))).sort(
  (a, b) => b.alias.length - a.alias.length,
);

function norm(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectGame(...texts: Array<string | null | undefined>): [string | null, string[]] {
  const hay = norm(texts.filter(Boolean).join(' '));
  if (!hay) return [null, []];
  for (const item of ALIASES) {
    const pattern = new RegExp(`(?:^| )${escapeRe(norm(item.alias))}(?: |$)`);
    if (pattern.test(hay)) {
      return [item.name, [...item.tags]];
    }
  }
  return [null, []];
}

export function nameOfGame(game: string | null | undefined): string {
  if (!game) return '';
  const g = norm(game);
  for (const entry of GAMES) {
    if (g === norm(entry.name) || entry.aliases.some((a) => norm(a) === g)) {
      return entry.name;
    }
  }
  return String(game).slice(0, 40);
}

export function tagsOfGame(game: string | null | undefined): string[] {
  if (!game) return [];
  const g = norm(game);
  for (const entry of GAMES) {
    if (
      g === norm(entry.name) ||
      entry.aliases.some((a) => norm(a) === g) ||
      entry.tags.some((t) => norm(t) === g)
    ) {
      return [...entry.tags];
    }
  }
  const clean = String(game).replace(/\W/g, '').slice(0, 30);
  return clean ? [clean] : [];
}
