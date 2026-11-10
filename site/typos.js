// A mistyped address is the most common reason a sign-in email never arrives: it bounces, or worse, reaches a
// stranger. Before sending, the sign-in page checks for the usual slips in the big providers' names. It only
// ever suggests; the person can still send to exactly what they typed.

const PROVIDERS = ['gmail', 'hotmail', 'yahoo', 'outlook', 'icloud', 'live', 'aol', 'msn', 'proton'];
const WRONG_ENDING = ['con', 'cmo', 'vom', 'xom', 'cm', 'om', 'co', 'comm', 'ocm'];
const MISSPELLED = {
  gmail: ['gmial', 'gmai', 'gnail', 'gmil', 'gamil', 'gmaill', 'gmali', 'gmal', 'gmeil', 'gemail', 'gimail'],
  hotmail: ['hotmial', 'hotmal', 'hotnail', 'hotmai', 'homail', 'hotamil', 'hotmaill'],
  yahoo: ['yaho', 'yahooo', 'yhoo', 'yahho', 'yahou', 'yaoo', 'uahoo'],
  outlook: ['outlok', 'outloook', 'outook', 'outlock', 'outlookk', 'oultook'],
  icloud: ['iclod', 'icoud', 'iclould', 'icolud', 'iclound', 'icluod'],
};

const KNOWN = new Map();
for (const p of PROVIDERS) {
  KNOWN.set(`${p}.com`, null);
  for (const end of WRONG_ENDING) KNOWN.set(`${p}.${end}`, `${p}.com`);
}
for (const [good, bad] of Object.entries(MISSPELLED)) for (const b of bad) {
  KNOWN.set(`${b}.com`, `${good}.com`);
  for (const end of WRONG_ENDING) KNOWN.set(`${b}.${end}`, `${good}.com`);
}

// The address with its domain corrected, or null when it looks fine (or is not an address we can judge).
export function suggest(address) {
  const m = /^([^\s@]+)@([^\s@]+)$/.exec(String(address || '').trim());
  if (!m) return null;
  const fixed = KNOWN.get(m[2].toLowerCase());
  return fixed ? `${m[1]}@${fixed}` : null;
}
