import { createContext, onCleanup, useContext } from 'solid-js';
import type { JSX } from 'solid-js';

export interface SettingsSectionActions {
  isDirty: () => boolean;
  /** Returns false when validation or persistence failed. */
  save: () => Promise<boolean>;
  discard: () => void;
}

type Register = (actions: SettingsSectionActions) => () => void;

const SettingsGuardContext = createContext<Register>();

export function SettingsGuardProvider(props: { register: Register; children: JSX.Element }) {
  return (
    <SettingsGuardContext.Provider value={props.register}>
      {props.children}
    </SettingsGuardContext.Provider>
  );
}

/** Registers the save/discard contract for the currently mounted settings page. */
export function useSettingsGuard(actions: SettingsSectionActions): void {
  const register = useContext(SettingsGuardContext);
  if (!register) return;
  const unregister = register(actions);
  onCleanup(unregister);
}
