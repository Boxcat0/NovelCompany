-- 기존 Skill Record/값/참조는 보존하고, 같은 CanonSpace에 Attribute Set이 있는 Skill Definition만 확장한다.
INSERT INTO canon_fields
  (id, canon_space_id, canon_set_id, key, label, value_type, input_control, reference_set_id, required, help_text, sort_order, created_at, updated_at)
SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))), skill.canon_space_id, skill.id,
       'required_attribute', '필요 속성', 'REFERENCE_ONE', 'COMBOBOX', attribute.id, 1,
       '기존 미설정 스킬은 속성을 지정해 보완할 수 있습니다.',
       COALESCE((SELECT MAX(sort_order) FROM canon_fields WHERE canon_set_id = skill.id), 0) + 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM canon_sets AS skill
JOIN canon_sets AS attribute ON attribute.canon_space_id = skill.canon_space_id AND attribute.key = 'attribute'
WHERE skill.key = 'skill'
  AND NOT EXISTS (SELECT 1 FROM canon_fields AS existing WHERE existing.canon_set_id = skill.id AND existing.key = 'required_attribute');
