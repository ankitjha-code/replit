import { useSyncExternalStore } from 'react';
import {
  getThemeState,
  setThemePreference,
  subscribeTheme,
  type Theme,
  type ThemePreference,
} from './theme.js';

export interface UseTheme {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

export function useTheme(): UseTheme {
  const { theme, preference } = useSyncExternalStore(subscribeTheme, getThemeState, getThemeState);
  return { theme, preference, setPreference: setThemePreference };
}
