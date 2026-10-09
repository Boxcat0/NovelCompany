const CONTEXTUAL_NAMES = new Set(['그분', '그 녀석', '그녀석', '그 사람']);
const NAME_RESOLUTION_VERSION = 'CHARACTER_NAMES_V1';

/** 비교용 이름만 앞뒤 공백 제거 및 NFC 정규화하며 내부 공백과 대소문자는 보존한다. */
function normalizeName(value) { return value.trim().normalize('NFC'); }

module.exports = { normalizeName, CONTEXTUAL_NAMES, NAME_RESOLUTION_VERSION };
