-- Match the complete known initial definition, never title or template_key alone.
-- Preserve every ID, record, value and reference; change only three required flags.
WITH expected_sets(key, name, record_name_label) AS (VALUES
  ('world', '세계', '세계 이름'),
  ('location', '지역', '지역 이름'),
  ('organization', '조직', '조직 이름'),
  ('attribute', '속성', '속성 이름'),
  ('skill', '스킬', '스킬 이름'),
  ('character', '캐릭터', '캐릭터 이름'),
  ('authority', '권능', '권능 이름'),
  ('servant', '권속', '권속 이름'),
  ('passive', '패시브', '패시브 이름'),
  ('contract', '계약', '계약 이름'),
  ('relationship', '관계', '관계 이름')
), expected_fields(set_key, key, label, value_type, input_control, reference_key, required) AS (VALUES
  ('world', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('location', 'world', '세계', 'REFERENCE_ONE', 'COMBOBOX', 'world', '1'),
  ('location', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('organization', 'location', '지역', 'REFERENCE_ONE', 'COMBOBOX', 'location', '1'),
  ('organization', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('attribute', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('skill', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('character', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('character', 'origin_world', '출신 세계', 'REFERENCE_ONE', 'COMBOBOX', 'world', '1'),
  ('character', 'origin_location', '출신 지역', 'REFERENCE_ONE', 'COMBOBOX', 'location', '1'),
  ('character', 'current_location', '현재 위치', 'REFERENCE_ONE', 'COMBOBOX', 'location', '1'),
  ('character', 'organization', '소속 조직', 'REFERENCE_ONE', 'COMBOBOX', 'organization', '0'),
  ('character', 'attributes', '속성', 'REFERENCE_MANY', 'CHECKBOX_GROUP', 'attribute', '1'),
  ('character', 'skills', '스킬', 'REFERENCE_MANY', 'CHECKBOX_GROUP', 'skill', '0'),
  ('character', 'passives', '패시브', 'REFERENCE_MANY', 'CHECKBOX_GROUP', 'passive', '1'),
  ('authority', 'owner_character', '소유 캐릭터', 'REFERENCE_ONE', 'COMBOBOX', 'character', '1'),
  ('authority', 'base_skill', '기반 스킬', 'REFERENCE_ONE', 'COMBOBOX', 'skill', '0'),
  ('authority', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('servant', 'owner_character', '소유 캐릭터', 'REFERENCE_ONE', 'COMBOBOX', 'character', '1'),
  ('servant', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('passive', 'passive_type', '패시브 유형', 'OPTION_ONE', 'COMBOBOX', NULL, '1'),
  ('passive', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('contract', 'grantor_character', '부여자', 'REFERENCE_ONE', 'COMBOBOX', 'character', '1'),
  ('contract', 'grantee_character', '수여자', 'REFERENCE_ONE', 'COMBOBOX', 'character', '1'),
  ('contract', 'status', '상태', 'OPTION_ONE', 'COMBOBOX', NULL, '1'),
  ('contract', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0'),
  ('relationship', 'source_character', '기준 캐릭터', 'REFERENCE_ONE', 'COMBOBOX', 'character', '1'),
  ('relationship', 'target_character', '대상 캐릭터', 'REFERENCE_ONE', 'COMBOBOX', 'character', '1'),
  ('relationship', 'relationship_type', '관계 유형', 'TEXT', 'TEXT_INPUT', NULL, '0'),
  ('relationship', 'description', '설명', 'LONG_TEXT', 'TEXTAREA', NULL, '0')
), expected_options(set_key, field_key, value, label) AS (VALUES
  ('passive', 'passive_type', 'COMMON', '공통'),
  ('passive', 'passive_type', 'UNIQUE', '고유'),
  ('contract', 'status', 'ACTIVE', '활성'),
  ('contract', 'status', 'ENDED', '종료')
), initial_spaces AS (
  SELECT c.id FROM canon_spaces c
  WHERE c.template_key = 'MODERN_FANTASY_V1'
    AND (SELECT COUNT(*) FROM canon_sets WHERE canon_space_id = c.id) = 11
    AND (SELECT COUNT(*) FROM canon_fields WHERE canon_space_id = c.id) = 30
    AND (SELECT COUNT(*) FROM canon_field_options WHERE canon_space_id = c.id) = 4
    AND NOT EXISTS (
      SELECT 1 FROM expected_sets e WHERE NOT EXISTS (
        SELECT 1 FROM canon_sets s WHERE s.canon_space_id = c.id
          AND s.key = e.key AND s.name = e.name AND s.record_name_label = e.record_name_label
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM expected_fields e WHERE NOT EXISTS (
        SELECT 1 FROM canon_fields f JOIN canon_sets s ON s.id = f.canon_set_id
        LEFT JOIN canon_sets target ON target.id = f.reference_set_id
        WHERE f.canon_space_id = c.id AND s.key = e.set_key AND f.key = e.key
          AND f.label = e.label AND f.value_type = e.value_type AND f.input_control = e.input_control
          AND target.key IS e.reference_key
          AND (f.required = e.required
            OR (s.key = 'character' AND f.key IN ('origin_world', 'current_location'))
            OR (s.key = 'relationship' AND f.key = 'relationship_type'))
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM expected_options e WHERE NOT EXISTS (
        SELECT 1 FROM canon_field_options o JOIN canon_fields f ON f.id = o.field_id
        JOIN canon_sets s ON s.id = o.canon_set_id
        WHERE o.canon_space_id = c.id AND s.key = e.set_key AND f.key = e.field_key
          AND o.value = e.value AND o.label = e.label
      )
    )
)
UPDATE canon_fields
SET required = CASE WHEN key = 'relationship_type' THEN 1 ELSE 0 END
WHERE canon_space_id IN (SELECT id FROM initial_spaces)
  AND ((canon_set_id IN (SELECT id FROM canon_sets WHERE key = 'character') AND key IN ('origin_world', 'current_location'))
    OR (canon_set_id IN (SELECT id FROM canon_sets WHERE key = 'relationship') AND key = 'relationship_type'));
