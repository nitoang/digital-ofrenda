// The first ofrenda a new account starts with: the same basic arrangement as the web component's default,
// with fixed ids so every account begins identically. The owner renames it for the person they remember.
import { RULES } from './rules.mjs';

export const starterState = () => ({
  format: 'digital-ofrenda',
  kind: 'person',
  tiers: 3,
  name: RULES.starterName,
  dates: '',
  items: [
    { id: 'photo-1', type: 'photo', x: 50, y: 24 },
    { id: 'candle-1', type: 'candle', x: 33, y: 30, lit: true },
    { id: 'candle-2', type: 'candle', x: 67, y: 30, lit: true },
    { id: 'marigold-1', type: 'marigold', x: 36, y: 52 },
    { id: 'marigold-2', type: 'marigold', x: 64, y: 52 },
    { id: 'pan-1', type: 'pan', x: 50, y: 54 },
    { id: 'water-1', type: 'water', x: 20, y: 76 },
    { id: 'marigold-3', type: 'marigold', x: 80, y: 76 },
  ],
});
