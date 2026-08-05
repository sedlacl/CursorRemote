import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActiveConversationContext, CursorState, SkillOption } from '../../../server/types.js';
import { modeUi } from '../../constants/modeOptions.js';
import { useTextareaAutosize } from '../../hooks/useTextareaAutosize.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';
import {
  getBackgroundTaskCount,
  getVisibleBackgroundTasks,
  getVisibleGitStatus,
} from '../../view-models/backgroundTasks.js';
import { newCommandId } from '../../utils/commandIds.js';
import { applySkillSlashToken, parseSkillSlashQuery } from '../../utils/skillSlashQuery.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  type BooleanStateSetter,
  type PendingAttachment,
} from '../../types/ui.js';
import { SkillAutocomplete } from './SkillAutocomplete.js';

function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div id="attachment-strip" className={`attachment-strip ${attachments.length ? '' : 'hidden'}`} aria-live="polite">
      {attachments.map(att => (
        <div key={att.id} className="attachment-chip" data-id={att.id}>
          <img src={att.previewUrl} alt={att.name || 'Attachment'} />
          <button type="button" className="attachment-remove" aria-label="Remove attachment" onClick={() => onRemove(att.id)}>x</button>
        </div>
      ))}
    </div>
  );
}

export interface ComposerInputProps {
  state: CursorState;
  setSendPending: BooleanStateSetter;
}

function composerPlaceholder(modeId: string): string {
  switch (modeId) {
    case 'plan':
      return 'Describe a plan, / for skills, @ for context';
    case 'debug':
      return 'Describe an issue, / for skills, @ for context';
    case 'multitask':
      return 'Delegate work, / for skills, @ for context';
    case 'chat':
      return 'Ask a question, / for skills, @ for context';
    default:
      return 'Plan, build, / for skills, @ for context';
  }
}

function shouldShowReturnToParent(context: ActiveConversationContext | null | undefined): context is ActiveConversationContext {
  return !!context
    && context.kind === 'subagent'
    && context.returnToParentAvailable
    && !context.composerInputAvailable;
}

