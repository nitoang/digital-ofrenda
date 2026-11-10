-- Addresses we have stopped emailing because the email provider told us a message could not be delivered
-- ('bounce': the mailbox does not exist) or that the person marked one as spam ('complaint'). Only a hash of the
-- address is kept, never the address itself. A complaint still lets sign-in and email-change codes through (see
-- server/mailhealth.mjs); a bounce stops everything, since nothing can arrive.
CREATE TABLE mail_suppressions (
  email_hash TEXT PRIMARY KEY,
  reason     TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  created_at INTEGER NOT NULL
);
