import { useCallback, useEffect, useState } from 'react';
import type { ServerIdentity } from '../../shared/diagnostics.js';
import type { GitStatusInfo } from '../../shared/extension-bridge.js';
import { getAuthToken } from './socketClient.js';

export interface HealthSnapshot {
  server?: ServerIdentity;
  gitStatus?: GitStatusInfo | null;
  connected?: boolean;
  cdpUrl?: string;
  cdpDisconnectReason?: string | null;
  cdpLastError?: string | null;
  generation?: number;
  uptime?: number;
}

export async function fetchDebugInfo(): Promise<unknown> {
  const token = getAuthToken();
  const res = await fetch('/debug/info', {
    credentials: 'same-origin',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`Debug info failed (${res.status})`);
  }
  return res.json();
}

export function useServerHealth(enabled: boolean): HealthSnapshot | null {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const token = getAuthToken();
      const res = await fetch('/health', {
        credentials: 'same-origin',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json() as HealthSnapshot;
      setHealth(data);
    } catch {
      // ignore transient network errors
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);

  return health;
}
