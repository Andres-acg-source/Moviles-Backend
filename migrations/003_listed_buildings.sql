ALTER TABLE buildings ADD COLUMN listed boolean NOT NULL DEFAULT true;
UPDATE buildings SET listed = (id = 'sd');
