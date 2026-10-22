/*
 * The Environment half of the run strip (design spec 9.2), under the name the
 * spec gives it. The implementation stays in `RuntimeControls.tsx`: that is
 * the file the behaviour tests have always targeted, and the toolbar only
 * needs the name that says what the control is for.
 */
export {
  RuntimeControls as EnvironmentControl,
  CHOOSE_LANGUAGE_TITLE,
  LOAD_ERROR_TITLE,
  STILL_STARTING_MESSAGE,
  detail,
  disabledReason,
  statusLabel,
} from '../RuntimeControls.js';
export type { RuntimeControlsProps as EnvironmentControlProps } from '../RuntimeControls.js';
