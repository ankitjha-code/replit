import { useId } from 'react';
import { Field } from '../../components/Field.js';
import { Button } from '../../ui/Button/Button.js';
import { Dialog } from '../../ui/Dialog/Dialog.js';
import { Switch } from '../../ui/Switch/Switch.js';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  resetEditorSettings,
  updateEditorSettings,
  useEditorSettings,
} from './editor-settings.js';

export interface EditorSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const FONT_SIZES = Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, index) => {
  const size = String(FONT_SIZE_MIN + index);
  return { value: size, label: `${size} px` };
});

const TAB_SIZES = [2, 4, 8].map((size) => ({
  value: String(size),
  label: `${String(size)} spaces`,
}));

export function EditorSettingsDialog({
  open,
  onOpenChange,
}: EditorSettingsDialogProps): React.JSX.Element {
  const settings = useEditorSettings();
  const id = useId();

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Editor settings"
      description="Applies to you, in this browser. Changes take effect as you make them."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => resetEditorSettings()}>
            Reset to defaults
          </Button>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </>
      }
    >
      <div className="editor-settings">
        <Field
          id={`${id}-font-size`}
          label="Font size"
          as="select"
          options={FONT_SIZES}
          value={String(settings.fontSize)}
          onChange={(event) => updateEditorSettings({ fontSize: Number(event.target.value) })}
        />
        <Field
          id={`${id}-tab-size`}
          label="Tab size"
          as="select"
          options={TAB_SIZES}
          value={String(settings.tabSize)}
          onChange={(event) =>
            updateEditorSettings({ tabSize: Number(event.target.value) as 2 | 4 | 8 })
          }
        />
        <Switch
          label="Word wrap"
          description="Long lines wrap instead of scrolling sideways."
          checked={settings.wordWrap}
          onCheckedChange={(checked) => {
            updateEditorSettings({ wordWrap: checked });
          }}
        />
        <Switch
          label="Font ligatures"
          description="Joins sequences such as => and !== into one glyph."
          checked={settings.ligatures}
          onCheckedChange={(checked) => {
            updateEditorSettings({ ligatures: checked });
          }}
        />
        <Switch
          label="Minimap"
          description="An overview of the file beside the scrollbar. Hidden on narrow screens."
          checked={settings.minimap}
          onCheckedChange={(checked) => {
            updateEditorSettings({ minimap: checked });
          }}
        />
      </div>
    </Dialog>
  );
}
