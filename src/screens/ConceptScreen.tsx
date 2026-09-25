import { useEffect, useState } from "react";
import {
  type CanonSet,
  type CanonSetDefinition,
  type CanonSpace,
  type StoredWork,
} from "../types/electron-api";

const valueTypeLabels: Record<string, string> = {
  TEXT: "짧은 텍스트",
  LONG_TEXT: "긴 텍스트",
  NUMBER: "숫자",
  BOOLEAN: "예/아니오",
  OPTION_ONE: "단일 선택",
  OPTION_MANY: "복수 선택",
  REFERENCE_ONE: "단일 참조",
  REFERENCE_MANY: "복수 참조",
};

/**
 * 작품별 CanonSpace 정의를 읽기 전용으로 탐색하는 화면을 제공한다.
 */
function ConceptScreen() {
  const [works, setWorks] = useState<StoredWork[]>([]);
  const [selectedWork, setSelectedWork] = useState<StoredWork | null>(null);
  const [canonSpace, setCanonSpace] = useState<CanonSpace | null>(null);
  const [sets, setSets] = useState<CanonSet[]>([]);
  const [definition, setDefinition] = useState<CanonSetDefinition | null>(null);
  const [loading, setLoading] = useState(true);
  const [definitionLoading, setDefinitionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    /**
     * 실제 SQLite Work 목록을 최초 한 번 불러온다.
     */
    async function loadWorks() {
      try {
        const result = await window.novelCompany.works.getAll();
        if (!cancelled) {
          if (result.ok) {
            setWorks(result.data);
          } else {
            setError(result.error.message);
          }
        }
      } catch {
        if (!cancelled) {
          setError("작품 정보를 불러오는 중 오류가 발생했습니다.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadWorks();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 선택한 Work의 CanonSpace와 해당 Set 목록을 읽어 화면 상태에 반영한다.
   */
  async function handleSelectWork(work: StoredWork) {
    setSelectedWork(work);
    setCanonSpace(null);
    setSets([]);
    setDefinition(null);
    setError(null);
    setLoading(true);

    try {
      const spaceResult = await window.novelCompany.canon.spaces.getByWorkId(
        work.id,
      );
      if (!spaceResult.ok) {
        setError(spaceResult.error.message);
        return;
      }
      setCanonSpace(spaceResult.data);
      if (!spaceResult.data) {
        return;
      }

      const setsResult =
        await window.novelCompany.canon.sets.getByCanonSpaceId(
          spaceResult.data.id,
        );
      if (setsResult.ok) {
        setSets(setsResult.data);
      } else {
        setError(setsResult.error.message);
      }
    } catch {
      setError("컨셉정리 정보를 불러오는 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  /**
   * 선택한 Set의 Field, Option 및 참조 대상 정의를 읽어 표시한다.
   */
  async function handleSelectSet(set: CanonSet) {
    setDefinition(null);
    setDefinitionLoading(true);
    setError(null);

    try {
      const result = await window.novelCompany.canon.sets.getDefinition(set.id);
      if (result.ok) {
        setDefinition(result.data);
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("컨셉정리 정의를 불러오는 중 오류가 발생했습니다.");
    } finally {
      setDefinitionLoading(false);
    }
  }

  if (!selectedWork) {
    return (
      <section className="content-panel">
        <p className="section-label">컨셉정리</p>
        <h1>작품 선택</h1>
        {loading && <p className="placeholder-message">작품 정보를 불러오는 중입니다.</p>}
        {!loading && error && <p className="error-message" role="alert">{error}</p>}
        {!loading && !error && works.length === 0 && (
          <p className="placeholder-message">등록된 작품이 없습니다.</p>
        )}
        {!loading && !error && works.length > 0 && (
          <ul className="work-list">
            {works.map((work) => (
              <li className="work-card" key={work.id}>
                <button className="work-card-button" type="button" onClick={() => void handleSelectWork(work)}>
                  <span className="work-title">{work.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  return (
    <section className="content-panel">
      <button className="back-button" type="button" onClick={() => setSelectedWork(null)}>
        ← 작품 선택
      </button>
      <p className="section-label">{selectedWork.title}</p>
      <h1>컨셉정리</h1>
      {loading && <p className="placeholder-message">CanonSpace 정보를 불러오는 중입니다.</p>}
      {!loading && error && <p className="error-message" role="alert">{error}</p>}
      {!loading && !error && !canonSpace && (
        <p className="placeholder-message">아직 연결된 CanonSpace가 없습니다.</p>
      )}
      {!loading && !error && canonSpace && (
        <div className="concept-layout">
          <aside className="concept-set-navigation" aria-label="Canon Set 목록">
            <p className="section-label">Set</p>
            <ul className="concept-set-list">
              {sets.map((set) => (
                <li key={set.id}>
                  <button
                    className={definition?.id === set.id ? "concept-set-button is-selected" : "concept-set-button"}
                    type="button"
                    onClick={() => void handleSelectSet(set)}
                  >
                    {set.name}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
          <div className="concept-definition">
            {!definitionLoading && !definition && (
              <p className="placeholder-message">왼쪽에서 Set을 선택하세요.</p>
            )}
            {definitionLoading && (
              <p className="placeholder-message">정의를 불러오는 중입니다.</p>
            )}
            {definition && (
              <>
                <h2>{definition.name}</h2>
                <p className="placeholder-message">{definition.recordNameLabel}을 관리하는 정의입니다.</p>
                <dl className="concept-field-list">
                  {definition.fields.map((field) => (
                    <div className="concept-field" key={field.id}>
                      <dt>{field.label}{field.required ? " (필수)" : ""}</dt>
                      <dd>
                        {valueTypeLabels[field.valueType] ?? field.valueType}
                        {field.referenceSet ? " · " + field.referenceSet.name + " 참조" : ""}
                        {field.options.length > 0 ? " · " + field.options.map((option) => option.label).join(", ") : ""}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default ConceptScreen;
