// Try the whole product on your own computer: the website (site/), the real Worker code, and a throwaway
// in-memory database. Nothing is sent anywhere: emails are printed here instead, so copy the sign-in code
// or link from this terminal. Everything resets when you stop it.   Usage: npm run dev   (then open the URL)
const { startSite } = require('../tests/site');

const port = Number(process.env.PORT) || 8787;
startSite({
  port,
  tls: process.env.HTTPS === '1', // Safari will not keep the sign-in cookie on plain http://localhost; HTTPS=1 npm run dev serves a throwaway https certificate
  env: { STARTER_OFRENDA: '1' },
  onMail: m => console.log(`\n--- email to ${m.to} ---\nSubject: ${m.subject}\n\n${m.text}\n`),
}).then(site => {
  console.log(`Digital Ofrenda is running at ${site.url}`);
  console.log('Sign in with any email address; the code will be printed below.\n');
}).catch(e => { console.error(e.message); process.exit(1); });
