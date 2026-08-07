export const MODE_OPTIONS = [
  { id: 'agent', label: 'Agent' },
  { id: 'plan', label: 'Plan' },
  { id: 'debug', label: 'Debug' },
  { id: 'multitask', label: 'Multitask' },
  { id: 'chat', label: 'Ask' },
] as const;

export function modeUi(modeId: string | undefined) {
  return MODE_OPTIONS.find(mode => mode.id === modeId) || {
    id: modeId || 'agent',
    label: modeId || 'Agent',
  };
}
