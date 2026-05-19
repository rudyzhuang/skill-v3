export const CLIENT_TARGET_OPTIONS = [
  { value: 'admin', label: '管理端 (admin)' },
  { value: 'backend', label: '后端 (backend)' },
] as const;

export type ClientTargetValue = (typeof CLIENT_TARGET_OPTIONS)[number]['value'];
