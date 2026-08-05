import React, { useMemo } from 'react';
import type {
  ChatElement,
  PlanBlock,
  RunAction,
} from '../../../server/types.js';
import { useCommandClient } from '../../state/commandClient.js';
import { useUiState } from '../../state/uiState.js';
import { commandResultData } from '../../utils/commandResult.js';
import { plainTextToHtml, sanitizeHtml } from '../../utils/sanitizeHtml.js';
import { buildAssistantContentSegments } from '../../utils/assistantContent.js';
import { NativeCodeBlock } from './codeBlocks.js';
import { AssistantMessageContent } from './assistantContent.js';

export function messageRenderKey(msg: ChatElement): string {
  try {
    return JSON.stringify(msg);
  } catch {
    return msg.id;
  }
}

export function MessageList({ messages }: { messages: ChatElement[] }) {
  return (
    <>
      {messages.map((message, index) => (
        <MessageRenderer
          key={message.id}
          message={message}
          showRoleLabel={
            message.type === 'human'
            || (message.type === 'assistant' && messages[index - 1]?.type !== 'assistant')
          }
        />
      ))}
    </>
  );
}

export const MessageRenderer = React.memo(function MessageRenderer({
  message,
  showRoleLabel = true,
}: {
  message: ChatElement;
  showRoleLabel?: boolean;
}) {
  switch (message.type) {
    case 'human':
      return <HumanMessage message={message} showRoleLabel={showRoleLabel} />;
    case 'assistant':
      return <AssistantMessage message={message} showRoleLabel={showRoleLabel} />;
    case 'tool':
      return <ToolMessage message={message} />;
    case 'thought':
      return <ThoughtMessage message={message} />;
    case 'plan':
      return <PlanMessage message={message} />;
    case 'todo_list':
      return <TodoListMessage message={message} />;
    case 'run_command':
      return <RunCommandMessage message={message} />;
    case 'loading':
      return <LoadingMessage message={message} />;
    default:
      return null;
  }
}, (prev, next) => (
  prev.showRoleLabel === next.showRoleLabel
  && messageRenderKey(prev.message) === messageRenderKey(next.message)
));

export function HumanMessage({
  message,
  showRoleLabel = true,
}: {
  message: Extract<ChatElement, { type: 'human' }>;
  showRoleLabel?: boolean;
}) {
  const imageCount = message.imageCount ?? 0;
  return (
    <div className="chat-el el-human" data-id={message.id} data-msg-type={message.type}>
      {showRoleLabel && <div className="message-role-label">You</div>}
      <div className="human-bubble">
        {message.quoted?.text && (
          <div className="quoted-widget">
            <div className="quoted-label">Quoted</div>
            <div className="quoted-text">{message.quoted.text}</div>
          </div>
        )}
        {!!message.mentions?.length && (
          <div className="mentions-row">
            {message.mentions.map((mention, idx) => (
              <span
                key={`${mention.name}:${idx}`}
                className={`mention-badge${mention.mentionType === 'cursor_skill' ? ' mention-badge-skill' : ''}`}
              >
                {mention.mentionType === 'cursor_skill' && !mention.name.startsWith('/') ? `/${mention.name}` : mention.name}
              </span>
            ))}
          </div>
        )}
        {imageCount > 0 && (
          <div className="human-image-indicator" aria-label={`${imageCount} image${imageCount === 1 ? '' : 's'} attached`}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <circle cx="8.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
              <path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.12 0L3 18" />
            </svg>
            <span>{imageCount === 1 ? '1 image' : `${imageCount} images`}</span>
          </div>
        )}
        <div className="human-text">{message.text}</div>
      </div>
    </div>
  );
}

