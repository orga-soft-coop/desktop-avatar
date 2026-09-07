import { useId, useState } from "react";
import { BUNDLED_AVATARS, type AvatarPreference } from "../lib/bundled-avatars";
import { t, type LocaleId } from "../lib/i18n";
import { SIZE_PRESET_OPTIONS, type SizePreset } from "../lib/window-presets";

interface CompanionSettingsProps {
  locale: LocaleId;
  supportedLocales: LocaleId[];
  onSelectLocale?: (locale: LocaleId) => void;
  ttsVoices?: string[];
  selectedTtsVoice?: string | null;
  onSelectTtsVoice?: (voice: string | null) => void;
  sizePreset: SizePreset;
  onSelectSizePreset: (preset: SizePreset) => void;
  avatarPreference?: AvatarPreference;
  onSelectAvatar?: (avatar: AvatarPreference) => void;
}

export function CompanionSettings(props: CompanionSettingsProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="companion-settings">
    <button type="button" className="chat-panel__devtools-toggle" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen((current) => !current)}>{t("settings.title")}</button>
    {open && <div id={id} className="companion-settings__body">
      {props.onSelectLocale && <label>{t("devTools.language")}
        <select value={props.locale} onChange={(event) => props.onSelectLocale?.(event.target.value as LocaleId)}>
          {props.supportedLocales.map((locale) => <option key={locale} value={locale}>
            {t(locale === "de" ? "devTools.languageGerman" : "devTools.languageEnglish")}
          </option>)}
        </select>
      </label>}
      {props.onSelectTtsVoice && <label>{t("devTools.voice")}
        <select value={props.selectedTtsVoice ?? ""} onChange={(event) => props.onSelectTtsVoice?.(event.target.value || null)}>
          <option value="">{t("devTools.systemDefault")}</option>
          {props.ttsVoices?.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
        </select>
      </label>}
      <label>{t("settings.size")}
        <select value={props.sizePreset} onChange={(event) => props.onSelectSizePreset(event.target.value as SizePreset)}>
          {SIZE_PRESET_OPTIONS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </label>
      {props.onSelectAvatar && <fieldset className="companion-settings__avatars">
        <legend>{t("settings.avatar")}</legend>
        <div className="companion-settings__avatar-grid">
          {BUNDLED_AVATARS.map((avatar) => <label key={avatar.id}>
            <img src={avatar.preview} alt="" width="90" height="100" loading="lazy" />
            <span><input type="radio" name={`${id}-avatar`} value={avatar.id} checked={props.avatarPreference === avatar.id}
              onChange={() => props.onSelectAvatar?.(avatar.id)} />{avatar.label}</span>
          </label>)}
        </div>
        <p>{t("settings.deviceOnly")}</p>
      </fieldset>}
    </div>}
  </section>;
}
