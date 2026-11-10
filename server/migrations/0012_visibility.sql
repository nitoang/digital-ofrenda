-- Who can open an ofrenda. 'link' (the default, as before): anyone who has the link. 'private': only the people who
-- keep it, so every link stops working for everyone else until the owner turns it back on.
ALTER TABLE altars ADD COLUMN visibility TEXT NOT NULL DEFAULT 'link' CHECK (visibility IN ('link', 'private'));
