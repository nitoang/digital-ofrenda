// The numbers you are most likely to tune. Change them here; the tests read them from here too.
import { MINUTE, DAY, HOUR } from './util.mjs';

export const RULES = Object.freeze({
  freeAltars: 3,                       // altars one account can own without the platinum plan
  loginTtl: 15 * MINUTE,               // sign-in link and code
  loginsPerEmailPerHour: 5,
  codeAttempts: 5,                     // wrong guesses allowed per sign-in code
  sessionTtl: 90 * DAY,                // renewed whenever the session is used
  sessionRenewAfter: DAY,
  seenAfter: HOUR,                     // how often "last seen" is refreshed
  inviteTtl: 7 * DAY,
  maxKeepers: 10,                      // co-keepers plus pending invites, per altar
  invitesPerEmailPerDay: 3,
  sharesPerEmailPerDay: 3,             // view-only links emailed to one address, across all altars
  sharesPerAltarPerDay: 20,            // view-only links one altar may email in a day
  starterName: 'My Ofrenda',           // what a new account's first ofrenda is called (when STARTER_OFRENDA is on)
  noteMax: 280,                        // characters in the optional note that goes with a shared link
  inactiveAfter: 365 * DAY,            // owner silence before a successor may start a takeover request
  slugsPerAltar: 5,                    // names one ofrenda may have used, including the current one
  emailChangeTtl: 15 * MINUTE,         // the code sent to a new address
  emailChangeAttempts: 5,
  emailChangesPerHour: 5,
  handoverWait: 90 * DAY,              // how long a handover to someone without an account waits for them to sign up
  handoversPerDay: 3,                  // handovers one account may start in a day
  handoverWord: 'handover',            // typed to confirm a handover
  claimWait: 30 * DAY,                 // notice period; the owner signing in at any point cancels it
});