export function ComposerInput({ state, setSendPending }: ComposerInputProps) {
  const command = useCommandClient();
  const ui = useUiState();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const autosize = useTextareaAutosize(inputRef);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [returnPending, setReturnPending] = useState(false);
  const [skillPickerDismissed, setSkillPickerDismissed] = useState(false);
  const [skillPickerForced, setSkillPickerForced] = useState(false);
  const conversationContext = state.activeConversationContext;
  const showReturnToParent = shouldShowReturnToParent(conversationContext);
  const inputDisabled = !state.inputAvailable;
  const canSend = !inputDisabled && (text.trim().length > 0 || attachments.length > 0);
  const currentMode = modeUi(state.mode?.current);
  const backgroundTasks = getVisibleBackgroundTasks(state);
  const backgroundTaskCount = getBackgroundTaskCount(backgroundTasks);
  const gitStatus = getVisibleGitStatus(state);
  const slashQuery = useMemo(() => parseSkillSlashQuery(text), [text]);
  const skillPickerOpen = !inputDisabled && !skillPickerDismissed && (!!slashQuery || skillPickerForced);
  const skillFilterQuery = slashQuery?.query ?? '';

  const clearAttachments = useCallback(() => {
    setAttachments([]);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const addImageFile = useCallback((file: File) => {
    if (!String(file.type || '').startsWith('image/')) {
      ui.showToast('Only images are supported', 'error');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      ui.showToast('Image is too large (max 5 MB)', 'error');
      return;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      ui.showToast('Maximum 5 attachments', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        ui.showToast('Failed to read image', 'error');
        return;
      }
      setAttachments(items => [...items, {
        id: newCommandId(),
        mimeType: file.type,
        name: file.name || 'image',
        data: dataUrl.slice(comma + 1),
        previewUrl: dataUrl,
      }]);
    };
    reader.onerror = () => ui.showToast('Failed to read image', 'error');
    reader.readAsDataURL(file);
  }, [attachments.length, ui]);

  const sendMessage = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    setSendPending(true);
    const result = await command.sendCommandAwaitResult('command:send_message', {
      ...(trimmed ? { text: trimmed } : {}),
      ...(attachments.length ? {
        attachments: attachments.map(att => ({ mimeType: att.mimeType, name: att.name, data: att.data })),
      } : {}),
    });
    if (!result.ok) {
      setSendPending(false);
      ui.showToast(result.error || 'Failed to send message', 'error');
      return;
    }
    setText('');
    clearAttachments();
    requestAnimationFrame(() => autosize({ allowShrink: true }));
    ui.showToast('Message sent', 'success');
  }, [attachments, autosize, clearAttachments, command, setSendPending, text, ui]);

  const returnToParent = useCallback(async () => {
    if (!conversationContext?.parentComposerId) return;
    setReturnPending(true);
    try {
      const result = await command.sendCommandAwaitResult('command:return_to_parent', {
        composerId: conversationContext.composerId,
      });
      if (!result.ok) {
        ui.showToast(result.error || 'Nepodařilo se vrátit k rodičovské konverzaci', 'error');
      }
    } finally {
      setReturnPending(false);
    }
  }, [command, conversationContext, ui]);

  const openBackgroundTasks = useCallback(() => {
    const expandSelectorPath = backgroundTasks.find(task => task.expandSelectorPath)?.expandSelectorPath;
    if (expandSelectorPath) {
      command.emit('command:click_action', { selectorPath: expandSelectorPath });
    }
    ui.openSheet('background-tasks');
  }, [backgroundTasks, command, ui]);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items || inputDisabled) return;
    let handled = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          handled = true;
          addImageFile(file);
        }
      }
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [addImageFile, inputDisabled]);

  const openGitReview = useCallback(() => {
    if (!gitStatus) return;
    ui.openGitSheet();
  }, [gitStatus, ui]);

  const dismissSkillPicker = useCallback(() => {
    setSkillPickerDismissed(true);
    setSkillPickerForced(false);
  }, []);

  const selectSkill = useCallback((skill: SkillOption) => {
    const token = `/${skill.name} `;
    setText(prev => applySkillSlashToken(prev, token));
    setSkillPickerDismissed(true);
    setSkillPickerForced(false);
    ui.showToast(`Skill: /${skill.name}`, 'success');
    requestAnimationFrame(() => {
      autosize();
      inputRef.current?.focus();
    });
  }, [autosize, ui]);

  const openSkillPicker = useCallback(() => {
    if (inputDisabled) return;
    setSkillPickerDismissed(false);
    setSkillPickerForced(true);
    setText(prev => (parseSkillSlashQuery(prev) ? prev : (prev.trim() ? prev : '/')));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [inputDisabled]);

  useEffect(() => {
    // Re-arm only after leaving slash mode (delete `/` or type a space), not on each keystroke.
    if (!slashQuery) {
      setSkillPickerDismissed(false);
      return;
    }
    // Slash-driven mode owns the picker; drop pill force-open.
    setSkillPickerForced(false);
  }, [slashQuery]);

  if (showReturnToParent) {
    const parentTitle = conversationContext.parentTitle?.trim() || 'rodičovské konverzaci';
    const label = `← Zpět k ${parentTitle}`;
    return (
      <footer id="input-bar" className="input-bar-return-parent">
        <button
          type="button"
          className="composer-return-parent-btn"
          aria-label={`Vrátit se k rodičovské konverzaci: ${parentTitle}`}
          disabled={returnPending}
          onClick={() => void returnToParent()}
        >
          {returnPending ? 'Přepínám…' : label}
        </button>
      </footer>
    );
  }

  return (
    <footer id="input-bar">
      <SkillAutocomplete
        visible={skillPickerOpen}
        query={skillFilterQuery}
        onSelect={selectSkill}
        onDismiss={dismissSkillPicker}
      />
      <div id="mode-model-bar" className="mode-model-bar">
        <button id="pill-mode" className="pill" aria-label="Select mode" onClick={() => ui.openSheet('mode')}>
          <span id="pill-mode-icon" className="pill-icon">{currentMode.icon}</span>
          <span id="pill-mode-text">{currentMode.label}</span>
          <span className="pill-chevron">&#9662;</span>
        </button>
        <button id="pill-model" className="pill" aria-label="Select model" onClick={() => ui.openSheet('model')}>
          <span id="pill-model-text">{state.model?.current || 'Auto'}</span>
          <span className="pill-chevron">&#9662;</span>
        </button>
        <button
          id="pill-skill"
          className="pill"
          type="button"
          aria-label="Select skill"
          disabled={inputDisabled}
          onClick={openSkillPicker}
        >
          <span id="pill-skill-text">/</span>
          <span className="pill-chevron">&#9662;</span>
        </button>
        <div className="mode-model-bar-counts">
          {gitStatus && (
            <button
              id="pill-git-status"
              className={`git-status-pill${gitStatus.changedCount === 0 ? ' count-pill-idle' : ''}`}
              type="button"
              aria-label={`Git review (${gitStatus.changedCount} changed file${gitStatus.changedCount === 1 ? '' : 's'})`}
              onClick={openGitReview}
            >
              F:{gitStatus.changedCount}
            </button>
          )}
          {backgroundTaskCount > 0 && (
            <button
              id="pill-background-tasks"
              className="background-task-pill"
              type="button"
              aria-label={`${backgroundTaskCount} active background job${backgroundTaskCount === 1 ? '' : 's'}`}
              onClick={openBackgroundTasks}
            >
              Jobs:{backgroundTaskCount}
            </button>
          )}
        </div>
      </div>
      <div className="input-wrapper" onPaste={handlePaste}>
        <AttachmentStrip attachments={attachments} onRemove={id => setAttachments(items => items.filter(item => item.id !== id))} />
        <div className="input-row">
          <button
            id="btn-attach"
            className="btn btn-attach"
            type="button"
            disabled={inputDisabled}
            aria-label="Add image"
            onClick={() => fileRef.current?.click()}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
              <path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.12 0L3 18" />
            </svg>
          </button>
          <input
            id="attachment-file-input"
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="visually-hidden"
            tabIndex={-1}
            onChange={event => {
              Array.from(event.currentTarget.files || []).forEach(addImageFile);
              event.currentTarget.value = '';
            }}
          />
          <textarea
            id="message-input"
            ref={inputRef}
            placeholder={composerPlaceholder(state.mode?.current || 'agent')}
            rows={1}
            disabled={inputDisabled}
            value={text}
            onChange={event => {
              const next = event.currentTarget.value;
              setText(next);
              requestAnimationFrame(() => autosize());
            }}
            onPaste={handlePaste}
            onKeyDown={event => {
              if (event.key === 'Escape' && skillPickerOpen) {
                event.preventDefault();
                dismissSkillPicker();
                return;
              }
              if (event.key !== 'Enter') return;
              if (event.metaKey || event.ctrlKey) {
                event.preventDefault();
                void sendMessage();
                return;
              }
              if (event.shiftKey || window.matchMedia('(pointer: coarse)').matches) return;
              event.preventDefault();
              void sendMessage();
            }}
          />
          <button id="btn-send" className="btn btn-send" disabled={!canSend} aria-label="Send" onClick={() => void sendMessage()}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </footer>
  );
}
