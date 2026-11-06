# Security Policy

## Reporting a vulnerability

Please report security problems **privately**. Do not open a public issue or pull request for them.

Use GitHub's private vulnerability reporting: on the repository page, go to **Security** → **Report a vulnerability**.

Helpful details: what you found, the steps to reproduce it (a sample import file or saved state is ideal), which browser you used, and what you think the impact is.

You can expect an acknowledgement within a few days. Fixes are made in private where possible and released with a note in the repository once they are available. Please give a reasonable time to fix a problem before sharing it publicly.

## Supported versions

Only the latest version on the `main` branch is supported.

## What is in scope

`<digital-ofrenda>` stores altars in the visitor's browser and can optionally load and save them through a host-provided shared store. Reports about these are especially welcome:

- Ways to run script or inject HTML or CSS through imported files, saved data, shared-store data, notes, names, or photos.
- Ways around the data cleaning in `ofrenda.js` (`sanitize` / `cleanStored`) or the Content-Security-Policy used on the demo page.
- Photos that can load from anywhere other than inline PNG, JPEG, WebP or GIF data.

## Out of scope

- Problems that need the attacker to already control the visitor's browser or the host page's own scripts.
- Missing HTTP headers on a site you host yourself (see the Security section of the README for the recommended policy).
- Reports from automated scanners with no demonstrated impact.

## For people who embed the component

Serve your page with a Content-Security-Policy, set `frame-ancestors` as an HTTP header, and keep shared-store access rules on the server side. The component treats everything it loads as untrusted, but your backend decides who can write to it.