export function AssistantMessage({
  message,
  showRoleLabel = true,
}: {
  message: Extract<ChatElement, { type: 'assistant' }>;
  showRoleLabel?: boolean;
}) {
  const html = message.html || plainTextToHtml(message.text || '');
  const segments = useMemo(
    () => buildAssistantContentSegments(html, message.codeBlocks || []),
    [html, message.codeBlocks],
  );
  return (
    <div className="chat-el el-assistant" data-id={message.id} data-msg-type={message.type}>
      {showRoleLabel && <div className="message-role-label">Cursor</div>}
      <div className="assistant-bubble">
        <div className="assistant-content markdown-body">
          <AssistantMessageContent segments={segments} />
        </div>
      </div>
    </div>
  );
}

export function ToolMessage({ message }: { message: Extract<ChatElement, { type: 'tool' }> }) {
  return (
    <div className={`chat-el el-tool ${message.status === 'loading' ? 'loading' : ''}`} data-id={message.id} data-msg-type={message.type}>
      <div className={`tool-line ${message.status}`}>
        <span className="tool-icon">
          {message.status === 'completed' ? '✓' : <span className="tool-spinner" aria-hidden="true" />}
        </span>
        <span className="tool-copy">
          {message.summaryText ? (
            <>
              <span className="tool-summary">{message.summaryText}</span>
              {message.details && !message.summaryText.includes(message.details) && (
                <span className="tool-details">{message.details}</span>
              )}
            </>
          ) : (
            <span className="tool-primary-line">
            {message.action && <span className="tool-action">{message.action}</span>}
            {message.details && <span className="tool-details">{message.details}</span>}
            </span>
          )}
        </span>
        {(message.filename || message.additions != null || message.deletions != null) && (
          <span className="tool-file-info">
            {message.filename && <span className="tool-filename">{message.filename}</span>}
            {message.additions != null && <span className="tool-additions">+{message.additions}</span>}
            {message.deletions != null && <span className="tool-deletions">-{message.deletions}</span>}
          </span>
        )}
      </div>
      {message.blocked && <div className="tool-blocked">{message.blocked}</div>}
      {message.diffBlock && <NativeCodeBlock item={message.diffBlock} onFullscreen={() => undefined} />}
      {!!message.actions?.length && <RunStyleActionButtons actions={message.actions} />}
    </div>
  );
}

export function ThoughtMessage({ message }: { message: Extract<ChatElement, { type: 'thought' }> }) {
  const kindClass = message.thoughtKind === 'step_summary' ? 'thought-line-summary' : 'thought-line-step';
  return (
    <div className="chat-el el-thought" data-id={message.id} data-msg-type={message.type}>
      <div className={`thought-line ${kindClass}`}>{formatThoughtLine(message)}</div>
    </div>
  );
}

export function formatThoughtLine(message: Extract<ChatElement, { type: 'thought' }>): string {
  const duration = (message.duration || '').trim();
  const detail = (message.detail || '').trim();
  if (message.thoughtKind === 'step_summary') {
    const action = (message.action || '').trim();
    if (!detail) return action || 'Steps';
    return /^(Thought|Explored|Searched|Read|Finished)$/i.test(action)
      ? `${action} ${detail}`
      : `${action || 'Steps'} — ${detail}`;
  }
  if (message.thoughtKind === 'thinking_step') {
    const action = (message.action || '').trim();
    if (duration) return `${action || 'Step'} · ${duration}`;
    if (action) {
      if (/^thought$/i.test(action)) return 'Thought';
      if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, '')}…`;
      return action;
    }
    return 'Thinking…';
  }
  if (duration) return `Thought for ${duration}`;
  const action = (message.action || '').trim();
  if (action) {
    if (/^thought$/i.test(action)) return 'Thought';
    if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, '')}…`;
    return action;
  }
  return 'Thinking…';
}

