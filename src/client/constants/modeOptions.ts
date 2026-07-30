export const MODE_OPTIONS = [
  { id: 'agent', label: 'Agent', icon: '∞' },
  { id: 'plan', label: 'Plan', icon: '☑' },
  { id: 'debug', label: 'Debug', icon: '🐛' },
  { id: 'multitask', label: 'Multitask', icon: '◫' },
  { id: 'chat', label: 'Ask', icon: '💬' },
] as const;

export function modeUi(modeId: string | undefined) {
  return MODE_OPTIONS.find(mode => mode.id === modeId) || {
    id: modeId || 'agent',
    label: modeId || 'Agent',
    icon: '',
  };
}
