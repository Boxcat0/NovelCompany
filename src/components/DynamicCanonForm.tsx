import type { CanonFieldDefinition, CanonFormValue, CanonRecordInput, CanonSetDefinition, ReferenceOption } from "../types/electron-api";

type FieldProps = { field: CanonFieldDefinition; value: CanonFormValue; options: ReferenceOption[]; onChange: (value: CanonFormValue) => void };

/** Field의 저장 타입과 입력 컨트롤 정의를 기본 HTML 입력으로 변환한다. */
function CanonFieldRenderer({ field, value, options, onChange }: FieldProps) {
  const id = "canon-field-" + field.id;
  if (field.inputControl === "TEXT_INPUT") return <input id={id} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
  if (field.inputControl === "TEXTAREA") return <textarea id={id} rows={4} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)} />;
  if (field.inputControl === "NUMBER_INPUT") return <input id={id} type="number" step="any" value={typeof value === "number" ? value : ""} onChange={(event) => onChange(event.target.value === "" ? null : event.target.valueAsNumber)} />;
  if (field.inputControl === "CHECKBOX") return <input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
  const choices = field.referenceSet ? options : field.options.map((option) => ({ id: option.id, displayName: option.label, disabled: false, description: null }));
  if (choices.length === 0) return <p className="placeholder-message">등록된 {field.referenceSet?.name ?? field.label} 항목이 없습니다.{field.key === 'required_attribute' ? ' 새 스킬을 등록하려면 먼저 속성을 등록해 주세요.' : ''}</p>;
  if (field.inputControl === "COMBOBOX") return <select id={id} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value || null)}><option value="">{field.key === 'required_attribute' ? '미설정' : '선택 안 함'}</option>{choices.map((option) => <option key={option.id} value={option.id} disabled={option.disabled}>{option.displayName}{option.description ? " · " + option.description : ""}</option>)}</select>;
  const selected = Array.isArray(value) ? value : [];
  if (field.inputControl === "MULTI_SELECT") return <select id={id} multiple value={selected} onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}>{choices.map((option) => <option key={option.id} value={option.id} disabled={option.disabled}>{option.displayName}{option.description ? " · " + option.description : ""}</option>)}</select>;
  if (field.inputControl === "CHECKBOX_GROUP") return <div id={id} role="group" aria-label={field.label} className="canon-choices">{choices.map((option) => <label key={option.id}><input type="checkbox" checked={selected.includes(option.id)} disabled={option.disabled} onChange={(event) => onChange(event.target.checked ? [...selected, option.id] : selected.filter((item) => item !== option.id))} /><span>{option.displayName}{option.description && <small>{option.description}</small>}</span></label>)}</div>;
  return <p role="alert">지원하지 않는 입력 형식입니다.</p>;
}

/** 필수 입력을 검사하되 기존 미설정 Skill의 수정만 보존하고 최종 검증은 Repository에 맡긴다. */
export function validateCanonForm(definition: CanonSetDefinition, input: CanonRecordInput, allowLegacySkillMissing = false): string | null {
  if (!input.displayName.trim()) return definition.recordNameLabel + "을 입력해 주세요.";
  for (const field of definition.fields) {
    const value = input.fieldValues[field.id];
    if (field.required && !(allowLegacySkillMissing && definition.key === 'skill' && field.key === 'required_attribute') && (value === null || value === undefined || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0))) return "'" + field.label + "' 항목을 입력하거나 하나 이상 선택해 주세요.";
    if (typeof value === "number" && !Number.isFinite(value)) return "'" + field.label + "'에 올바른 숫자를 입력해 주세요.";
  }
  return null;
}

type FormProps = { definition: CanonSetDefinition; input: CanonRecordInput; options: Record<string, ReferenceOption[]>; busy: boolean; editing: boolean; dirty: boolean; allowLegacySkillMissing?: boolean; onChange: (input: CanonRecordInput) => void; onSave: () => void; onDelete: () => void; onNavigateReference?: (setId: string) => void };

/** 정의의 필수/선택을 표시하고 빈 참조의 등록 이동과 작가의 명시적 저장/삭제를 연결한다. */
export default function DynamicCanonForm({ definition, input, options, busy, editing, dirty, allowLegacySkillMissing = false, onChange, onSave, onDelete, onNavigateReference }: FormProps) {
  return <form noValidate onSubmit={(event) => { event.preventDefault(); onSave(); }} className="canon-form">
    <h2>{editing ? "항목 편집" : "새 항목"}</h2>
    <p>{dirty ? "저장하지 않은 변경사항이 있습니다." : "변경사항이 없습니다."}</p>
    <fieldset disabled={busy}>
      <label htmlFor="canon-record-name">{definition.recordNameLabel} *</label>
      <input id="canon-record-name" value={input.displayName} onChange={(event) => onChange({ ...input, displayName: event.target.value })} />
      {definition.fields.map((field) => <div className="canon-form-field" key={field.id}>
        <label htmlFor={"canon-field-" + field.id}>{field.label}{field.required ? " * (필수)" : " (선택)"}</label>
        {field.helpText && <p>{field.helpText}</p>}
        {allowLegacySkillMissing && field.key === 'required_attribute' && <p>기존 스킬의 필요 속성이 미설정 상태입니다. 다른 항목은 보완 전에도 수정할 수 있습니다.</p>}
        <CanonFieldRenderer field={field} value={input.fieldValues[field.id] ?? null} options={options[field.id] ?? []} onChange={(value) => onChange({ ...input, fieldValues: { ...input.fieldValues, [field.id]: value } })} />
        {field.referenceSet && (options[field.id]?.length ?? 0) === 0 && <p>{field.required ? "먼저 해당 설정을 등록해 주세요." : "선택 항목이므로 비워 두어도 됩니다."} {onNavigateReference && <button type="button" onClick={() => onNavigateReference(field.referenceSet!.id)}>{field.referenceSet.name} 입력으로 이동</button>}</p>}
      </div>)}
      <div className="canon-actions"><button type="submit">{busy ? "처리 중…" : "저장"}</button>{editing && <button type="button" onClick={onDelete}>삭제</button>}</div>
    </fieldset>
  </form>;
}
