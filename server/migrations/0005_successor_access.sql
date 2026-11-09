-- A successor who agrees becomes a co-keeper right away (they can add to the ofrenda, not delete it). This marks
-- the co-keepers who are there only because of that, so that removing or replacing the successor takes their
-- access away again, while a co-keeper who was invited separately keeps theirs.
ALTER TABLE altar_members ADD COLUMN via_successor INTEGER NOT NULL DEFAULT 0;
