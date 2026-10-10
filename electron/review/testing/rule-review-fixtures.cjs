const { createAliasFixture } = require('../../database/canon-alias-validation.cjs');
const { inputFor } = require('../../database/canon-record-validation.cjs');
const records = require('../../database/repositories/canon-record-repository.cjs');
const definitions = require('../../database/repositories/canon-definition-repository.cjs');
const { createEpisodeWithContent } = require('../../episode-service.cjs');

/** 격리 Canon fixture의 Character 참조만 명시적으로 바꾸며 다른 필드값은 보존한다. */
function setCharacterReferences(fixture, index, attributes, skills) {
  const character = records.getById(fixture.scope.character, fixture.characters[index].id);
  const fields = definitions.getCanonDefinitionBySetId(fixture.scope.character.setId).fields;
  const values = { ...character.fieldValues, [fields.find(field => field.key === 'attributes').id]: attributes.map(record => record.id), [fields.find(field => field.key === 'skills').id]: skills.map(record => record.id) };
  return records.update(fixture.scope.character, character.id, { displayName: character.displayName, fieldValues: values });
}

/** 실제 사용자 Canon과 무관한 Skill·Attribute 관계를 임시 DB/Storage에 만든다. */
function createRuleFixture(storage, title = 'Task030 가상 작품') {
  const fixture = createAliasFixture(title);
  const water = records.update(fixture.scope.attribute, fixture.attribute.id, inputFor(fixture.scope.attribute, '물'));
  const fire = records.create(fixture.scope.attribute, inputFor(fixture.scope.attribute, '불'));
  const wind = records.create(fixture.scope.attribute, inputFor(fixture.scope.attribute, '바람'));
  const sameNameWater = records.create(fixture.scope.attribute, inputFor(fixture.scope.attribute, '물'));
  const skill = records.create(fixture.scope.skill, inputFor(fixture.scope.skill, '해일', { required_attribute: water.id }));
  const sameNameSkill = records.create(fixture.scope.skill, inputFor(fixture.scope.skill, '해일', { required_attribute: fire.id }));
  const result = { ...fixture, water, fire, wind, sameNameWater, skill, sameNameSkill };
  setCharacterReferences(result, 0, [fire], [skill]);
  setCharacterReferences(result, 1, [water], [skill]);
  setCharacterReferences(result, 2, [fire], [skill]);
  const episodes = [
    createEpisodeWithContent(storage, { workId: fixture.workId, episodeNumber: 1, title: '등록 관계 확인', content: '한지수는 기다렸다.\n이카로스는 문을 보았다.\n그녀가 손을 들어 올렸다.\n{해일}\n{해일}' }),
    createEpisodeWithContent(storage, { workId: fixture.workId, episodeNumber: 2, title: '정상 등록 관계', content: '이카로스는 문을 보았다.' }),
    createEpisodeWithContent(storage, { workId: fixture.workId, episodeNumber: 3, title: '미확정 인물', content: '기사단장님이 손을 들어 올렸다.\n{해일}' }),
  ];
  return { ...result, episodes };
}

module.exports = { createRuleFixture, setCharacterReferences };
