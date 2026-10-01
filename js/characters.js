// Species catalog. Small on purpose — the GDD's MVP
// (section 41) explicitly says the first build doesn't need 500 characters,
// just enough to prove the hunting loop is fun.
//
// habitat tags drive which flavour clues the scanner reveals as the player
// gets closer (GDD section 30 "Mystery Characters" / section 5 "Behaviour").

export const RARITY = {
  common: { label: 'Common', weight: 50, color: '#5fd07a' },
  uncommon: { label: 'Uncommon', weight: 28, color: '#4fa3e3' },
  rare: { label: 'Rare', weight: 15, color: '#b07de0' },
  epic: { label: 'Epic', weight: 6, color: '#e3934f' },
  legendary: { label: 'Legendary', weight: 1, color: '#e3c94f' },
};

const ART = './assets/creatures/';

/**
 * Build a 3-stage evolution line. Art files follow one convention:
 *   assets/creatures/<id>-<stage>.webp  (+ <id>-<stage>-thumb.webp)
 * Each entry: [form name, captures required to unlock, lore].
 */
function line(id, forms) {
  return forms.map(([form, requiresCaptures, lore], i) => ({
    stage: i + 1,
    form,
    art: `${ART}${id}-${i + 1}.webp`,
    thumb: `${ART}${id}-${i + 1}-thumb.webp`,
    requiresCaptures,
    lore,
  }));
}

