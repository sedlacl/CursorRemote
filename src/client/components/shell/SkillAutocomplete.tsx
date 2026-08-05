import React, { useEffect, useRef, useState } from 'react';
import type { SkillOption } from '../../../server/types.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';
import { commandResultData } from '../../utils/commandResult.js';
import { filterSkillsByQuery } from '../../utils/skillSlashQuery.js';

export interface SkillAutocompleteProps {
  visible: boolean;
  query: string;
  onSelect: (skill: SkillOption) => void;
  onDismiss: () => void;
}

export function SkillAutocomplete({ visible, query, onSelect, onDismiss }: SkillAutocompleteProps) {
  const command = useCommandClient();
  const ui = useUiState();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [options, setOptions] = useState<SkillOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    void command.sendCommandAwaitResult('command:get_skill_options').then(result => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setLoadError(true);
        ui.showToast(result.error || 'Failed to load skills', 'error');
        return;
      }
      const data = commandResultData<{ options?: SkillOption[] }>(result);
      setOptions(Array.isArray(data?.options) ? data.options : []);
    });
    return () => {
      cancelled = true;
    };
  }, [command, ui, visible]);

  useEffect(() => {
    if (!visible) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      const inputBar = document.getElementById('input-bar');
      if (inputBar?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onDismiss, visible]);

  if (!visible) return null;

  const filtered = filterSkillsByQuery(options, query);

  return (
    <div
      id="skill-autocomplete"
      ref={rootRef}
      className="skill-autocomplete"
      role="listbox"
      aria-label="Skills"
    >
      <div className="skill-autocomplete-header">Skills</div>
      <div id="skill-autocomplete-list" className="skill-autocomplete-list">
        {loading && <div className="skill-autocomplete-empty">Loading…</div>}
        {!loading && loadError && (
          <div className="skill-autocomplete-empty">Could not load skills</div>
        )}
        {!loading && !loadError && filtered.length === 0 && (
          <div className="skill-autocomplete-empty">No skills found</div>
        )}
        {!loading && filtered.map(skill => (
          <button
            key={`${skill.source}:${skill.id}`}
            type="button"
            role="option"
            className="skill-autocomplete-item"
            onMouseDown={event => event.preventDefault()}
            onClick={() => onSelect(skill)}
          >
            <span className="sheet-item-icon">/</span>
            <span className="sheet-item-skill-main">
              <span className="sheet-item-skill-name">{skill.name}</span>
              {skill.description && (
                <span className="sheet-item-skill-desc">{skill.description}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
