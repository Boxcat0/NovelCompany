const INITIAL_WORK_TITLE = "아무래도 전직을 잘못한 것 같습니다?";
const INITIAL_TEMPLATE_KEY = "MODERN_FANTASY_V1";

const TASK016_CANON_SETS = [
  { key: "world", name: "세계", recordNameLabel: "세계 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "location", name: "지역", recordNameLabel: "지역 이름", fields: [["world", "세계", "REFERENCE_ONE", "COMBOBOX", true, "world"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "organization", name: "조직", recordNameLabel: "조직 이름", fields: [["location", "지역", "REFERENCE_ONE", "COMBOBOX", false, "location"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "attribute", name: "속성", recordNameLabel: "속성 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "skill", name: "스킬", recordNameLabel: "스킬 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "character", name: "캐릭터", recordNameLabel: "캐릭터 이름", fields: [["description", "설명", "LONG_TEXT", "TEXTAREA", false], ["origin_world", "출신 세계", "REFERENCE_ONE", "COMBOBOX", false, "world"], ["origin_location", "출신 지역", "REFERENCE_ONE", "COMBOBOX", false, "location"], ["current_location", "현재 위치", "REFERENCE_ONE", "COMBOBOX", false, "location"], ["organization", "소속 조직", "REFERENCE_ONE", "COMBOBOX", false, "organization"], ["attributes", "속성", "REFERENCE_MANY", "CHECKBOX_GROUP", false, "attribute"], ["skills", "스킬", "REFERENCE_MANY", "CHECKBOX_GROUP", false, "skill"], ["passives", "패시브", "REFERENCE_MANY", "CHECKBOX_GROUP", false, "passive"]] },
  { key: "authority", name: "권능", recordNameLabel: "권능 이름", fields: [["owner_character", "소유 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["base_skill", "기반 스킬", "REFERENCE_ONE", "COMBOBOX", false, "skill"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "servant", name: "권속", recordNameLabel: "권속 이름", fields: [["owner_character", "소유 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "passive", name: "패시브", recordNameLabel: "패시브 이름", fields: [["passive_type", "패시브 유형", "OPTION_ONE", "COMBOBOX", true, null, [["COMMON", "공통"], ["UNIQUE", "고유"]]], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "contract", name: "계약", recordNameLabel: "계약 이름", fields: [["grantor_character", "부여자", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["grantee_character", "수여자", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["status", "상태", "OPTION_ONE", "COMBOBOX", true, null, [["ACTIVE", "활성"], ["ENDED", "종료"]]], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
  { key: "relationship", name: "관계", recordNameLabel: "관계 이름", fields: [["source_character", "기준 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["target_character", "대상 캐릭터", "REFERENCE_ONE", "COMBOBOX", true, "character"], ["relationship_type", "관계 유형", "TEXT", "TEXT_INPUT", false], ["description", "설명", "LONG_TEXT", "TEXTAREA", false]] },
];


/** Task016 정의를 보존하고 Task017/022에서 합의한 required 정책만 파생한다. */
function refineInitialCanonSets() {
  return TASK016_CANON_SETS.map(set => ({ ...set, fields: set.fields.map(field => {
    const refined = [...field];
    if (set.key === 'organization' && field[0] === 'location') refined[4] = true;
    if (set.key === 'character') refined[4] = ['origin_location', 'attributes', 'passives'].includes(field[0]);
    if (set.key === 'relationship' && field[0] === 'relationship_type') refined[4] = true;
    return refined;
  }).concat(set.key === 'skill' ? [['required_attribute', '필요 속성', 'REFERENCE_ONE', 'COMBOBOX', true, 'attribute']] : []) }));
}
const CANON_SETS = refineInitialCanonSets();
module.exports = { TASK016_CANON_SETS, CANON_SETS, INITIAL_WORK_TITLE, INITIAL_TEMPLATE_KEY };
