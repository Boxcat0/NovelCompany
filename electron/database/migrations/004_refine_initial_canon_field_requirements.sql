-- Preserve definition IDs and all records; refine only known template fields.
UPDATE canon_fields
SET required = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canon_space_id IN (SELECT id FROM canon_spaces WHERE template_key = 'MODERN_FANTASY_V1')
  AND ((canon_set_id IN (SELECT id FROM canon_sets WHERE key = 'organization') AND key = 'location' AND value_type = 'REFERENCE_ONE')
    OR (canon_set_id IN (SELECT id FROM canon_sets WHERE key = 'character')
      AND ((key IN ('origin_world', 'origin_location', 'current_location') AND value_type = 'REFERENCE_ONE')
        OR (key IN ('attributes', 'passives') AND value_type = 'REFERENCE_MANY'))));

UPDATE canon_fields
SET required = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE canon_space_id IN (SELECT id FROM canon_spaces WHERE template_key = 'MODERN_FANTASY_V1')
  AND canon_set_id IN (SELECT id FROM canon_sets WHERE key = 'character')
  AND key IN ('organization', 'skills', 'description');
