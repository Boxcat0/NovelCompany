/** 실제 sandbox Renderer에서 기초 입력부터 캐릭터/후행 분류까지 작성 진행과 저장 보호를 검증한다. */
async function exerciseCanonAuthoring(mode = "normal") {
  /** React와 IPC의 목표 상태를 제한 시간 동안 기다린다. */
  async function waitFor(predicate, label) { await new Promise((resolve) => setTimeout(resolve, 40)); const until = Date.now() + 10000; while (!predicate()) { if (Date.now() > until) throw new Error("Authoring UI: " + label); await new Promise((resolve) => setTimeout(resolve, 30)); } }
  /** 실패한 동작을 특정할 수 있도록 검증 문맥을 남긴다. */
  function check(value, label) { if (!value) throw new Error(label); }
  /** 표시 문구가 정확히 같은 버튼을 반환한다. */
  function button(text) { return [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === text); }
  /** 비활성 여부를 확인하고 사용자 클릭을 실행한다. */
  function click(text) { const item = button(text); check(item && !item.disabled, "Unavailable: " + text); item.click(); }
  /** 그룹에 표시된 분류 이름으로 탐색 버튼을 찾는다. */
  function setButton(name) { return [...document.querySelectorAll("nav[aria-label='설정 분류'] button")].find((item) => item.querySelector("span").textContent === name); }
  /** DB readiness가 화면에 즉시 반영되는지 확인한다. */
  function ready(name, value) { check(setButton(name).querySelector("small").textContent.includes("등록 가능") === value, name + " readiness"); }
  /** native setter와 이벤트로 React의 실제 폼 값을 변경한다. */
  async function fill(id, value) { const node = document.getElementById(id); const proto = node.tagName === "SELECT" ? HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value); node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 30)); }
  /** 분류 전환 뒤 실제 정의를 읽어 테스트에도 hardcoded Field ID를 사용하지 않는다. */
  async function select(key) { const set = sets.find((s) => s.key === key); setButton(set.name).click(); await waitFor(() => document.querySelector(".canon-record-list h2")?.textContent === set.name && !document.querySelector(".back-button").disabled, "select " + key); definition = (await window.novelCompany.canon.sets.getDefinition(set.id)).data; }
  /** 현재 정의의 Field key를 실제 DOM ID로 변환한다. */
  function fieldId(key) { return "canon-field-" + definition.fields.find((field) => field.key === key).id; }
  /** 실제 대상 Record 이름에 해당하는 select option을 선택한다. */
  async function reference(key, name) { const select = document.getElementById(fieldId(key)); const option = [...select.options].find((item) => item.textContent.startsWith(name)); check(option, "Missing reference " + name); await fill(select.id, option.value); }
  /** 복수 참조 checkbox의 실제 대상 선택을 수행한다. */
  async function choose(key, name) { const label = [...document.getElementById(fieldId(key)).querySelectorAll("label")].find((item) => item.textContent.startsWith(name)); const input = label?.querySelector("input"); check(input && !input.disabled, "Unavailable reference " + name); if (!input.checked) input.click(); await new Promise((resolve) => setTimeout(resolve, 30)); }
  /** 새 폼을 열고 대표 이름을 입력한다. */
  async function newRecord(name) { click("+ 새 항목"); await waitFor(() => document.getElementById("canon-record-name")?.value === "" && button("저장")?.disabled === false, "new record"); await fill("canon-record-name", name); }
  /** 같은 이벤트 턴의 이중 저장과 Sidebar 이동을 차단하고 저장 완료를 기다린다. */
  async function save(name) { const target = button("저장"); target.click(); target.click(); click("작품 관리"); check(document.querySelector("h1").textContent === "컨셉정리", "Pending save navigation"); await waitFor(() => button(name) && button("저장")?.disabled === false && document.body.textContent.includes("저장되었습니다."), "save " + name); }
  window.confirm = () => true;
  click("설정"); await waitFor(() => document.querySelector("h1")?.textContent === "애플리케이션 설정", "leave previous screen");
  click("컨셉정리");
  const title = "아무래도 전직을 잘못한 것 같습니다?";
  await waitFor(() => button(title), "work list"); click(title);
  await waitFor(() => document.querySelectorAll("nav[aria-label='설정 분류'] button").length === 11 && !document.querySelector(".back-button").disabled, "definitions");
  const work = (await window.novelCompany.works.getAll()).data.find((item) => item.title === title);
  const space = (await window.novelCompany.canon.spaces.getByWorkId(work.id)).data;
  const sets = (await window.novelCompany.canon.sets.getByCanonSpaceId(space.id)).data;
  let definition;
  check([...document.querySelectorAll(".canon-authoring-group h3")].map((item) => item.textContent).join(",") === "기초 설정,공간 / 집단,인물,인물 확장", "Group order");
  if (mode === "race") {
    setButton("세계").click(); setButton("속성").click();
    await waitFor(() => document.querySelector(".canon-record-list h2")?.textContent === "속성" && !document.querySelector(".back-button").disabled, "latest set");
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(document.querySelector(".canon-record-list h2").textContent === "속성", "Late set response replaced current selection");
    return { staleSetIgnored: true };
  }
  if (mode === "restart") {
    await select("character"); check(button("이카로스") && button("한지수"), "Persisted characters");
    button("이카로스").click(); await waitFor(() => document.getElementById("canon-record-name")?.value === "이카로스" && button("저장")?.disabled === false, "persisted character form");
    check(document.getElementById(fieldId("origin_world")).value === "", "Optional world persistence");
    ready("계약", true); ready("관계", true); return { restart: true };
  }
  for (const name of ["세계", "속성", "패시브"]) ready(name, true);
  ready('스킬', false);
  for (const name of ["지역", "조직", "캐릭터", "권능", "권속", "계약", "관계"]) ready(name, false);
  await select("character"); check(button("+ 새 항목").disabled, "Blocked character create");
  check(document.querySelector(".canon-readiness").textContent.includes("패시브"), "Missing blocker");
  click("지역 입력으로 이동"); await waitFor(() => document.querySelector(".canon-record-list h2")?.textContent === "지역" && !document.querySelector(".back-button").disabled, "dependency location");
  click("세계 입력으로 이동"); await waitFor(() => document.querySelector(".canon-record-list h2")?.textContent === "세계" && !document.querySelector(".back-button").disabled, "dependency world");
  await select("world"); await newRecord("임시 UI 세계"); await save("임시 UI 세계"); ready("지역", true);
  await select("location"); await newRecord("임시 UI 지역"); await reference("world", "임시 UI 세계"); await save("임시 UI 지역"); ready("조직", true);
  await select("attribute"); await newRecord("임시 UI 속성"); await save("임시 UI 속성"); ready("캐릭터", false);
  ready('스킬', true);
  await select('skill');
  const legacySkill = [...document.querySelectorAll('.canon-record-list button')].find(item => item.textContent.includes('기존 미설정 스킬'));
  check(legacySkill?.textContent.includes('필요 속성 미설정'), 'Legacy skill must be labeled missing');
  legacySkill.click();
  await waitFor(() => document.getElementById('canon-record-name')?.value === '기존 미설정 스킬', 'Legacy skill form');
  check(document.getElementById(fieldId('required_attribute')).value === '', 'Legacy field must remain unassigned');
  await fill(fieldId('description'), '기존 미설정 설명 보완');
  click('저장');
  await waitFor(() => document.body.textContent.includes('저장되었습니다.') && !button('저장').disabled, 'Legacy edit without attribute');
  check([...document.querySelectorAll('.canon-record-list button')].some(item => item.textContent.includes('기존 미설정 스킬 · 필요 속성 미설정')), 'Legacy status stays missing');
  await reference('required_attribute', '임시 UI 속성');
  await save('기존 미설정 스킬');
  check(![...document.querySelectorAll('.canon-record-list button')].some(item => item.textContent.includes('기존 미설정 스킬 · 필요 속성 미설정')), 'Legacy skill becomes configured');
  await select("passive"); await newRecord("임시 UI 공용"); await reference("passive_type", "공통"); await save("임시 UI 공용"); ready("캐릭터", true);
  await newRecord("임시 UI 고유"); await reference("passive_type", "고유"); await save("임시 UI 고유");
  await select("character"); await newRecord("이카로스");
  for (const key of ["origin_location", "attributes", "passives"]) check(document.querySelector("label[for='" + fieldId(key) + "']").textContent.includes("필수"), key + " required label");
  for (const key of ["origin_world", "current_location", "organization", "skills"]) check(document.querySelector("label[for='" + fieldId(key) + "']").textContent.includes("선택"), key + " optional label");
  click("저장"); await waitFor(() => document.querySelector("[role=alert]")?.textContent.includes("출신 지역"), "missing field validation");
  window.confirm = () => false; setButton("스킬").click(); setButton("세계").click(); click("← 작품 선택"); click("작품 관리"); click("+ 새 항목"); click("Canon 전체 삭제");
  check(document.getElementById("canon-record-name").value === "이카로스", "Dirty cancel");
  window.confirm = () => true;
  await reference("origin_location", "임시 UI 지역"); await choose("attributes", "임시 UI 속성"); await choose("passives", "임시 UI 고유"); await save("이카로스");
  ready("권능", true); ready("권속", true); ready("계약", false); ready("관계", false);
  check(setButton("계약").textContent.includes("2명"), "Two-character explanation");
  await newRecord("한지수");
  const unique = [...document.getElementById(fieldId("passives")).querySelectorAll("label")].find((item) => item.textContent.startsWith("임시 UI 고유"));
  check(unique.querySelector("input").disabled && unique.textContent.includes("이카로스"), "Unique occupancy");
  await reference("origin_location", "임시 UI 지역"); await choose("attributes", "임시 UI 속성"); await choose("passives", "임시 UI 공용"); await save("한지수");
  ready("계약", true); ready("관계", true);
  const scope = { canonSpaceId: space.id, setId: definition.id };
  const characters = (await window.novelCompany.canon.records.getBySetId(scope)).data;
  const second = (await window.novelCompany.canon.records.getById(scope, characters.find((r) => r.displayName === "한지수").id)).data;
  const first = (await window.novelCompany.canon.records.getById(scope, characters.find((r) => r.displayName === "이카로스").id)).data;
  const passiveId = definition.fields.find((f) => f.key === "passives").id;
  const forced = await window.novelCompany.canon.records.update(scope, second.id, { displayName: second.displayName, fieldValues: { ...second.fieldValues, [passiveId]: first.fieldValues[passiveId] } });
  check(!forced.ok && forced.error.code === "CANON_UNIQUE_PASSIVE_IN_USE", "Forced UNIQUE save");
  click("이카로스"); await waitFor(() => document.getElementById("canon-record-name")?.value === "이카로스" && button("저장")?.disabled === false, "owner reload");
  check([...document.getElementById(fieldId("passives")).querySelectorAll("input")].some((input) => input.checked && !input.disabled), "Owner retains UNIQUE");
  await fill(fieldId("description"), "임시 UI 수정 검증"); await save("이카로스");
  document.querySelector(".canon-definition summary").click(); check(document.querySelector(".canon-definition").open, "Structure view");
  await select("attribute"); click("임시 UI 속성"); await waitFor(() => button("삭제") && !button("삭제").disabled, "attribute selected"); click("삭제");
  await waitFor(() => document.querySelector("[role=alert]")?.textContent.includes("사용 중"), "Referenced delete blocked");
  await select("skill"); await newRecord("임시 UI 삭제 스킬");
  check(document.querySelector("label[for='" + fieldId('required_attribute') + "']").textContent.includes('필수'), 'Required attribute label');
  click('저장'); await waitFor(() => document.querySelector('[role=alert]')?.textContent.includes('필요 속성'), 'Required attribute client validation');
  await reference('required_attribute', '임시 UI 속성'); await save("임시 UI 삭제 스킬"); click("삭제"); await waitFor(() => !button("임시 UI 삭제 스킬") && !document.getElementById("canon-record-name") && !document.querySelector(".back-button").disabled, "unused delete");
  await select("character"); click("이카로스"); await waitFor(() => document.getElementById("canon-record-name")?.value === "이카로스" && button("저장")?.disabled === false, "final form");
  return { checks: "grouping/dependency progression/minimum/optional/UNIQUE/CRUD/dirty/security" };
}

module.exports = { exerciseCanonAuthoring };
