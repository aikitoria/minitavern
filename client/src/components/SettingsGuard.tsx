import { createContext, onCleanup, useContext } from 'solid-js';
import type { JSX } from 'solid-js';

export interface SettingsSectionActions {
  isDirty: () => boolean;
  /** Returns false when validation or persistence failed. */
  save: () => Promise<boolean>;
  discard: () => void;
}

type Register = (actions: SettingsSectionActions) => () => void;
type Navigate = (action: () => void) => void;

const SettingsGuardContext = createContext<Register>();
const SettingsNavigationContext = createContext<Navigate>();

export function SettingsGuardProvider(props: {
  register: Register;
  navigate: Navigate;
  children: JSX.Element;
}) {
  return (
    <SettingsNavigationContext.Provider value={props.navigate}>
      <SettingsGuardContext.Provider value={props.register}>
        {props.children}
      </SettingsGuardContext.Provider>
    </SettingsNavigationContext.Provider>
  );
}

/** Registers the save/discard contract for the currently mounted settings page. */
export function useSettingsGuard(actions: SettingsSectionActions): void {
  const register = useContext(SettingsGuardContext);
  if (!register) return;
  const unregister = register(actions);
  onCleanup(unregister);
}

/** Runs in-page navigation through Settings' Save / Discard / Cancel prompt. */
export function useSettingsNavigation(): Navigate {
  return useContext(SettingsNavigationContext) ?? ((action) => action());
}
