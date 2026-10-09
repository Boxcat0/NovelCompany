import { useEffect, useRef, useState } from 'react';
import type { NarrationMode, SceneNarrationSnapshot } from '../types/electron-api';

export const narrationLabels: Record<NarrationMode, string> = { FIRST_PERSON_CHARACTER: '특정 인물 1인칭', EXTERNAL_THIRD_PERSON: '외부 3인칭', UNKNOWN: '미확정' };
type Draft = { mode: NarrationMode; narratorCharacterId: string | null };
type Props = { workId: string; episodeId: string; revision: string; dirty: boolean; disabled: boolean; onStateChange: (dirty: boolean, busy: boolean) => void; onSaved: () => void };

/** 저장본 장면의 시점을 명시적으로 저장하고 요청 순서 및 편집 중 이동을 보호한다. */
export function SceneNarrationEditor({ workId, episodeId, revision, dirty, disabled, onStateChange, onSaved }: Props) {
  const [snapshot, setSnapshot] = useState<SceneNarrationSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const pending = useRef(false);
  const hasDraft = Object.keys(drafts).length > 0;
  useEffect(() => { onStateChange(hasDraft, saving); }, [hasDraft, saving, onStateChange]);
  useEffect(() => {
    const request = ++sequence.current;
    setLoading(true); setSnapshot(null); setDrafts({}); setError('');
    /** 현재 회차·저장본 요청에 해당하는 응답만 화면에 반영한다. */
    async function load() {
      try {
        const result = await window.novelCompany.sceneNarration.getForEpisode({ workId, episodeId });
        if (request !== sequence.current) return;
        if (!result.ok) { setError(result.error.message); return; }
        setSnapshot(result.data);
      } catch { if (request === sequence.current) setError('장면 시점을 불러오지 못했습니다.'); }
      finally { if (request === sequence.current) setLoading(false); }
    }
    void load();
    return () => { sequence.current++; };
  }, [workId, episodeId, revision, refresh]);

  /** 서버가 다시 파싱할 원고·레이아웃·장면 조건을 보내고 성공한 행만 갱신한다. */
  async function save(identity: string, draft: Draft) {
    if (!snapshot || dirty || disabled || pending.current) return;
    pending.current = true; setSaving(true); setError(''); onStateChange(hasDraft, true);
    const request = sequence.current;
    try {
      const result = await window.novelCompany.sceneNarration.save({ workId, episodeId, expectedEpisodeContentHash: snapshot.episodeContentHash, expectedSceneLayoutVersion: snapshot.layoutVersion, expectedSceneIdentity: identity, narration: draft });
      if (request !== sequence.current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setSnapshot({ ...snapshot, scenes: snapshot.scenes.map(scene => scene.identity === identity ? { ...scene, narration: result.data.narration } : scene) });
      setDrafts(previous => { const next = { ...previous }; delete next[identity]; return next; });
      onSaved();
    } catch { if (request === sequence.current) setError('장면 시점을 저장하지 못했습니다.'); }
    finally { pending.current = false; if (request === sequence.current) setSaving(false); }
  }

  return <section aria-label="장면 시점 설정">
    <h3>장면 시점 설정</h3>
    {dirty && <p>장면 시점을 설정하려면 먼저 원고를 저장해 주세요.</p>}
    {snapshot?.hasStaleMetadata && <p role="status">원고 또는 장면 구성이 변경되어 기존 장면 시점 설정을 현재 원고에 자동 적용할 수 없습니다. 현재 장면의 시점을 다시 확인해 주세요.</p>}
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">장면을 불러오는 중입니다.</p>}
    <button type="button" disabled={disabled || saving || loading || hasDraft} onClick={() => setRefresh(value => value + 1)}>장면·인물 새로고침</button>
    {hasDraft && <button type="button" disabled={saving} onClick={() => setDrafts({})}>시점 변경 취소</button>}
    {snapshot?.scenes.map(scene => {
      const draft = drafts[scene.identity] ?? { mode: scene.narration.mode, narratorCharacterId: scene.narration.narratorCharacter?.recordId ?? null };
      return <fieldset key={scene.identity} disabled={dirty || disabled || saving}>
        <legend>Scene {scene.index} · {scene.locationHeading ?? '무표제'}</legend>
        <p>{scene.preview}</p>
        <p>{scene.narration.source === 'UNSET' ? '미설정' : '작가 지정'}{scene.narration.status === 'NARRATOR_DELETED' && ' · 서술자가 삭제되었습니다. 다시 지정해 주세요.'}</p>
        <label>서술 시점 <select aria-label={`Scene ${scene.index} 서술 시점`} value={draft.mode} onChange={event => setDrafts({ ...drafts, [scene.identity]: { mode: event.target.value as NarrationMode, narratorCharacterId: null } })}>{Object.entries(narrationLabels).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}</select></label>
        {draft.mode === 'FIRST_PERSON_CHARACTER' && <label>서술자 <select aria-label={`Scene ${scene.index} 서술자`} value={draft.narratorCharacterId ?? ''} onChange={event => setDrafts({ ...drafts, [scene.identity]: { ...draft, narratorCharacterId: event.target.value || null } })}><option value="">인물을 선택해 주세요</option>{snapshot.characters.map(character => <option key={character.recordId} value={character.recordId}>{character.displayName}</option>)}</select></label>}
        {draft.mode === 'FIRST_PERSON_CHARACTER' && snapshot.characters.length === 0 && <p>현재 작품의 Canon에 인물을 먼저 등록해 주세요.</p>}
        <button type="button" disabled={draft.mode === 'FIRST_PERSON_CHARACTER' && !draft.narratorCharacterId} onClick={() => void save(scene.identity, draft)}>시점 저장</button>
      </fieldset>;
    })}
  </section>;
}
