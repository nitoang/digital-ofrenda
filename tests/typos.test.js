// The sign-in page's typo check. Plain function, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggest } from '../site/typos.js';

test('typos: the usual slips in the big providers are caught, whatever the capitals', () => {
  for (const [typed, fixed] of [
    ['maria@gmial.com', 'maria@gmail.com'], ['maria@gmail.con', 'maria@gmail.com'], ['Maria@GMAIL.CO', 'Maria@gmail.com'], ['a.b+c@gmail.cmo', 'a.b+c@gmail.com'],
    ['x@hotmial.com', 'x@hotmail.com'], ['x@yaho.com', 'x@yahoo.com'], ['x@outlok.com', 'x@outlook.com'], ['x@icloud.con', 'x@icloud.com'],
    [' x@gnail.com ', 'x@gmail.com'],
  ]) assert.equal(suggest(typed), fixed, typed);
});

test('typos: correct, unusual or unjudgeable addresses are left alone', () => {
  for (const ok of ['maria@gmail.com', 'maria@example.com', 'maria@gmail.co.uk', 'maria@company.co', 'maria@my-gmail.com', 'maria@live.com', 'maria@proton.com', 'nope', '', null, undefined, 'a@b@gmail.con'])
    assert.equal(suggest(ok), null, String(ok));
});