export function PlanMessage({ message }: { message: PlanBlock }) {
  const command = useCommandClient();
  const ui = useUiState();
  const openPlan = async () => {
    ui.openPlanModal(message);
    const result = await command.sendCommandAwaitResult('command:get_plan_full', { planLabel: message.label });
    if (result.ok) {
      const data = commandResultData<{ bodyHtml?: string; body?: string }>(result);
      ui.setPlanModalBody(data?.bodyHtml || plainTextToHtml(data?.body || ''));
    } else {
      ui.showToast(result.error || 'Failed to open plan', 'error');
    }
  };
  return (
    <div className="chat-el el-plan" data-id={message.id} data-msg-type={message.type}>
      <div className="plan-card">
        <div className="plan-card-header">
          <span className="plan-card-label">{message.label}</span>
          <span className="plan-card-progress">{message.todosCompleted}/{message.todosTotal}</span>
        </div>
        <div className="plan-card-title">{message.title}</div>
        {message.descriptionHtml
          ? <div className="plan-card-desc" dangerouslySetInnerHTML={{ __html: sanitizeHtml(message.descriptionHtml) }} />
          : message.description && <div className="plan-card-desc">{message.description}</div>}
        <TodoRows todos={message.todos || []} moreCount={message.todosMoreCount} />
        {message.model && (
          <button
            type="button"
            className="plan-card-model"
            disabled={!message.modelDropdownSelectorPath}
            onClick={() => message.modelDropdownSelectorPath ? ui.openPlanModelSheet(message) : undefined}
          >
            {message.model}
          </button>
        )}
        <div className="plan-card-actions">
          <button type="button" className="run-btn" onClick={() => void openPlan()}>View plan</button>
          {message.actions?.map(action => (
            <button
              key={`${action.type}:${action.selectorPath}`}
              type="button"
              className="run-btn"
              onClick={() => command.emit('command:click_action', { selectorPath: action.selectorPath })}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function TodoListMessage({ message }: { message: Extract<ChatElement, { type: 'todo_list' }> }) {
  return (
    <div className="chat-el el-todo-list" data-id={message.id} data-msg-type={message.type}>
      <div className="todo-card">
        <div className="todo-card-title">{message.title}</div>
        <div className="todo-card-progress">{message.todosCompleted}/{message.todosTotal}</div>
        <TodoRows todos={message.todos || []} />
      </div>
    </div>
  );
}

export function TodoRows({ todos, moreCount }: { todos: { text: string; status: string }[]; moreCount?: number }) {
  return (
    <div className="todo-rows">
      {todos.map((todo, index) => (
        <div key={`${todo.text}:${index}`} className={`todo-row todo-row-${todo.status}`}>
          <span className="todo-status">{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '-' : ''}</span>
          <span className="todo-text">{todo.text}</span>
        </div>
      ))}
      {!!moreCount && <div className="todo-row todo-row-more">{moreCount} more</div>}
    </div>
  );
}

export function RunCommandMessage({ message }: { message: Extract<ChatElement, { type: 'run_command' }> }) {
  return (
    <div className="chat-el el-run-command" data-id={message.id} data-msg-type={message.type}>
      <div className="run-card">
        <div className="run-card-title">{message.description || 'Run command'}</div>
        {message.candidates && <div className="run-card-candidates">{message.candidates}</div>}
        <pre className="run-command-text">{message.command}</pre>
        <RunStyleActionButtons actions={message.actions || []} />
      </div>
    </div>
  );
}

export function RunStyleActionButtons({ actions }: { actions: RunAction[] }) {
  const command = useCommandClient();
  if (!actions.length) return null;
  return (
    <div className="tool-actions-row">
      {actions.map(action => (
        <button
          key={`${action.type}:${action.selectorPath}`}
          type="button"
          className={`run-btn run-btn-${action.type}`}
          onClick={() => command.emit('command:click_action', { selectorPath: action.selectorPath })}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

export function LoadingMessage({ message }: { message: Extract<ChatElement, { type: 'loading' }> }) {
  return (
    <div className="chat-el el-loading" data-id={message.id} data-msg-type={message.type}>
      <div className="loading-line">{message.text || 'Loading...'}</div>
    </div>
  );
}