// The roster: only creatures with full concept art from the
// stitch_dark_folklore_creature_evolutions zips. Every species has a 3-stage
// evolution line; wild spawns are always stage 1, later forms unlock by
// re-capturing the species and pressing Evolve in its Journal dossier.
// Rarity + habitat are spread so every scanner habitat (urban, trees,
// water, night) and every rarity tier is covered (GDD §5, §30).
export const SPECIES = [
  {
    id: 'domovoy',
    name: 'Domovoy',
    rarity: 'common',
    behavior: 'stationary',
    habitat: 'urban',
    lore: 'A household spirit of Slavic folklore. It keeps the hearth lit and the home safe — for those who leave it bread.',
    clues: ['It smells of woodsmoke.', 'It likes homes and hearths.', 'Something small is keeping watch.'],
    evolution: line('domovoy', [
      ['Hearth Wisp', 1, 'A tiny, moss-cloaked elder who crouches by the fire and hoards crusts of bread. Easily startled, fiercely loyal.'],
      ['Hearth Sentinel', 3, 'Custos Foci — the rune-armoured guardian of the threshold, lantern in one hand and fire-iron in the other.'],
      ['The Ancestral', 7, 'A towering spirit of root and timber with a village for a crown, holding a ward of light over every home in its care.'],
    ]),
  },
  {
    id: 'wulver',
    name: 'The Wulver',
    rarity: 'common',
    behavior: 'stationary',
    habitat: 'trees',
    lore: 'A wolf-headed man of Shetland legend. Gentle despite its looks — it leaves fish on the windowsills of the poor.',
    clues: ['It likes wild, open ground.', 'Something left a fish behind.', 'It sits very still.'],
    evolution: line('wulver', [
      ['Hearthside Watcher', 1, 'A hunched, cloaked wolf-man perched on a rock above a crofter\'s cottage, a basket of fresh fish at its feet.'],
      ['Cairn Warden', 3, 'Staff and lantern in hand, it stands guard on a heather-covered cairn, watching the mist for lost travellers.'],
      ['Sovereign of the Mist', 7, 'A vast, antlered spirit-wolf of fog and moonlight, raising a ward of light over the coastal villages below.'],
    ]),
  },
  {
    id: 'leprechaun',
    name: 'The Leprechaun',
    rarity: 'uncommon',
    behavior: 'wanderer',
    habitat: 'trees',
    lore: 'A solitary Irish fairy-cobbler with a buried crock of gold. Catch his eye and he cannot vanish — look away and he is gone.',
    clues: ['It likes old roots and hollows.', 'You hear a tiny hammer tapping.', 'It never stays in one place.'],
    evolution: line('leprechaun', [
      ['Barrow Cobbler', 1, 'Hunched among the roots of an ancient tree, stitching a single shoe beside a smouldering pipe and a small clay pot.'],
      ['Gold Warden', 3, 'A hooded wanderer in leather and bandoliers, lantern lit, guarding the path to a hoard only he can find.'],
      ['The Hoard King', 6, 'Enthroned in a cavern of carved stone and spilling gold, crowned in oak leaves, his hammer resting across his knee.'],
    ]),
  },
  {
    id: 'rusalka',
    name: 'Rusalka',
    rarity: 'uncommon',
    behavior: 'wanderer',
    habitat: 'night',
    lore: 'A drowned river-spirit of Slavic legend. On moonlit nights she sits in the willows, singing travellers towards the water.',
    clues: ['It was detected after dark.', 'Faint singing, somewhere close.', 'The willows lean towards it.'],
    evolution: line('rusalka', [
      ['Drowned Willow Maid', 1, 'A pale, river-soaked figure crouched on a fallen willow, ghost-light curling around her like mist off the water.'],
      ['The Murk-Siren', 3, 'A ragged, eel-bodied horror of black weed and bone, dragging a rusted cage up from the riverbed.'],
      ['Mora-Abyssia', 6, 'Sovereign of the Black Flood — a crowned leviathan-empress rising under a blood-red eclipse, her tentacles coiled through drowned ruins.'],
    ]),
  },
  {
    id: 'naga',
    name: 'Naga',
    rarity: 'rare',
    behavior: 'stationary',
    habitat: 'water',
    lore: 'A serpent spirit of the sacred rivers of South and South-East Asian myth — guardian of springs, temples and hidden treasure.',
    clues: ['It likes water.', 'Something is coiled and waiting.', 'The air smells of rain and lotus.'],
    evolution: line('naga', [
      ['The Lotus Coil', 1, 'Serpens Fluminis — a temple-river hatchling coiled in a carved stone lotus, hood flared, watching.'],
      ['Monsoon Sentinel', 2, 'A serpent-bodied guardian in temple armour, trident raised, summoning the monsoon over its flooded shrine.'],
      ['Ananta Shesha', 4, 'The endless serpent — a crowned, many-headed king rising from the temple waters beneath a sky full of stars.'],
    ]),
  },
  {
    id: 'blue-men',
    name: 'Blue Men of the Minch',
    rarity: 'epic',
    behavior: 'wanderer',
    habitat: 'water',
    lore: 'Storm-kin of the Scottish straits. They rise beside passing ships and challenge sailors to finish a rhyme — or be sunk.',
    clues: ['It likes the water.', 'The wind is picking up.', 'You hear a half-finished rhyme.'],
    evolution: line('blue-men', [
      ['Wave-Caller', 1, 'A blue-skinned sea-sprite crouched on a storm-lashed rock, sounding a conch to wake the tide.'],
      ['Storm Reaver', 2, 'A rune-marked warrior of the deep wielding a coral trident, lightning crackling as a ship founders behind him.'],
      ['Chieftain of the Minch', 4, 'An ancient storm-king crowned in coral, holding the whole sea at bay beneath a dome of churning light.'],
    ]),
  },
  {
    id: 'hollow-hart',
    name: 'Hollow Hart',
    rarity: 'legendary',
    behavior: 'wanderer',
    habitat: 'night',
    lore: 'Nobody agrees on what it is. Hunters speak of bone-white antlers in the deep woods, and of the silence that follows them.',
    clues: ['It was detected after dark.', 'Every bird has gone silent.', 'Something enormous is moving.'],
    evolution: line('hollow-hart', [
      ['Hollow Fawn', 1, 'A skeletal, root-wrapped fawn curled asleep in a nest of moss beneath a dead tree. Its ribs glow faintly.'],
      ['Bone Stag', 2, 'An adolescent beast of exposed bone and black hide, antlers smouldering and eyes like coals, stalking the misty woods.'],
      ['The Primeval', 3, 'A colossal antlered titan of dead wood and bone, crowned by a dark eclipse, the forest bowing beneath it.'],
    ]),
  },
];

export function speciesById(id) {
  return SPECIES.find((s) => s.id === id);
}

/** Evolution form for a species at a given stage (1-based), or null if it has no art/evolution line. */
export function formFor(species, stage = 1) {
  if (!species?.evolution) return null;
  const i = Math.max(1, Math.min(stage, species.evolution.length)) - 1;
  return species.evolution[i];
}

export function maxStage(species) {
  return species?.evolution ? species.evolution.length : 1;
}

/** Weighted-random species pick from the spawnable (non-locked) pool. */
export function rollSpecies() {
  const pool = SPECIES.filter((s) => !s.locked);
  const total = pool.reduce((sum, s) => sum + RARITY[s.rarity].weight, 0);
  let roll = Math.random() * total;
  for (const s of pool) {
    roll -= RARITY[s.rarity].weight;
    if (roll <= 0) return s;
  }
  return pool[0];
}
